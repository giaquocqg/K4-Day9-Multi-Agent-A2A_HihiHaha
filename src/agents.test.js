import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectOrderProductFacts, collectPaymentFacts, collectDeliveryFacts, collectCustomerFacts,
    buildResult, verifier,
    validateCustomerFinding, validateOrderFinding, validatePaymentFinding,
    validateDeliveryFinding, validatePolicyCandidate,
    validatePolicyContextCandidate, validatePolicyCoreCandidate,
} from './agents.js';
import { parseCsv } from './data.js';
import { assertUnder10B, parseParamsB } from './config.js';
import { runAgent, setChatResponderForTests } from './llm.js';

const order = (over = {}) => ({
    order_id: 'o1', customer_id: 'c1', order_status: 'delivered',
    order_delivered_carrier_date: '2018-01-05 10:00:00',
    order_delivered_customer_date: '2018-01-10 10:00:00',
    order_estimated_delivery_date: '2018-01-20 00:00:00',
    ...over,
});
const item = (over = {}) => ({
    order_id: 'o1', order_item_id: '1', product_id: 'p1', seller_id: 's1',
    shipping_limit_date: '2018-01-08 00:00:00', price: '100.00', freight_value: '15.00',
    ...over,
});
const pay = (seq, value, type = 'credit_card') =>
    ({ order_id: 'o1', payment_sequential: seq, payment_type: type, payment_value: value });

const dataset = (o, items, payments) => ({
    orders: new Map([[o.order_id, o]]),
    items: new Map(items.length ? [[o.order_id, items]] : []),
    payments: new Map(payments.length ? [[o.order_id, payments]] : []),
    customerUnique: new Map([['c1', 'u1']]),
    ordersByUnique: new Map([['u1', [o.order_id, 'o2']]]),
    productCategory: new Map([['p1', 'perfumaria'], ['p2', 'informatica']]),
});

function findings({ split = false, late = false, lateSeller = false } = {}) {
    const rawOrder = order({
        order_delivered_customer_date: late ? '2018-02-01 00:00:00' : '2018-01-10 10:00:00',
        order_delivered_carrier_date: lateSeller ? '2018-01-09 00:00:00' : '2018-01-05 10:00:00',
    });
    const items = [item()];
    const payments = split ? [pay('1', '50.00'), pay('2', '65.00', 'voucher')] : [pay('1', '115.00')];
    const ds = dataset(rawOrder, items, payments);
    const o = { ...collectOrderProductFacts(rawOrder, items, ds), isMultiItem: false, isMultiSeller: false, isMultiCategory: false };
    const p = { ...collectPaymentFacts('o1', payments), isSplitPayment: split, reconciled: true };
    const d0 = collectDeliveryFacts(rawOrder, items);
    const d = { ...d0, llmDeliveredLate: late, llmHasLateSeller: lateSeller };
    const c = { ...collectCustomerFacts(rawOrder, ds), isRepeatCustomer: true };
    return { ds, o, p, d, c };
}

test('domain tools đọc facts và tính số, không phát hành policy verdict', () => {
    const { o, p, d, c } = findings({ split: true });
    assert.equal(o.itemTotal, 100);
    assert.equal(o.freightTotal, 15);
    assert.equal(p.paymentTotal, 115);
    assert.equal(d.deliveryVarianceHours, -230);
    assert.deepEqual(c.relatedOrderIds, ['o2']);
    for (const x of [o, p, d, c]) assert.equal('primaryIssue' in x, false);
});

test('specialist validators chấp nhận finding đúng và bác classification mâu thuẫn tool', () => {
    const { o, p, d, c } = findings({ split: true });
    assert.deepEqual(validateCustomerFinding(c), []);
    assert.deepEqual(validateOrderFinding(o), []);
    assert.deepEqual(validatePaymentFinding(p, o), []);
    assert.deepEqual(validateDeliveryFinding(d), []);
    assert.match(validateOrderFinding({ ...o, isMultiItem: true }).join(), /is_multi_item/);
    assert.match(validatePaymentFinding({ ...p, reconciled: false }, o).join(), /reconciled/);
    assert.match(validateDeliveryFinding({ ...d, llmDeliveredLate: true }).join(), /delivered_late/);
});

