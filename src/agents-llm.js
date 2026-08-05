/**
 * LLM agents có ảnh hưởng thật lên pipeline.
 *
 * - Coordinator đọc request/scope và tạo task plan.
 * - Specialist tự chọn/call tool qua JSON action protocol, rồi phát hành finding.
 * - Policy tổng hợp specialist findings thành verdict đầy đủ.
 * - Verifier tự gọi verification tools và quyết định pass/reject.
 *
 * Code tất định chỉ làm data access, arithmetic và validation. Không có full policy solver hoặc
 * rules fallback trong production path.
 */
import { runAgent } from './llm.js';
import {
    EPS,
    collectCustomerFacts,
    collectDeliveryFacts,
    collectOrderProductFacts,
    collectPaymentFacts,
    validateCustomerFinding,
    validateDeliveryFinding,
    validateOrderFinding,
    validatePaymentFinding,
    validatePolicyCandidate,
    validatePolicyContextCandidate,
    validatePolicyCoreCandidate,
    verifyArtifact,
    verifyEvidence,
} from './agents.js';
import { MAX_POLICY_RETRIES } from './config.js';

const tool = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: {
        name, description,
        parameters: {
            type: 'object', properties,
            required, additionalProperties: false,
        },
    },
});

const JSON_ONLY = 'Chỉ trả một object JSON hợp lệ, không markdown và không văn bản ngoài JSON.';
const SPECIALIST_RETRIES = 2;
const COORDINATOR_RETRIES = 2;
const VERIFIER_RETRIES = 2;

const feedbackText = (feedback) => feedback
    ? `\nKết quả trước bị từ chối vì: ${feedback.join(' | ')}. Hãy tự kiểm tra lại tool observations và sửa finding; không được đoán.`
    : '';

async function runValidated({ maxRetries, invoke, materialize, validate }) {
    const attempts = [];
    let feedback = [];
    let finding = null;
    let toolTrace = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await invoke(feedback);
        finding = materialize(response.decision);
        toolTrace = response.toolTrace || [];
        const errors = [...(response.errors || []), ...validate(finding)];
        attempts.push({ attempt: attempt + 1, finding, errors, toolTrace });
        if (!errors.length) {
            return { ...finding, toolTrace, attempts, validationErrors: [], retries: attempt };
        }
        feedback = errors;
    }

    return {
        ...(finding || {}), toolTrace, attempts,
        validationErrors: feedback, retries: maxRetries,
    };
}

/* ─────────────────────────── Coordinator Agent ───────────────────────── */

const COORDINATOR_AGENTS = ['customer', 'order_product', 'delivery', 'payment'];

function coordinatorPlan(decision) {
    return {
        tasks: Array.isArray(decision?.tasks) ? decision.tasks.map(t => ({
            agent: t?.agent,
            objective: typeof t?.objective === 'string' ? t.objective : '',
        })) : [],
        executionWaves: Array.isArray(decision?.execution_waves) ? decision.execution_waves : [],
        rationale: decision?.rationale || null,
    };
}

function validateCoordinatorPlan(plan) {
    const errors = [];
    const names = plan.tasks.map(t => t.agent);
    if (!COORDINATOR_AGENTS.every(name => names.includes(name)) || new Set(names).size !== 4)
        errors.push('task plan phải giao đúng một task cho mỗi specialist bắt buộc');
    if (plan.tasks.some(t => !t.objective.trim())) errors.push('mỗi specialist task phải có objective cụ thể');
    const waveOf = (name) => plan.executionWaves.findIndex(w => Array.isArray(w) && w.includes(name));
    for (const name of ['customer', 'order_product', 'delivery']) {
        if (waveOf(name) !== 0) errors.push(`${name} phải nằm ở execution wave đầu`);
    }
    if (waveOf('payment') <= waveOf('order_product'))
        errors.push('payment phải chạy sau order_product vì cần item/freight totals');
    if (!plan.rationale) errors.push('coordinator phải giải thích rationale của plan');
    return errors;
}

