#!/usr/bin/env node
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inputDir = join(root, 'input');
const outputDir = join(root, 'output');
const expectedFiles = readdirSync(inputDir).filter(f => /^EC_\d{3}\.json$/.test(f)).sort();
const outputFiles = readdirSync(outputDir).filter(f => f.endsWith('.json')).sort();
const errors = [];

const PRIMARY_ISSUES = new Set([
    'canceled_order_paid', 'unavailable_order_paid', 'late_delivery_seller',
    'late_delivery_logistics', 'valid_split_payment', 'unsupported_late_claim',
]);
const SECONDARY_ISSUES = new Set([
    'multi_item_order', 'multi_seller_order', 'split_payment', 'repeat_customer',
    'multiple_categories',
]);
const CAUSES = new Set([
    'SELLER_HANDOFF_AFTER_LIMIT', 'CARRIER_DELIVERED_AFTER_ESTIMATE',
    'ORDER_CANCELED_AFTER_PAYMENT', 'ORDER_UNAVAILABLE_AFTER_PAYMENT',
    'MULTIPLE_PAYMENTS_RECONCILED', 'DELIVERY_WITHIN_ESTIMATE',
]);
const PARTY_TYPES = new Set(['platform', 'seller', 'logistics_provider']);
const ACTIONS = new Set([
    'issue_full_refund', 'refund_freight', 'explain_valid_split_payment',
    'reject_late_refund', 'review_seller_handoff', 'review_carrier_delay',
    'verify_refund_completion', 'coordinate_multi_seller_case',
    'verify_payment_allocation',
]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CASE_ID = /^EC_\d{3}$/;

function fail(file, path, message) {
    errors.push(`${file} ${path}: ${message}`);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(file, path, value, keys) {
    if (!isObject(value)) {
        fail(file, path, 'phải là object');
        return false;
    }
    const got = Object.keys(value).sort();
    const want = [...keys].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        fail(file, path, `keys=${JSON.stringify(got)}, cần=${JSON.stringify(want)}`);
    }
    return true;
}

function string(file, path, value, allowed) {
    if (typeof value !== 'string') fail(file, path, 'phải là string');
    else if (allowed && !allowed.has(value)) fail(file, path, `giá trị không hợp lệ: ${value}`);
}

function number(file, path, value, nullable = false) {
    if (nullable && value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(file, path, 'phải là number hữu hạn');
}

function boolean(file, path, value, nullable = false) {
    if (nullable && value === null) return;
    if (typeof value !== 'boolean') fail(file, path, 'phải là boolean');
}

function timestamp(file, path, value) {
    if (value !== null && (typeof value !== 'string' || !TIMESTAMP.test(value))) {
        fail(file, path, 'phải là YYYY-MM-DD HH:MM:SS hoặc null');
    }
}

function array(file, path, value, max, check) {
    if (!Array.isArray(value)) {
        fail(file, path, 'phải là array');
        return;
    }
    if (value.length > max) fail(file, path, `vượt giới hạn ${max}`);
    value.forEach((item, i) => check?.(item, `${path}[${i}]`));
}

function validate(file, out) {
    if (!object(file, '$', out, [
        'case_id', 'case_assessment', 'affected_entities', 'customer_context',
        'product_context', 'delivery_analysis', 'payment_reconciliation',
        'root_cause_analysis', 'evidence_ids', 'financial_resolution',
        'resolution_actions',
    ])) return;

    string(file, '$.case_id', out.case_id);
    if (!CASE_ID.test(out.case_id || '')) fail(file, '$.case_id', 'sai định dạng EC_NNN');
    if (`${out.case_id}.json` !== file) fail(file, '$.case_id', 'không khớp tên file');

    if (object(file, '$.case_assessment', out.case_assessment,
        ['primary_issue', 'secondary_issues', 'case_status', 'confidence'])) {
        string(file, '$.case_assessment.primary_issue', out.case_assessment.primary_issue, PRIMARY_ISSUES);
        array(file, '$.case_assessment.secondary_issues', out.case_assessment.secondary_issues, 5,
            (v, p) => string(file, p, v, SECONDARY_ISSUES));
        string(file, '$.case_assessment.case_status', out.case_assessment.case_status,
            new Set(['action_required', 'no_action']));
        number(file, '$.case_assessment.confidence', out.case_assessment.confidence);
        if (typeof out.case_assessment.confidence === 'number' &&
            (out.case_assessment.confidence < 0 || out.case_assessment.confidence > 1)) {
            fail(file, '$.case_assessment.confidence', 'phải nằm trong [0,1]');
        }
    }

    if (object(file, '$.affected_entities', out.affected_entities,
        ['order_ids', 'item_ids', 'seller_ids', 'payment_ids'])) {
        array(file, '$.affected_entities.order_ids', out.affected_entities.order_ids, 5,
            (v, p) => string(file, p, v));
        array(file, '$.affected_entities.item_ids', out.affected_entities.item_ids, 5,
            (v, p) => string(file, p, v));
        array(file, '$.affected_entities.seller_ids', out.affected_entities.seller_ids, 3,
            (v, p) => string(file, p, v));
        array(file, '$.affected_entities.payment_ids', out.affected_entities.payment_ids, 5,
            (v, p) => string(file, p, v));
    }

    if (object(file, '$.customer_context', out.customer_context,
        ['customer_unique_id', 'related_order_ids'])) {
        string(file, '$.customer_context.customer_unique_id', out.customer_context.customer_unique_id);
        array(file, '$.customer_context.related_order_ids', out.customer_context.related_order_ids, 5,
            (v, p) => string(file, p, v));
    }

    if (object(file, '$.product_context', out.product_context, ['product_ids', 'category_names'])) {
        array(file, '$.product_context.product_ids', out.product_context.product_ids, 5,
            (v, p) => string(file, p, v));
        array(file, '$.product_context.category_names', out.product_context.category_names, 5,
            (v, p) => string(file, p, v));
    }

    if (object(file, '$.delivery_analysis', out.delivery_analysis, [
        'delivered_at', 'estimated_delivery_at', 'carrier_handoff_at',
        'delivery_variance_hours', 'seller_handoff_analysis', 'late_handoff_seller_ids',
    ])) {
        timestamp(file, '$.delivery_analysis.delivered_at', out.delivery_analysis.delivered_at);
        timestamp(file, '$.delivery_analysis.estimated_delivery_at', out.delivery_analysis.estimated_delivery_at);
        timestamp(file, '$.delivery_analysis.carrier_handoff_at', out.delivery_analysis.carrier_handoff_at);
        number(file, '$.delivery_analysis.delivery_variance_hours',
            out.delivery_analysis.delivery_variance_hours, true);
        array(file, '$.delivery_analysis.seller_handoff_analysis',
            out.delivery_analysis.seller_handoff_analysis, Number.MAX_SAFE_INTEGER, (entry, path) => {
                if (!object(file, path, entry,
                    ['seller_id', 'shipping_limit_at', 'handoff_variance_hours', 'late_handoff'])) return;
                string(file, `${path}.seller_id`, entry.seller_id);
                timestamp(file, `${path}.shipping_limit_at`, entry.shipping_limit_at);
                number(file, `${path}.handoff_variance_hours`, entry.handoff_variance_hours, true);
                boolean(file, `${path}.late_handoff`, entry.late_handoff);
            });
        array(file, '$.delivery_analysis.late_handoff_seller_ids',
            out.delivery_analysis.late_handoff_seller_ids, 3, (v, p) => string(file, p, v));
    }

    if (object(file, '$.payment_reconciliation', out.payment_reconciliation, [
        'currency', 'item_total_brl', 'freight_total_brl', 'expected_total_brl',
        'payment_total_brl', 'difference_brl', 'reconciled', 'payment_types',
    ])) {
        const p = out.payment_reconciliation;
        if (p.currency !== 'BRL') fail(file, '$.payment_reconciliation.currency', 'phải là BRL');
        number(file, '$.payment_reconciliation.item_total_brl', p.item_total_brl);
        number(file, '$.payment_reconciliation.freight_total_brl', p.freight_total_brl);
        number(file, '$.payment_reconciliation.expected_total_brl', p.expected_total_brl, true);
        number(file, '$.payment_reconciliation.payment_total_brl', p.payment_total_brl);
        number(file, '$.payment_reconciliation.difference_brl', p.difference_brl, true);
        boolean(file, '$.payment_reconciliation.reconciled', p.reconciled, true);
        array(file, '$.payment_reconciliation.payment_types', p.payment_types,
            Number.MAX_SAFE_INTEGER, (v, path) => string(file, path, v));
    }

    if (object(file, '$.root_cause_analysis', out.root_cause_analysis,
        ['ranked_causes', 'responsible_parties'])) {
        array(file, '$.root_cause_analysis.ranked_causes', out.root_cause_analysis.ranked_causes, 3,
            (entry, path) => {
                if (!object(file, path, entry, ['cause_code', 'rank'])) return;
                string(file, `${path}.cause_code`, entry.cause_code, CAUSES);
                number(file, `${path}.rank`, entry.rank);
            });
        array(file, '$.root_cause_analysis.responsible_parties',
            out.root_cause_analysis.responsible_parties, 3, (entry, path) => {
                if (!object(file, path, entry, ['party_type', 'party_id'])) return;
                string(file, `${path}.party_type`, entry.party_type, PARTY_TYPES);
                string(file, `${path}.party_id`, entry.party_id);
            });
    }

    array(file, '$.evidence_ids', out.evidence_ids, 20, (v, path) => string(file, path, v));
    if (object(file, '$.financial_resolution', out.financial_resolution,
        ['currency', 'recommended_refund_brl'])) {
        if (out.financial_resolution.currency !== 'BRL') {
            fail(file, '$.financial_resolution.currency', 'phải là BRL');
        }
        number(file, '$.financial_resolution.recommended_refund_brl',
            out.financial_resolution.recommended_refund_brl);
    }
    array(file, '$.resolution_actions', out.resolution_actions, 5,
        (v, path) => string(file, path, v, ACTIONS));
}

if (JSON.stringify(outputFiles) !== JSON.stringify(expectedFiles)) {
    errors.push(`output/: cần đúng ${expectedFiles.length} JSON khớp input; hiện có ${outputFiles.length}`);
}

for (const file of outputFiles) {
    try {
        validate(file, JSON.parse(readFileSync(join(outputDir, file), 'utf8')));
    } catch (error) {
        errors.push(`${file}: JSON không đọc được: ${error.message}`);
    }
}

console.log(`${outputFiles.length} output checked, ${errors.length} schema errors`);
for (const error of errors.slice(0, 100)) console.error(`  ${error}`);
process.exitCode = errors.length ? 1 : 0;
