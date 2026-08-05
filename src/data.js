import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/** Minimal RFC4180 parser — Olist quotes some fields, and city names can contain commas. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    const header = (rows.shift() || []).map(h => h.replace(/^﻿/, ''));
    return rows
        .filter(r => r.length === header.length)
        .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** Gom theo order_id và giữ nguyên thứ tự dòng trong CSV như README §6 yêu cầu. */
function groupBy(rows) {
    const m = new Map();
    for (const r of rows) {
        const list = m.get(r.order_id);
        if (list) list.push(r); else m.set(r.order_id, [r]);
    }
    return m;
}

/**
 * Loads the five CSVs EC_POLICY_V2 needs.
 * geolocation / reviews / sellers are never read — no rule in V2 touches them.
 */
export function loadDataset(dataDir) {
    const read = (name) => {
        const p = join(dataDir, name);
        if (!existsSync(p)) throw new Error(`[data] Thiếu ${p}`);
        return parseCsv(readFileSync(p, 'utf8'));
    };

    // customer_id là 1-1 với order; customer_unique_id mới là con người thật.
    const customerUnique = new Map();
    for (const r of read('olist_customers_dataset.csv')) customerUnique.set(r.customer_id, r.customer_unique_id);

    const productCategory = new Map();
    for (const r of read('olist_products_dataset.csv')) productCategory.set(r.product_id, r.product_category_name);

    const orders = new Map();
    const ordersByUnique = new Map();
    for (const r of read('olist_orders_dataset.csv')) {
        orders.set(r.order_id, r);
        const uid = customerUnique.get(r.customer_id);
        if (!uid) continue;
        const list = ordersByUnique.get(uid);
        if (list) list.push(r.order_id); else ordersByUnique.set(uid, [r.order_id]);
    }

    return {
        orders,
        items: groupBy(read('olist_order_items_dataset.csv')),
        payments: groupBy(read('olist_order_payments_dataset.csv')),
        customerUnique,
        ordersByUnique,
        productCategory,
    };
}