export async function llmCoordinatorAgent(input) {
    const request = {
        case_id: input.case_id,
        customer_request: input.customer_request,
        investigation_scope: input.investigation_scope,
        policy_version: input.policy_version,
    };
    return runValidated({
        maxRetries: COORDINATOR_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Coordinator Agent của hệ điều tra khiếu nại Olist. Đọc nội dung yêu cầu,
scope và policy version; chia việc cho đúng bốn specialist: customer, order_product, delivery,
payment. Customer, order_product, delivery độc lập và chạy wave 1. Payment phải ở wave 2 vì cần
totals của order_product. Objective của từng task phải liên hệ trực tiếp với request/scope; không
được tự kết luận policy. ${JSON_ONLY}
Schema: {"tasks":[{"agent":"customer|order_product|delivery|payment","objective":"..."}],"execution_waves":[["customer","order_product","delivery"],["payment"]],"rationale":"..."}`,
            user: `Yêu cầu cần lập kế hoạch:\n${JSON.stringify(request, null, 2)}${feedbackText(feedback)}`,
        }),
        materialize: coordinatorPlan,
        validate: validateCoordinatorPlan,
    });
}

/* ─────────────────────────── Customer Agent ──────────────────────────── */

export async function llmCustomerAgent(order, ds, objective = '') {
    const facts = collectCustomerFacts(order, ds);
    const impls = {
        lookup_customer: () => ({
            customer_id: order.customer_id,
            customer_unique_id: facts.customerUniqueId,
            related_order_ids: facts.relatedOrderIds.slice(0, 5),
            related_order_count: facts.relatedOrderIds.length,
        }),
    };

    return runValidated({
        maxRetries: SPECIALIST_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Customer Agent. Phải gọi lookup_customer trước khi kết luận.
related_order_count chỉ đếm các order KHÁC order hiện tại. Áp dụng truth table bắt buộc:
- related_order_count = 0 -> is_repeat_customer = false
- related_order_count >= 1 -> is_repeat_customer = true
Không hiểu "1" là chỉ có order hiện tại. ${JSON_ONLY}
Schema: {"is_repeat_customer":boolean,"note":"một câu nêu kết luận và evidence"}`,
            user: `Task từ Coordinator: ${objective}\nOrder: ${order.order_id}${feedbackText(feedback)}`,
            tools: [tool('lookup_customer', 'Tra customer identity và lịch sử order của cùng customer_unique_id.')],
            impls,
            requiredTools: ['lookup_customer'],
        }),
        materialize: (decision) => ({
            ...facts,
            isRepeatCustomer: decision?.is_repeat_customer,
            note: decision?.note || null,
        }),
        validate: validateCustomerFinding,
    });
}

/* ─────────────────────── Order & Product Agent ───────────────────────── */

export async function llmOrderProductAgent(order, items, ds, objective = '') {
    const facts = collectOrderProductFacts(order, items, ds);
    const impls = {
        fetch_order_status: () => ({ order_status: order.order_status }),
        fetch_items: () => ({
            item_rows: items.length,
            items: items.map(i => ({
                order_item_id: i.order_item_id,
                seller_id: i.seller_id,
                product_id: i.product_id,
                category_name: ds.productCategory.get(i.product_id) || null,
                price: Number(i.price),
                freight_value: Number(i.freight_value),
            })),
            item_total_brl: facts.itemTotal,
            freight_total_brl: facts.freightTotal,
            distinct_sellers: facts.sellerIds.length,
            distinct_categories: facts.categories.length,
        }),
    };

    return runValidated({
        maxRetries: SPECIALIST_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Order & Product Agent. Phải gọi fetch_order_status và fetch_items.
Multi-item khi item_rows>=2; multi-seller khi distinct_sellers>=2; multi-category khi
distinct_categories>=2. Không suy diễn item không có trong observation. ${JSON_ONLY}
Schema: {"is_multi_item":boolean,"is_multi_seller":boolean,"is_multi_category":boolean,"note":"một câu nêu kết luận và evidence"}`,
            user: `Task từ Coordinator: ${objective}\nOrder: ${order.order_id}${feedbackText(feedback)}`,
            tools: [
                tool('fetch_order_status', 'Đọc trạng thái order.'),
                tool('fetch_items', 'Đọc items, seller, product, category và totals đã tính.'),
            ],
            impls,
            requiredTools: ['fetch_order_status', 'fetch_items'],
        }),
        materialize: (decision) => ({
            ...facts,
            isMultiItem: decision?.is_multi_item,
            isMultiSeller: decision?.is_multi_seller,
            isMultiCategory: decision?.is_multi_category,
            note: decision?.note || null,
        }),
        validate: validateOrderFinding,
    });
}

/* ─────────────────────────── Payment Agent ───────────────────────────── */

export async function llmPaymentAgent(orderId, payments, o, objective = '') {
    const facts = collectPaymentFacts(orderId, payments);
    const expected = o.hasItems ? Number((o.itemTotal + o.freightTotal).toFixed(2)) : null;
    const difference = expected === null ? null : Number((facts.paymentTotal - expected).toFixed(2));
    const impls = {
        fetch_payments: () => ({
            payment_rows: facts.paymentRows,
            payments: payments.map(p => ({
                payment_sequential: Number(p.payment_sequential),
                payment_type: p.payment_type,
                payment_value: Number(p.payment_value),
            })),
            payment_total_brl: facts.paymentTotal,
        }),
        reconcile: () => ({
            item_total_brl: o.hasItems ? o.itemTotal : null,
            freight_total_brl: o.hasItems ? o.freightTotal : null,
            expected_total_brl: expected,
            payment_total_brl: facts.paymentTotal,
            difference_brl: difference,
            tolerance_brl: EPS,
            within_tolerance: difference === null ? null : Math.abs(difference) <= EPS,
        }),
    };

    return runValidated({
        maxRetries: SPECIALIST_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Payment Agent. Phải gọi fetch_payments và reconcile. Split payment khi
payment_rows>=2. Reconciled bằng within_tolerance; nếu expected_total_brl=null thì reconciled phải
là null, không được đổi thành false. ${JSON_ONLY}
Schema: {"is_split_payment":boolean,"reconciled":true|false|null,"note":"một câu nêu phép đối soát"}`,
            user: `Task từ Coordinator: ${objective}\nOrder: ${orderId}${feedbackText(feedback)}`,
            tools: [
                tool('fetch_payments', 'Đọc payment rows và payment total.'),
                tool('reconcile', 'Đối soát payment với item + freight trong tolerance 0.10 BRL.'),
            ],
            impls,
            requiredTools: ['fetch_payments', 'reconcile'],
        }),
        materialize: (decision) => ({
            ...facts,
            expectedTotal: expected,
            difference,
            isSplitPayment: decision?.is_split_payment,
            reconciled: decision?.reconciled,
            note: decision?.note || null,
        }),
        validate: (finding) => validatePaymentFinding(finding, o),
    });
}

