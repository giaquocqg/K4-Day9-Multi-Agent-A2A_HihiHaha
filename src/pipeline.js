import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { buildResult, verifier } from './agents.js';
import {
    llmCoordinatorAgent, llmCustomerAgent, llmDeliveryAgent, llmOrderProductAgent,
    llmPaymentAgent, llmPolicyAgent, llmVerifierAgent,
} from './agents-llm.js';

/**
 * Coordinator LLM nhận case -> phát hành task plan -> specialist tự gọi tools -> Policy Core
 * + Policy Context LLM tổng hợp findings -> Verifier LLM tự gọi validation tools -> hard gate.
 *
 * Mỗi bước ghi một Handoff {agent, facts, evidence, missing, note, next}. `note` là câu do MODEL
 * viết ra sau khi đọc tool, không phải template — nên trace phản ánh đúng cái agent thật sự nghĩ.
 * `llm` ghi lại tool actions thực tế do model phát hành. Không có deterministic answer fallback.
 */

export async function runCase(input, ds) {
    const startedAt = new Date();
    const caseId = input.case_id;
    const orderId = input.customer_request.claimed_order_id;
    const handoffs = [];
    const push = (agent, facts, evidence, missing, note, next, llm, from = 'coordinator') =>
        handoffs.push({
            ts: new Date().toISOString(), step: handoffs.length + 1, agent, case_id: caseId,
            from, to: agent, facts, evidence, missing, note, next, ...(llm ? { llm } : {}),
        });

    const finish = (result, errors, extra = {}) => {
        const finishedAt = new Date();
        return {
            caseId, orderId, handoffs, result, errors,
            coordinatorRetries: 0, policyRetries: 0, specialistRetries: 0, verifierRetries: 0,
            startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt - startedAt, ...extra,
        };
    };

    push('coordinator', { claimed_order_id: orderId }, [], [],
        `Nhận ${caseId}, tra order ${orderId.slice(0, 8)}… trong orders.csv`,
        'customer,order_product,payment,delivery');

    const order = ds.orders.get(orderId);
    if (!order) {
        push('coordinator', {}, [], [`order:${orderId} không có trong dataset`],
            'Không tìm thấy order — dừng, không suy diễn', 'abort');
        return finish(null, ['order_not_found']);
    }

    const items = ds.items.get(orderId) || [];
    const payments = ds.payments.get(orderId) || [];

    // Coordinator là model thật: đọc message/scope và phát hành structured task plan.
    const coordinator = await llmCoordinatorAgent(input);
    push('coordinator',
        { tasks: coordinator.tasks, execution_waves: coordinator.executionWaves }, [],
        coordinator.validationErrors, coordinator.rationale,
        coordinator.validationErrors.length ? 'reject' : coordinator.executionWaves[0],
        { decided_by: 'model', attempts: coordinator.attempts.length }, 'input');
    if (coordinator.validationErrors.length) {
        return finish(null, coordinator.validationErrors.map(e => `coordinator: ${e}`), {
            coordinatorRetries: coordinator.retries,
        });
    }

    const objective = (agent) => coordinator.tasks.find(t => t.agent === agent)?.objective || '';

    // Wave 1 đúng theo dependency graph do Coordinator phát hành.
    const oPromise = llmOrderProductAgent(order, items, ds, objective('order_product'));
    const [c, o, d] = await Promise.all([
        llmCustomerAgent(order, ds, objective('customer')),
        oPromise,
        llmDeliveryAgent(order, items, objective('delivery')),
    ]);

    push('customer',
        { customer_unique_id: c.customerUniqueId, related_orders: c.relatedOrderIds.length,
          is_repeat_customer: c.isRepeatCustomer },
        [`order:${orderId}`], c.validationErrors,
        c.note, 'policy', { decided_by: 'model', tools_called: c.toolTrace.map(t => t.tool), attempts: c.attempts.length });

    push('order_product',
        { order_status: o.orderStatus, item_rows: o.itemIds.length, item_total: o.itemTotal,
          freight_total: o.freightTotal, seller_ids: o.sellerIds, categories: o.categories,
          is_multi_item: o.isMultiItem, is_multi_seller: o.isMultiSeller,
          is_multi_category: o.isMultiCategory },
        [`order:${orderId}`, ...o.itemIds.map(i => `item:${i}`)],
        o.validationErrors, o.note, 'payment,policy',
        { decided_by: 'model', tools_called: o.toolTrace.map(t => t.tool), attempts: o.attempts.length });

    push('delivery',
        { delivered_at: d.deliveredAt, estimated_at: d.estimatedAt, carrier_handoff_at: d.carrierHandoffAt,
          delivery_variance_hours: d.deliveryVarianceHours, late_seller_ids: d.lateSellerIds,
          seller_handoff_analysis: d.sellerHandoffs, delivered_late: d.llmDeliveredLate,
          has_late_seller_handoff: d.llmHasLateSeller },
        [`order:${orderId}`], [...d.missing, ...d.validationErrors],
        d.note, 'policy', { decided_by: 'model', tools_called: d.toolTrace.map(t => t.tool), attempts: d.attempts.length });

    const specialistErrors = [
        ...c.validationErrors.map(e => `customer: ${e}`),
        ...o.validationErrors.map(e => `order_product: ${e}`),
        ...d.validationErrors.map(e => `delivery: ${e}`),
    ];
    const coordinatorRetries = coordinator.retries;
    const initialSpecialistRetries = c.retries + o.retries + d.retries;
    if (specialistErrors.length) {
        return finish(null, specialistErrors, { coordinatorRetries, specialistRetries: initialSpecialistRetries });
    }

    // Wave 2: Payment dùng totals do Order/Product tool đã phát hành.
    const p = await llmPaymentAgent(orderId, payments, o, objective('payment'));
    push('payment',
        { payment_total: p.paymentTotal, payment_rows: p.paymentRows, payment_types: p.paymentTypes,
          reconciled: p.reconciled, is_split_payment: p.isSplitPayment },
        p.paymentIds.map(i => `payment:${i}`), p.validationErrors,
        p.note, 'policy', { decided_by: 'model', tools_called: p.toolTrace.map(t => t.tool), attempts: p.attempts.length });
    const specialistRetries = initialSpecialistRetries + p.retries;
    if (p.validationErrors.length) {
        return finish(null, p.validationErrors.map(e => `payment: ${e}`), { coordinatorRetries, specialistRetries });
    }

    // Policy LLM tạo toàn bộ verdict. Validator chỉ báo constraint violations, không có answer fallback.
    const v = await llmPolicyAgent(o, p, d, c);
    for (const attempt of v.attempts) {
        push('policy',
            { attempt: attempt.attempt, primary_issue: attempt.finding?.primaryIssue ?? null,
              secondary_issues: attempt.finding?.secondaryIssues ?? [],
              cause_code: attempt.finding?.causeCode ?? null,
              party_type: attempt.finding?.partyType ?? null,
              party_ids: attempt.finding?.partyIds ?? [], refund_brl: attempt.finding?.refund ?? null,
              actions: attempt.finding?.actions ?? [], confidence: attempt.finding?.confidence ?? null },
            attempt.finding?.causeCode ? [`policy:${attempt.finding.causeCode}`] : [], attempt.errors,
            attempt.finding?.reasoning || 'model không trả được verdict đọc được',
            attempt.errors.length ? 'policy_retry' : 'build_result', { decided_by: 'model' }, 'specialists');
    }
    if (v.validationErrors.length) {
        return finish(null, v.validationErrors.map(e => `policy: ${e}`), {
            coordinatorRetries, specialistRetries, policyRetries: v.retries,
        });
    }

    const result = buildResult(caseId, orderId, o, p, d, c, v);
    const deterministicErrors = verifier(result, ds);
    const verified = await llmVerifierAgent(result, ds);
    const errors = [
        ...deterministicErrors,
        ...verified.validationErrors.map(e => `verifier: ${e}`),
        ...(verified.passed ? [] : verified.issues.map(e => `verifier: ${e}`)),
    ];
    push('verifier',
        { passed: verified.passed === true && errors.length === 0,
          checked_evidence: result.evidence_ids.length, issues: verified.issues },
        result.evidence_ids, errors,
        verified.note || (errors.length ? `CHẶN: ${errors.join('; ')}` : 'Artifact hợp lệ'),
        errors.length ? 'reject' : 'write_output',
        { decided_by: 'model', tools_called: verified.toolTrace.map(t => t.tool), attempts: verified.attempts.length },
        'policy');

    return finish(errors.length ? null : result, errors, {
        coordinatorRetries, specialistRetries, policyRetries: v.retries, verifierRetries: verified.retries,
    });
}

