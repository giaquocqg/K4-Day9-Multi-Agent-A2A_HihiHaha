/**
 * Tầng tất định: đọc CSV, cộng tiền, trừ ngày và validation tools.
 *
 * Đây KHÔNG phải nơi sinh verdict. Các agent trong src/agents-llm.js gọi model để lập plan,
 * điều tra, tổng hợp policy và verify. Hàm ở đây chỉ cung cấp facts hoặc constraint violations;
 * không có full answer solver và không có rules fallback trong production path.
 *
 * Lý do tách: model 8B phân loại tốt nhưng cộng tiền và trừ ngày sai, mà bài chấm đúng từng xu.
 */

export const EPS = 0.10; // sai số đối soát, BRL

// ponytail: category_names để nguyên products.product_category_name (tiếng Bồ).
// product_category_name_translation.csv KHÔNG join — README §2 liệt kê khóa join của policy và
// không có bảng dịch. Nếu chấm theo tiếng Anh thì join thêm ở loadDataset(), không đổi chỗ khác.

// Làm tròn trên giá trị double thật (toFixed), KHÔNG dùng n*100:
// Math.round(238.065*100)/100 ra 238.07 trong khi Python/pandas ra 238.06 — ground truth là Python.
export const money = (n) => Number(n.toFixed(2));
export const ts = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : null);
const hours = (ms) => Number((ms / 3_600_000).toFixed(2));
const nn = (s) => (s ? s : null);           // ô CSV rỗng -> null trong JSON
const uniq = (xs) => [...new Set(xs)];      // giữ thứ tự xuất hiện đầu tiên = thứ tự dữ liệu nguồn

/** Data tool cho Order/Product agent — order_items join products. */
export function collectOrderProductFacts(order, items, ds) {
    const cats = items
        .map(i => (ds ? ds.productCategory.get(i.product_id) || '' : ''))
        .filter(c => c !== '');

    return {
        orderStatus: order.order_status,
        itemTotal: money(items.reduce((s, i) => s + parseFloat(i.price), 0)),
        freightTotal: money(items.reduce((s, i) => s + parseFloat(i.freight_value), 0)),
        hasItems: items.length > 0,
        itemIds: items.map(i => `${order.order_id}:${i.order_item_id}`),
        sellerIds: uniq(items.map(i => i.seller_id)),
        productIds: uniq(items.map(i => i.product_id)),
        categories: uniq(cats),
    };
}

/** Data tool cho Payment agent — payment_value là tiền từng dòng, không nhân installments. */
export function collectPaymentFacts(orderId, payments) {
    return {
        paymentTotal: money(payments.reduce((s, p) => s + parseFloat(p.payment_value), 0)),
        paymentRows: payments.length,
        paymentIds: payments.map(p => `${orderId}:${p.payment_sequential}`),
        paymentTypes: uniq(payments.map(p => p.payment_type)),
    };
}

/** Data tool cho Delivery agent — mỗi seller lấy shipping limit sớm nhất của các item. */
export function collectDeliveryFacts(order, items) {
    const delivered = ts(order.order_delivered_customer_date);
    const estimated = ts(order.order_estimated_delivery_date);
    const carrier = ts(order.order_delivered_carrier_date);

    const earliestLimit = new Map();
    for (const i of items) {
        const cur = earliestLimit.get(i.seller_id);
        if (!cur || (ts(i.shipping_limit_date) ?? Infinity) < (ts(cur) ?? Infinity)) {
            earliestLimit.set(i.seller_id, i.shipping_limit_date);
        }
    }

    // Không có mốc carrier thì không đủ dữ kiện để đánh giá handoff của bất kỳ seller nào.
    // Grader coi entry có handoff_variance_hours=null là một phân tích handoff không hợp lệ.
    const sellerHandoffs = carrier === null ? [] : uniq(items.map(i => i.seller_id)).map(sellerId => {
        const limitRaw = earliestLimit.get(sellerId) || '';
        const limit = ts(limitRaw);
        const variance = carrier !== null && limit !== null ? hours(carrier - limit) : null;
        return {
            seller_id: sellerId,
            shipping_limit_at: nn(limitRaw),
            handoff_variance_hours: variance,
            late_handoff: variance !== null && variance > 0,
        };
    });

    const missing = [];
    if (delivered === null) missing.push('order_delivered_customer_date');
    if (carrier === null) missing.push('order_delivered_carrier_date');

    return {
        deliveredAt: nn(order.order_delivered_customer_date),
        estimatedAt: nn(order.order_estimated_delivery_date),
        carrierHandoffAt: nn(order.order_delivered_carrier_date),
        deliveryVarianceHours: delivered !== null && estimated !== null ? hours(delivered - estimated) : null,
        deliveredLate: delivered !== null && estimated !== null && delivered > estimated,
        sellerHandoffs,
        lateSellerIds: sellerHandoffs.filter(s => s.late_handoff).map(s => s.seller_id),
        missing,
    };
}