/* ─────────────────────────── Delivery Agent ──────────────────────────── */

export async function llmDeliveryAgent(order, items, objective = '') {
    const facts = collectDeliveryFacts(order, items);
    const impls = {
        fetch_delivery_timestamps: () => ({
            delivered_to_customer_at: facts.deliveredAt,
            estimated_delivery_at: facts.estimatedAt,
            handed_to_carrier_at: facts.carrierHandoffAt,
            missing_fields: facts.missing,
        }),
        compute_variances: () => ({
            delivery_variance_hours: facts.deliveryVarianceHours,
            delivered_after_estimate: facts.deliveredLate,
            seller_handoff_analysis: facts.sellerHandoffs,
            late_handoff_seller_ids: facts.lateSellerIds,
        }),
    };

    return runValidated({
        maxRetries: SPECIALIST_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Delivery Agent. Phải gọi fetch_delivery_timestamps và compute_variances.
Variance dương nghĩa là trễ. has_late_seller_handoff chỉ true khi tool trả ít nhất một seller ID.
Không suy diễn khi timestamp thiếu. ${JSON_ONLY}
Schema: {"delivered_late":boolean,"has_late_seller_handoff":boolean,"note":"một câu nêu mốc thời gian và kết luận"}`,
            user: `Task từ Coordinator: ${objective}\nOrder: ${order.order_id}${feedbackText(feedback)}`,
            tools: [
                tool('fetch_delivery_timestamps', 'Đọc các timestamp giao hàng.'),
                tool('compute_variances', 'Tính delivery và seller handoff variances.'),
            ],
            impls,
            requiredTools: ['fetch_delivery_timestamps', 'compute_variances'],
        }),
        materialize: (decision) => ({
            ...facts,
            llmDeliveredLate: decision?.delivered_late,
            llmHasLateSeller: decision?.has_late_seller_handoff,
            note: decision?.note || null,
        }),
        validate: validateDeliveryFinding,
    });
}

/* ───────────────────────────── Policy Agent ──────────────────────────── */

const POLICY_SYSTEM = `Bạn là Policy Agent. Bạn phải tổng hợp findings do bốn specialist agents
phát hành; không được đọc CSV trực tiếp và không được tự tạo ID hoặc số tiền.
Structured findings là nguồn sự thật bất biến: không được đổi order_status, boolean, ID hoặc totals
để làm khớp một policy branch.

Quét EC_POLICY_V2 đúng thứ tự, dừng ở luật đầu tiên thỏa:
1. canceled_order_paid: status=canceled và payment_total>0
2. unavailable_order_paid: status=unavailable và payment_total>0
3. late_delivery_seller: delivered_late=true và has_late_seller_handoff=true
4. late_delivery_logistics: delivered_late=true và has_late_seller_handoff=false
5. valid_split_payment: is_split_payment=true và reconciled=true
6. unsupported_late_claim: delivered_late=false và reconciled=true

Với branch đã chọn, dùng chính xác contract sau:
- canceled_order_paid -> cause ORDER_CANCELED_AFTER_PAYMENT; party platform;
  party_ids ["OLIST_PLATFORM"]; refund=payment_total_brl; status action_required;
  actions ["issue_full_refund","verify_refund_completion"].
- unavailable_order_paid -> cause ORDER_UNAVAILABLE_AFTER_PAYMENT; party platform;
  party_ids ["OLIST_PLATFORM"]; refund=payment_total_brl; status action_required;
  actions ["issue_full_refund","verify_refund_completion"].
- late_delivery_seller -> cause SELLER_HANDOFF_AFTER_LIMIT; party seller;
  party_ids=late_handoff_seller_ids; refund=freight_total_brl; status action_required;
  actions ["refund_freight","review_seller_handoff"].
- late_delivery_logistics -> cause CARRIER_DELIVERED_AFTER_ESTIMATE; party logistics_provider;
  party_ids ["LOGISTICS_PROVIDER"]; refund=freight_total_brl; status action_required;
  actions ["refund_freight","review_carrier_delay"].
- valid_split_payment -> cause MULTIPLE_PAYMENTS_RECONCILED; party JSON null; party_ids [];
  refund=0; status no_action; actions ["explain_valid_split_payment"].
- unsupported_late_claim -> cause DELIVERY_WITHIN_ESTIMATE; party JSON null; party_ids [];
  refund=0; status no_action; actions ["reject_late_refund"].

Lượt này chỉ tạo core verdict. Không tạo secondary_issues hoặc resolution_actions;
một Policy Context LLM riêng sẽ tạo hai field đó sau khi core pass. Confidence là độ tin cậy
dựa trên specialist findings, phải trong [0,1] và không được mặc định luôn bằng 1.

${JSON_ONLY}
Schema: {"primary_issue":string,"case_status":"action_required|no_action","confidence":number,"cause_code":string,"responsible_party_type":"platform|seller|logistics_provider|null","responsible_party_ids":string[],"recommended_refund_brl":number,"reasoning":"một câu chỉ rõ findings và luật"}`;

function materializePolicyCore(decision) {
    return {
        primaryIssue: decision?.primary_issue,
        caseStatus: decision?.case_status,
        confidence: decision?.confidence,
        causeCode: decision?.cause_code,
        partyType: decision?.responsible_party_type === 'null'
            ? null : (decision?.responsible_party_type ?? null),
        partyIds: Array.isArray(decision?.responsible_party_ids) ? decision.responsible_party_ids : [],
        refund: decision?.recommended_refund_brl,
        reasoning: decision?.reasoning || null,
    };
}

export async function llmPolicyAgent(o, p, d, c) {
    const findings = {
        order_product: {
            order_status: o.orderStatus,
            has_items: o.hasItems,
            item_total_brl: o.itemTotal,
            freight_total_brl: o.freightTotal,
            seller_ids: o.sellerIds,
            is_multi_item: o.isMultiItem,
            is_multi_seller: o.isMultiSeller,
            is_multi_category: o.isMultiCategory,
            note: o.note,
        },
        customer: {
            is_repeat_customer: c.isRepeatCustomer,
            related_order_count: c.relatedOrderIds.length,
            note: c.note,
        },
        payment: {
            payment_total_brl: p.paymentTotal,
            payment_rows: p.paymentRows,
            is_split_payment: p.isSplitPayment,
            reconciled: p.reconciled,
            note: p.note,
        },
        delivery: {
            delivered_late: d.llmDeliveredLate,
            has_late_seller_handoff: d.llmHasLateSeller,
            late_handoff_seller_ids: d.lateSellerIds,
            note: d.note,
        },
    };

    const core = await runValidated({
        maxRetries: MAX_POLICY_RETRIES,
        invoke: (feedback) => runAgent({
            system: POLICY_SYSTEM,
            user: `Structured specialist handoffs:\n${JSON.stringify(findings, null, 2)}${feedbackText(feedback)}`,
        }),
        materialize: materializePolicyCore,
        validate: (finding) => validatePolicyCoreCandidate(finding, o, p, d),
    });
    if (core.validationErrors.length) return core;

    const contextInput = {
        selected_primary_issue: core.primaryIssue,
        secondary_boolean_checklist: [
            { position: 1, finding: 'is_multi_item', value: o.isMultiItem, emit_if_true: 'multi_item_order' },
            { position: 2, finding: 'is_multi_seller', value: o.isMultiSeller, emit_if_true: 'multi_seller_order' },
            { position: 3, finding: 'is_split_payment', value: p.isSplitPayment, emit_if_true: 'split_payment' },
            { position: 4, finding: 'is_repeat_customer', value: c.isRepeatCustomer, emit_if_true: 'repeat_customer' },
            { position: 5, finding: 'is_multi_category', value: o.isMultiCategory, emit_if_true: 'multiple_categories' },
        ],
    };
    const context = await runValidated({
        maxRetries: MAX_POLICY_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Policy Context Agent. Core Policy LLM đã chọn primary issue; bạn không
được thay đổi nó. Quét đủ secondary_boolean_checklist theo position: value=true thì
phải emit nhãn, false thì không emit.

Dựng actions đúng thứ tự:
- canceled_order_paid hoặc unavailable_order_paid: issue_full_refund, verify_refund_completion
- late_delivery_seller: refund_freight, review_seller_handoff
- late_delivery_logistics: refund_freight, review_carrier_delay
- valid_split_payment: explain_valid_split_payment
- unsupported_late_claim: reject_late_refund
Sau đó thêm coordinate_multi_seller_case nếu secondary có multi_seller_order; thêm
verify_payment_allocation nếu secondary có split_payment và primary không phải valid_split_payment.
${JSON_ONLY}
Schema: {"secondary_issues":string[],"resolution_actions":string[],"reasoning":"một câu xác nhận checklist"}`,
            user: `Policy context input:\n${JSON.stringify(contextInput, null, 2)}${feedbackText(feedback)}`,
        }),
        materialize: (decision) => ({
            secondaryIssues: Array.isArray(decision?.secondary_issues) ? decision.secondary_issues : [],
            actions: Array.isArray(decision?.resolution_actions) ? decision.resolution_actions : [],
            reasoning: decision?.reasoning || null,
        }),
        validate: (finding) => validatePolicyContextCandidate(finding, o, p, c, core.primaryIssue),
    });

    const combined = {
        ...core,
        secondaryIssues: context.secondaryIssues || [],
        actions: context.actions || [],
        reasoning: core.reasoning,
    };
    const validationErrors = context.validationErrors.length
        ? context.validationErrors : validatePolicyCandidate(combined, o, p, d, c);
    const attempts = context.attempts.map((attempt, index) => ({
        attempt: index + 1,
        finding: { ...combined, ...attempt.finding, reasoning: core.reasoning },
        errors: attempt.errors,
        toolTrace: [],
    }));
    return {
        ...combined,
        attempts,
        toolTrace: [],
        validationErrors,
        retries: core.retries + context.retries,
    };
}

