"""Independent re-implementation of EC_POLICY_V2 in pandas, used ONLY to audit the
TypeScript pipeline's output/. Any disagreement is a bug in one of the two."""
import json, glob, os
from datetime import datetime
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "data")

orders = pd.read_csv(f"{D}/olist_orders_dataset.csv")
items = pd.read_csv(f"{D}/olist_order_items_dataset.csv")
pays = pd.read_csv(f"{D}/olist_order_payments_dataset.csv")
custs = pd.read_csv(f"{D}/olist_customers_dataset.csv")
prods = pd.read_csv(f"{D}/olist_products_dataset.csv")

cu = dict(zip(custs.customer_id, custs.customer_unique_id))
orders["uid"] = orders.customer_id.map(cu)
by_uid = orders.groupby("uid").order_id.apply(list).to_dict()
pcat = dict(zip(prods.product_id, prods.product_category_name))

R2 = lambda x: round(x + 0.0, 2)
def T(s):
    return None if pd.isna(s) or s == "" else datetime.fromisoformat(str(s))
def hrs(a, b):
    return None if a is None or b is None else round((a - b).total_seconds() / 3600, 2)

fails = []
for f in sorted(glob.glob(f"{ROOT}/output/EC_*.json")):
    out = json.load(open(f, encoding="utf-8"))
    cid = out["case_id"]
    oid = json.load(open(f"{ROOT}/input/{cid}.json", encoding="utf-8"))["customer_request"]["claimed_order_id"]
    o = orders[orders.order_id == oid].iloc[0]
    it = items[items.order_id == oid]
    pm = pays[pays.order_id == oid]

    def chk(label, got, want):
        if got != want:
            fails.append(f"{cid} {label}: got={got!r} want={want!r}")

    # --- entities / context
    chk("order_ids", out["affected_entities"]["order_ids"], [oid])
    chk("item_ids", out["affected_entities"]["item_ids"],
        [f"{oid}:{r}" for r in it.order_item_id][:5])
    chk("seller_ids", out["affected_entities"]["seller_ids"], list(dict.fromkeys(it.seller_id))[:3])
    chk("payment_ids", out["affected_entities"]["payment_ids"],
        [f"{oid}:{s}" for s in pm.payment_sequential][:5])
    chk("uid", out["customer_context"]["customer_unique_id"], o.uid)
    chk("related", out["customer_context"]["related_order_ids"],
        [x for x in by_uid.get(o.uid, []) if x != oid][:5])
    chk("products", out["product_context"]["product_ids"], list(dict.fromkeys(it.product_id))[:5])
    cats = [c for c in (pcat.get(p) for p in it.product_id) if isinstance(c, str) and c]
    chk("categories", out["product_context"]["category_names"], list(dict.fromkeys(cats))[:5])

    # --- delivery
    dv, ev, cv = T(o.order_delivered_customer_date), T(o.order_estimated_delivery_date), T(o.order_delivered_carrier_date)
    da = out["delivery_analysis"]
    chk("variance", da["delivery_variance_hours"], hrs(dv, ev))
    limits = it.groupby("seller_id").shipping_limit_date.min()
    want_sh = []
    if cv is not None:
        for s in dict.fromkeys(it.seller_id):
            v = hrs(cv, T(limits[s]))
            want_sh.append({"seller_id": s, "shipping_limit_at": limits[s],
                            "handoff_variance_hours": v, "late_handoff": v is not None and v > 0})
    chk("seller_handoff", da["seller_handoff_analysis"], want_sh)
    late_sellers = [s["seller_id"] for s in want_sh if s["late_handoff"]]
    chk("late_sellers", da["late_handoff_seller_ids"], late_sellers)

    # --- payments
    item_total, freight = R2(it.price.sum()), R2(it.freight_value.sum())
    ptotal = R2(pm.payment_value.sum())
    exp = R2(item_total + freight) if len(it) else None
    diff = None if exp is None else R2(ptotal - exp)
    pr = out["payment_reconciliation"]
    chk("item_total", pr["item_total_brl"], item_total)
    chk("freight_total", pr["freight_total_brl"], freight)
    chk("expected", pr["expected_total_brl"], exp)
    chk("payment_total", pr["payment_total_brl"], ptotal)
    chk("difference", pr["difference_brl"], diff)
    chk("reconciled", pr["reconciled"], None if diff is None else abs(diff) <= 0.10)
    chk("payment_types", pr["payment_types"], list(dict.fromkeys(pm.payment_type)))

    # --- policy
    late = dv is not None and ev is not None and dv > ev
    if o.order_status == "canceled" and ptotal > 0:
        issue, cause, party, pids, refund, act = "canceled_order_paid", "ORDER_CANCELED_AFTER_PAYMENT", "platform", ["OLIST_PLATFORM"], ptotal, ["issue_full_refund", "verify_refund_completion"]
    elif o.order_status == "unavailable" and ptotal > 0:
        issue, cause, party, pids, refund, act = "unavailable_order_paid", "ORDER_UNAVAILABLE_AFTER_PAYMENT", "platform", ["OLIST_PLATFORM"], ptotal, ["issue_full_refund", "verify_refund_completion"]
    elif late and late_sellers:
        issue, cause, party, pids, refund, act = "late_delivery_seller", "SELLER_HANDOFF_AFTER_LIMIT", "seller", late_sellers[:3], freight, ["refund_freight", "review_seller_handoff"]
    elif late:
        issue, cause, party, pids, refund, act = "late_delivery_logistics", "CARRIER_DELIVERED_AFTER_ESTIMATE", "logistics_provider", ["LOGISTICS_PROVIDER"], freight, ["refund_freight", "review_carrier_delay"]
    elif len(pm) >= 2 and diff is not None and abs(diff) <= 0.10:
        issue, cause, party, pids, refund, act = "valid_split_payment", "MULTIPLE_PAYMENTS_RECONCILED", None, [], 0, ["explain_valid_split_payment"]
    else:
        issue, cause, party, pids, refund, act = "unsupported_late_claim", "DELIVERY_WITHIN_ESTIMATE", None, [], 0, ["reject_late_refund"]

    sec = []
    if len(it) >= 2: sec.append("multi_item_order")
    if it.seller_id.nunique() >= 2: sec.append("multi_seller_order")
    if len(pm) >= 2: sec.append("split_payment")
    if len([x for x in by_uid.get(o.uid, []) if x != oid]): sec.append("repeat_customer")
    if len(set(cats)) >= 2: sec.append("multiple_categories")
    if "multi_seller_order" in sec: act.append("coordinate_multi_seller_case")
    if "split_payment" in sec and issue != "valid_split_payment": act.append("verify_payment_allocation")

    chk("primary", out["case_assessment"]["primary_issue"], issue)
    chk("secondary", out["case_assessment"]["secondary_issues"], sec)
    chk("status", out["case_assessment"]["case_status"], "action_required" if refund > 0 else "no_action")
    # Confidence là đánh giá của Policy LLM; schema validator kiểm miền [0,1].
    # Audit nghiệp vụ không ép một hằng số để tránh biến confidence thành field hardcode.
    chk("cause", out["root_cause_analysis"]["ranked_causes"], [{"cause_code": cause, "rank": 1}])
    chk("parties", out["root_cause_analysis"]["responsible_parties"],
        [{"party_type": party, "party_id": p} for p in pids] if party else [])
    chk("refund", out["financial_resolution"]["recommended_refund_brl"], R2(refund))
    chk("actions", out["resolution_actions"], act[:5])

    want_ev = ([f"order:{oid}"] + [f"item:{oid}:{r}" for r in it.order_item_id][:5]
               + [f"payment:{oid}:{s}" for s in pm.payment_sequential][:5]
               + ([f"seller:{s}" for s in pids[:3]] if party == "seller" else [])
               + [f"policy:{cause}"])
    chk("evidence", out["evidence_ids"], want_ev[:20])

print(f"{len(glob.glob(f'{ROOT}/output/EC_*.json'))} cases audited, {len(fails)} mismatches")
for x in fails[:40]:
    print("  ", x)
if fails:
    raise SystemExit(1)