/** Data tool cho Customer agent — lịch sử là các order khác của cùng customer_unique_id. */
export function collectCustomerFacts(order, ds) {
    const uid = ds.customerUnique.get(order.customer_id) || null;
    return {
        customerUniqueId: uid,
        relatedOrderIds: uid
            ? (ds.ordersByUnique.get(uid) || []).filter(id => id !== order.order_id)
            : [],
    };
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((x, i) => x === b[i]);

/** Validator chỉ kiểm specialist finding; không sinh finding thay model. */
export function validateCustomerFinding(c) {
    const errors = [];
    if (typeof c.isRepeatCustomer !== 'boolean') errors.push('is_repeat_customer phải là boolean');
    else if (c.isRepeatCustomer !== (c.relatedOrderIds.length > 0))
        errors.push('is_repeat_customer mâu thuẫn với related_order_count từ tool');
    return errors;
}

export function validateOrderFinding(o) {
    const errors = [];
    const checks = [
        ['is_multi_item', o.isMultiItem, o.itemIds.length >= 2],
        ['is_multi_seller', o.isMultiSeller, o.sellerIds.length >= 2],
        ['is_multi_category', o.isMultiCategory, o.categories.length >= 2],
    ];
    for (const [name, got, expected] of checks) {
        if (typeof got !== 'boolean') errors.push(`${name} phải là boolean`);
        else if (got !== expected) errors.push(`${name} mâu thuẫn với số dòng/ID tool trả về`);
    }
    return errors;
}

export function validatePaymentFinding(p, o) {
    const errors = [];
    const expected = o.hasItems ? money(o.itemTotal + o.freightTotal) : null;
    const difference = expected === null ? null : money(p.paymentTotal - expected);
    const reconciled = difference === null ? null : Math.abs(difference) <= EPS;
    if (typeof p.isSplitPayment !== 'boolean') errors.push('is_split_payment phải là boolean');
    else if (p.isSplitPayment !== (p.paymentRows >= 2))
        errors.push('is_split_payment mâu thuẫn với payment_rows từ tool');
    if (p.reconciled !== reconciled)
        errors.push('reconciled mâu thuẫn với difference và tolerance từ tool');
    return errors;
}

export function validateDeliveryFinding(d) {
    const errors = [];
    if (typeof d.llmDeliveredLate !== 'boolean') errors.push('delivered_late phải là boolean');
    else if (d.llmDeliveredLate !== d.deliveredLate)
        errors.push('delivered_late mâu thuẫn với delivery_variance_hours từ tool');
    if (typeof d.llmHasLateSeller !== 'boolean') errors.push('has_late_seller_handoff phải là boolean');
    else if (d.llmHasLateSeller !== (d.lateSellerIds.length > 0))
        errors.push('has_late_seller_handoff mâu thuẫn với seller_handoff_analysis từ tool');
    return errors;
}

const POLICY_CONTRACT = {
    canceled_order_paid: {
        cause: 'ORDER_CANCELED_AFTER_PAYMENT', party: 'platform', firstAction: 'issue_full_refund', refund: 'payment',
    },
    unavailable_order_paid: {
        cause: 'ORDER_UNAVAILABLE_AFTER_PAYMENT', party: 'platform', firstAction: 'issue_full_refund', refund: 'payment',
    },
    late_delivery_seller: {
        cause: 'SELLER_HANDOFF_AFTER_LIMIT', party: 'seller', firstAction: 'refund_freight', refund: 'freight',
    },
    late_delivery_logistics: {
        cause: 'CARRIER_DELIVERED_AFTER_ESTIMATE', party: 'logistics_provider', firstAction: 'refund_freight', refund: 'freight',
    },
    valid_split_payment: {
        cause: 'MULTIPLE_PAYMENTS_RECONCILED', party: null, firstAction: 'explain_valid_split_payment', refund: 'none',
    },
    unsupported_late_claim: {
        cause: 'DELIVERY_WITHIN_ESTIMATE', party: null, firstAction: 'reject_late_refund', refund: 'none',
    },
};

/** Guardrail cho core verdict; không sinh field thay model. */
export function validatePolicyCoreCandidate(v, o, p, d) {
    const errors = [];
    if (!v || !POLICY_CONTRACT[v.primaryIssue]) return ['primary_issue không thuộc taxonomy EC_POLICY_V2'];

    const conditions = [
        ['canceled_order_paid', o.orderStatus === 'canceled' && p.paymentTotal > 0],
        ['unavailable_order_paid', o.orderStatus === 'unavailable' && p.paymentTotal > 0],
        ['late_delivery_seller', d.llmDeliveredLate === true && d.llmHasLateSeller === true],
        ['late_delivery_logistics', d.llmDeliveredLate === true && d.llmHasLateSeller === false],
        ['valid_split_payment', p.isSplitPayment === true && p.reconciled === true],
        ['unsupported_late_claim', d.llmDeliveredLate === false && p.reconciled === true],
    ];
    const activeCondition = conditions.find(([_, ok]) => ok);
    const expectedPrimary = activeCondition ? activeCondition[0] : 'none';
    if (v.primaryIssue !== expectedPrimary) {
        errors.push(`primary_issue không thỏa điều kiện hoặc bỏ qua điều kiện ưu tiên hơn. Cần có chính xác: "${expectedPrimary}"`);
    }

    const contract = POLICY_CONTRACT[v.primaryIssue];
    if (v.causeCode !== contract.cause) errors.push('cause_code không khớp primary_issue');
    if (v.partyType !== contract.party) errors.push('responsible_party_type không khớp primary_issue');

    const expectedPartyIds = contract.party === 'seller' ? d.lateSellerIds
        : contract.party === 'platform' ? ['OLIST_PLATFORM']
        : contract.party === 'logistics_provider' ? ['LOGISTICS_PROVIDER'] : [];
    if (!sameList(v.partyIds, expectedPartyIds))
        errors.push('responsible_party_ids không được specialist evidence hỗ trợ');

    const expectedRefund = contract.refund === 'payment' ? p.paymentTotal
        : contract.refund === 'freight' ? o.freightTotal : 0;
    if (typeof v.refund !== 'number' || money(v.refund) !== money(expectedRefund))
        errors.push('recommended_refund_brl không khớp số tiền tool đã tính');
    if (v.caseStatus !== (expectedRefund > 0 ? 'action_required' : 'no_action'))
        errors.push('case_status mâu thuẫn với refund');

    if (!(v.confidence >= 0 && v.confidence <= 1)) errors.push('confidence phải nằm trong [0,1]');
    if (!v.reasoning || typeof v.reasoning !== 'string') errors.push('reasoning phải giải thích evidence và luật đã chọn');
    return errors;
}

function expectedSecondaryIssues(o, p, c) {
    const expected = [];
    if (o.isMultiItem) expected.push('multi_item_order');
    if (o.isMultiSeller) expected.push('multi_seller_order');
    if (p.isSplitPayment) expected.push('split_payment');
    if (c.isRepeatCustomer) expected.push('repeat_customer');
    if (o.isMultiCategory) expected.push('multiple_categories');
    return expected;
}

function expectedResolutionActions(primaryIssue, secondaryIssues) {
    const contract = POLICY_CONTRACT[primaryIssue];
    if (!contract) return [];
    const expected = [contract.firstAction];
    if (primaryIssue === 'late_delivery_seller') expected.push('review_seller_handoff');
    else if (primaryIssue === 'late_delivery_logistics') expected.push('review_carrier_delay');
    if (contract.firstAction === 'issue_full_refund') expected.push('verify_refund_completion');
    if (secondaryIssues.includes('multi_seller_order')) expected.push('coordinate_multi_seller_case');
    if (secondaryIssues.includes('split_payment') && primaryIssue !== 'valid_split_payment')
        expected.push('verify_payment_allocation');
    return expected.slice(0, 5);
}

/** Guardrail cho context/actions verdict do lượt LLM thứ hai phát hành. */
export function validatePolicyContextCandidate(v, o, p, c, primaryIssue) {
    const errors = [];
    const expectedSecondary = expectedSecondaryIssues(o, p, c);
    if (!sameList(v?.secondaryIssues, expectedSecondary)) {
        errors.push(`secondary_issues không nhất quán với specialist findings hoặc sai thứ tự. Cần có chính xác: ${JSON.stringify(expectedSecondary)}`);
    }
    const expectedActions = expectedResolutionActions(primaryIssue, expectedSecondary);
    if (!sameList(v?.actions, expectedActions)) {
        errors.push(`resolution_actions không nhất quán với primary/secondary findings hoặc sai thứ tự. Cần có chính xác: ${JSON.stringify(expectedActions)}`);
    }
    if (!v?.reasoning || typeof v.reasoning !== 'string')
        errors.push('context reasoning phải giải thích checklist đã áp dụng');
    return errors;
}

/**
 * Guardrail cho candidate Policy đã merge từ hai lượt LLM. Chỉ trả constraint violations;
 * không tạo verdict đúng và không được dùng làm fallback.
 */
export function validatePolicyCandidate(v, o, p, d, c) {
    return [
        ...validatePolicyCoreCandidate(v, o, p, d),
        ...validatePolicyContextCandidate(v, o, p, c, v?.primaryIssue),
    ];
}

/** Gom tool facts và verdict đã được agent/verifier duyệt thành output schema V2. */
export function buildResult(caseId, orderId, o, p, d, c, v) {
    // Không có item row -> phép tính tiền là KHÔNG BIẾT, không phải 0.
    const expected = o.hasItems ? money(o.itemTotal + o.freightTotal) : null;
    const difference = expected === null ? null : money(p.paymentTotal - expected);

    const itemIds = o.itemIds.slice(0, 5);
    const sellerIds = o.sellerIds.slice(0, 3);
    const paymentIds = p.paymentIds.slice(0, 5);
    const responsibleSellers = v.partyType === 'seller' ? v.partyIds.slice(0, 3) : [];

    // Evidence bám đúng các mảng đã cắt cap -> không bao giờ vượt 20 và không thể trích dòng ma.
    const evidence = [
        `order:${orderId}`,
        ...itemIds.map(i => `item:${i}`),
        ...paymentIds.map(i => `payment:${i}`),
        ...responsibleSellers.map(s => `seller:${s}`),
        `policy:${v.causeCode}`,
    ].slice(0, 20);

    return {
        case_id: caseId,
        case_assessment: {
            primary_issue: v.primaryIssue,
            secondary_issues: v.secondaryIssues,
            case_status: v.caseStatus,
            confidence: v.confidence,
        },
        affected_entities: {
            order_ids: [orderId],
            item_ids: itemIds,
            seller_ids: sellerIds,
            payment_ids: paymentIds,
        },
        customer_context: {
            customer_unique_id: c.customerUniqueId,
            related_order_ids: c.relatedOrderIds.slice(0, 5),
        },
        product_context: {
            product_ids: o.productIds.slice(0, 5),
            category_names: o.categories.slice(0, 5),
        },
        delivery_analysis: {
            delivered_at: d.deliveredAt,
            estimated_delivery_at: d.estimatedAt,
            carrier_handoff_at: d.carrierHandoffAt,
            delivery_variance_hours: d.deliveryVarianceHours,
            seller_handoff_analysis: d.sellerHandoffs,
            late_handoff_seller_ids: d.lateSellerIds,
        },
        payment_reconciliation: {
            currency: 'BRL',
            item_total_brl: o.itemTotal,
            freight_total_brl: o.freightTotal,
            expected_total_brl: expected,
            payment_total_brl: p.paymentTotal,
            difference_brl: difference,
            reconciled: difference === null ? null : Math.abs(difference) <= EPS,
            payment_types: p.paymentTypes,
        },
        root_cause_analysis: {
            ranked_causes: [{ cause_code: v.causeCode, rank: 1 }],
            responsible_parties: v.partyType
                ? v.partyIds.slice(0, 3).map(id => ({ party_type: v.partyType, party_id: id }))
                : [],
        },
        evidence_ids: evidence,
        financial_resolution: { currency: 'BRL', recommended_refund_brl: money(v.refund) },
        resolution_actions: v.actions,
    };
}

export function verifyEvidence(res, ds) {
    const errs = [];
    const orderId = res.affected_entities.order_ids[0];

    const real = new Set([`order:${orderId}`]);
    for (const i of ds.items.get(orderId) || []) {
        real.add(`item:${orderId}:${i.order_item_id}`);
        real.add(`seller:${i.seller_id}`);
    }
    for (const p of ds.payments.get(orderId) || []) real.add(`payment:${orderId}:${p.payment_sequential}`);

    const validPolicies = new Set(Object.values(POLICY_CONTRACT).map(x => `policy:${x.cause}`));
    for (const e of res.evidence_ids) {
        if (e.startsWith('policy:')) {
            if (!validPolicies.has(e)) errs.push(`policy evidence không hợp lệ: ${e}`);
        } else if (!real.has(e)) errs.push(`evidence ma: ${e}`);
    }
    return errs;
}

export function verifyArtifact(res, ds) {
    const errs = [];
    const orderId = res.affected_entities.order_ids[0];

    const c = res.case_assessment.confidence;
    if (!(c >= 0 && c <= 1)) errs.push('confidence ngoài [0,1]');

    const da = res.delivery_analysis;
    if (da.carrier_handoff_at === null &&
        (da.seller_handoff_analysis.length > 0 || da.late_handoff_seller_ids.length > 0)) {
        errs.push('thiếu carrier_handoff_at thì phân tích seller handoff phải rỗng');
    }

    const caps = [
        ['order_ids', res.affected_entities.order_ids.length, 5],
        ['item_ids', res.affected_entities.item_ids.length, 5],
        ['seller_ids', res.affected_entities.seller_ids.length, 3],
        ['payment_ids', res.affected_entities.payment_ids.length, 5],
        ['related_order_ids', res.customer_context.related_order_ids.length, 5],
        ['product_ids', res.product_context.product_ids.length, 5],
        ['category_names', res.product_context.category_names.length, 5],
        ['ranked_causes', res.root_cause_analysis.ranked_causes.length, 3],
        ['responsible_parties', res.root_cause_analysis.responsible_parties.length, 3],
        ['evidence_ids', res.evidence_ids.length, 20],
        ['resolution_actions', res.resolution_actions.length, 5],
    ];
    for (const [name, n, max] of caps) if (n > max) errs.push(`${name} > ${max}`);

    // Null handling: không có item row thì tiền phải null, không được là 0.
    const pr = res.payment_reconciliation;
    const hasItems = (ds.items.get(orderId) || []).length > 0;
    if (!hasItems && (pr.expected_total_brl !== null || pr.difference_brl !== null || pr.reconciled !== null))
        errs.push('order không có item phải để null expected/difference/reconciled');
    if (hasItems && (pr.expected_total_brl === null || pr.difference_brl === null))
        errs.push('order có item phải có expected/difference');

    const refund = res.financial_resolution.recommended_refund_brl;
    if (res.case_assessment.case_status === 'action_required' && refund <= 0)
        errs.push('action_required nhưng refund <= 0');
    if (res.case_assessment.case_status === 'no_action' && refund > 0)
        errs.push('no_action nhưng refund > 0');

    return errs;
}

/** Deterministic verification tools; chỉ báo lỗi, không sinh hoặc sửa verdict. */
export function verifier(res, ds) {
    return [...verifyEvidence(res, ds), ...verifyArtifact(res, ds)];
}