/* ──────────────────────────── Verifier Agent ─────────────────────────── */

export async function llmVerifierAgent(result, ds) {
    const evidenceErrors = verifyEvidence(result, ds);
    const artifactErrors = verifyArtifact(result, ds);
    const impls = {
        validate_evidence: () => ({ passed: evidenceErrors.length === 0, errors: evidenceErrors }),
        validate_artifact: () => ({ passed: artifactErrors.length === 0, errors: artifactErrors }),
    };

    return runValidated({
        maxRetries: VERIFIER_RETRIES,
        invoke: (feedback) => runAgent({
            system: `Bạn là Verifier Agent độc lập. Phải gọi validate_evidence và validate_artifact.
Bạn không được sửa output, tạo đáp án policy hay bỏ qua lỗi tool. Chỉ pass khi cả hai tool pass.
${JSON_ONLY}\nSchema: {"passed":boolean,"issues":string[],"note":"một câu kết luận kiểm chứng"}`,
            user: `Artifact cần kiểm:\n${JSON.stringify(result, null, 2)}${feedbackText(feedback)}`,
            tools: [
                tool('validate_evidence', 'Kiểm mọi evidence ID với CSV và policy taxonomy.'),
                tool('validate_artifact', 'Kiểm caps, null contract, confidence và refund/status.'),
            ],
            impls,
            requiredTools: ['validate_evidence', 'validate_artifact'],
        }),
        materialize: (decision) => ({
            passed: decision?.passed,
            issues: Array.isArray(decision?.issues) ? decision.issues : [],
            note: decision?.note || null,
        }),
        validate: (finding) => {
            const deterministicErrors = [...evidenceErrors, ...artifactErrors];
            const errors = [];
            if (typeof finding.passed !== 'boolean') errors.push('verifier passed phải là boolean');
            else if (finding.passed !== (deterministicErrors.length === 0))
                errors.push('verifier decision mâu thuẫn với verification tool results');
            if (!finding.passed && !finding.issues.length) errors.push('verifier reject phải nêu issues');
            if (!finding.note) errors.push('verifier phải có note');
            return errors;
        },
    });
}