test('Policy validator kiểm candidate của model nhưng không sinh đáp án fallback', () => {
    const { o, p, d, c } = findings({ split: true });
    const candidate = {
        primaryIssue: 'valid_split_payment',
        secondaryIssues: ['split_payment', 'repeat_customer'],
        caseStatus: 'no_action', confidence: 0.93,
        causeCode: 'MULTIPLE_PAYMENTS_RECONCILED', partyType: null, partyIds: [], refund: 0,
        actions: ['explain_valid_split_payment'], reasoning: 'Hai payment rows khớp expected total.',
    };
    assert.deepEqual(validatePolicyCandidate(candidate, o, p, d, c), []);
    assert.deepEqual(validatePolicyCoreCandidate(candidate, o, p, d), []);
    assert.deepEqual(validatePolicyContextCandidate(candidate, o, p, c, candidate.primaryIssue), []);
    const invalid = { ...candidate, primaryIssue: 'late_delivery_logistics' };
    const errors = validatePolicyCandidate(invalid, o, p, d, c);
    assert.ok(errors.length > 0);
    assert.equal(errors.some(e => e.includes('phải là "valid_split_payment"')), false);
});

test('buildResult dùng verdict do Policy LLM cung cấp', () => {
    const { ds, o, p, d, c } = findings({ split: true });
    const verdict = {
        primaryIssue: 'valid_split_payment', secondaryIssues: ['split_payment', 'repeat_customer'],
        caseStatus: 'no_action', confidence: 0.87, causeCode: 'MULTIPLE_PAYMENTS_RECONCILED',
        partyType: null, partyIds: [], refund: 0, actions: ['explain_valid_split_payment'],
        reasoning: 'Split payment hợp lệ.',
    };
    const result = buildResult('EC_001', 'o1', o, p, d, c, verdict);
    assert.equal(result.case_assessment.primary_issue, 'valid_split_payment');
    assert.equal(result.case_assessment.confidence, 0.87);
    assert.deepEqual(result.resolution_actions, ['explain_valid_split_payment']);
    assert.deepEqual(verifier(result, ds), []);
});

test('verifier là hard gate cho evidence, null contract và refund/status', () => {
    const { ds, o, p, d, c } = findings();
    const verdict = {
        primaryIssue: 'unsupported_late_claim', secondaryIssues: ['repeat_customer'],
        caseStatus: 'no_action', confidence: 0.9, causeCode: 'DELIVERY_WITHIN_ESTIMATE',
        partyType: null, partyIds: [], refund: 0, actions: ['reject_late_refund'], reasoning: 'Đúng hạn.',
    };
    const result = buildResult('EC_001', 'o1', o, p, d, c, verdict);
    result.evidence_ids.push('item:o1:99');
    result.case_assessment.case_status = 'action_required';
    const errors = verifier(result, ds).join(' | ');
    assert.match(errors, /evidence ma/);
    assert.match(errors, /refund <= 0/);
});

test('runAgent gửi JSON tool protocol và chỉ chạy tool model đã chọn', async () => {
    let executed = 0;
    let turn = 0;
    setChatResponderForTests(async body => {
        turn++;
        if (turn === 1) {
            assert.equal(body.tools, undefined);
            assert.deepEqual(body.response_format, { type: 'json_object' });
            assert.match(body.messages.at(-1).content, /TOOL_PROTOCOL/);
            assert.match(body.messages.at(-1).content, /lookup_customer/);
            return { role: 'assistant', content: '{"action":"tool","tool":"lookup_customer","arguments":{}}' };
        }
        assert.equal(body.messages.at(-1).role, 'user');
        assert.match(body.messages.at(-1).content, /TOOL_RESULT lookup_customer/);
        return { role: 'assistant', content: '{"action":"final","result":{"ok":true}}' };
    });
    try {
        const result = await runAgent({
            system: 'test', user: 'test',
            tools: [{ type: 'function', function: { name: 'lookup_customer', description: 'lookup', parameters: { type: 'object', properties: {} } } }],
            impls: { lookup_customer: () => { executed++; return { customer: 'u1' }; } },
            requiredTools: ['lookup_customer'],
        });
        assert.equal(executed, 1);
        assert.deepEqual(result.decision, { ok: true });
        assert.deepEqual(result.toolTrace.map(t => t.tool), ['lookup_customer']);
    } finally {
        setChatResponderForTests(null);
    }
});

test('CSV parser giữ dấu phẩy trong ô có nháy kép', () => {
    assert.deepEqual(parseCsv('a,b\n"x,1",2\n'), [{ a: 'x,1', b: '2' }]);
});

test('gate 10B đọc size từ model name và chặn model quá lớn', () => {
    assert.equal(parseParamsB('llama-3.1-8b-instant'), 8);
    assert.equal(assertUnder10B('llama-3.1-8b-instant'), 8);
    assert.throws(() => assertUnder10B('llama-3.1-70b-instruct'), /giới hạn 10B/);
});