export function loadCases(inputDir) {
    if (!existsSync(inputDir)) throw new Error(`[pipeline] Thiếu ${inputDir}`);
    return readdirSync(inputDir)
        .filter(f => /^EC_\d+\.json$/.test(f))
        .sort()
        .map(f => JSON.parse(readFileSync(join(inputDir, f), 'utf8')));
}

/** Ghi 3 artifact được chấm: output/*.json, logging/trace.jsonl, logging/metadata.json. */
export function writeArtifacts(runs, outDir, logDir, meta) {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    const failed = [];
    let written = 0;

    for (const run of runs) {
        const outputPath = join(outDir, `${run.caseId}.json`);
        if (!run.result || run.errors.length) {
            failed.push(`${run.caseId}: ${run.errors.join('; ')}`);
            // Không để artifact cũ của case failed bị nhầm là kết quả của lượt chạy mới.
            if (existsSync(outputPath)) unlinkSync(outputPath);
            continue;
        }
        writeFileSync(outputPath, JSON.stringify(run.result, null, 2));
        written++;
    }

    const now = new Date().toISOString();
    const tracePath = join(logDir, 'trace.jsonl');
    writeFileSync(tracePath,
        runs.flatMap(r => r.handoffs.map(h => JSON.stringify(h))).join('\n') + '\n');

    const metadataPath = join(logDir, 'metadata.json');
    writeFileSync(metadataPath, JSON.stringify({
        ...meta, generated_at: now,
        cases_total: runs.length, cases_written: written,
        cases_flagged: 0, cases_failed: failed.length,
        coordinator_retries: runs.reduce((s, r) => s + (r.coordinatorRetries || 0), 0),
        specialist_retries: runs.reduce((s, r) => s + (r.specialistRetries || 0), 0),
        policy_retries: runs.reduce((s, r) => s + (r.policyRetries || 0), 0),
        verifier_retries: runs.reduce((s, r) => s + (r.verifierRetries || 0), 0),
        policy_overridden_by_rules: 0,
        case_duration_ms: {
            min: Math.min(...runs.map(r => r.durationMs || 0)),
            max: Math.max(...runs.map(r => r.durationMs || 0)),
            average: Math.round(runs.reduce((sum, r) => sum + (r.durationMs || 0), 0) / runs.length),
        },
    }, null, 2));

    return { outDir, tracePath, metadataPath, written, flagged: [], failed, overridden: 0 };
}
