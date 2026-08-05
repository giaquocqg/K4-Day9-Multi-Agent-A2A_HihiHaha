from datetime import datetime

DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"

def parse_datetime(dt_str: str):
    if not dt_str or dt_str.lower() in ("null", "none", ""):
        return None
    try:
        return datetime.strptime(str(dt_str).strip(), DATETIME_FORMAT)
    except Exception:
        # Fallback parsing if ISO or slight mismatch
        try:
            return datetime.fromisoformat(str(dt_str).strip())
        except Exception:
            return None

def compute_hours_difference(dt_end_str: str, dt_start_str: str) -> float:
    dt_end = parse_datetime(dt_end_str)
    dt_start = parse_datetime(dt_start_str)
    if not dt_end or not dt_start:
        return 0.0
    diff_seconds = (dt_end - dt_start).total_seconds()
    return round(diff_seconds / 3600.0, 2)

def evaluate_policy_v2(
    order_id: str,
    order_status: str,
    delivery_info: dict,
    payment_info: dict,
    item_info: dict,
    customer_info: dict
) -> dict:
    """
    Applies EC_POLICY_V2 business logic rules sequentially to calculate primary issue,
    secondary issues, responsible parties, financial resolution, root cause, evidence IDs, and actions.
    """
    # 1. Destructure Data
    delivered_at = delivery_info.get("delivered_at")
    estimated_delivery_at = delivery_info.get("estimated_delivery_at")
    carrier_handoff_at = delivery_info.get("carrier_handoff_at")
    delivery_variance_hours = delivery_info.get("delivery_variance_hours", 0.0)
    seller_handoff_analysis = delivery_info.get("seller_handoff_analysis", [])
    late_handoff_seller_ids = delivery_info.get("late_handoff_seller_ids", [])

    payment_ids = payment_info.get("payment_ids", [])
    payment_total_brl = payment_info.get("payment_total_brl", 0.0)
    expected_total_brl = payment_info.get("expected_total_brl")
    reconciled = payment_info.get("reconciled")
    freight_total_brl = payment_info.get("freight_total_brl", 0.0)

    item_ids = item_info.get("item_ids", [])
    seller_ids = item_info.get("seller_ids", [])
    category_names = item_info.get("category_names", [])

    related_order_ids = customer_info.get("related_order_ids", [])

    # 2. Determine Primary Issue and Core Parameters
    primary_issue = "unsupported_late_claim"
    responsible_party_type = None
    responsible_party_ids = []
    recommended_refund_brl = 0.0
    primary_action = "reject_late_refund"
    root_cause_code = "DELIVERY_WITHIN_ESTIMATE"

    status_lower = str(order_status).lower() if order_status else ""

    if status_lower == "canceled" and payment_total_brl > 0:
        primary_issue = "canceled_order_paid"
        responsible_party_type = "platform"
        responsible_party_ids = ["OLIST_PLATFORM"]
        recommended_refund_brl = payment_total_brl
        primary_action = "issue_full_refund"
        root_cause_code = "ORDER_CANCELED_AFTER_PAYMENT"

    elif status_lower == "unavailable" and payment_total_brl > 0:
        primary_issue = "unavailable_order_paid"
        responsible_party_type = "platform"
        responsible_party_ids = ["OLIST_PLATFORM"]
        recommended_refund_brl = payment_total_brl
        primary_action = "issue_full_refund"
        root_cause_code = "ORDER_UNAVAILABLE_AFTER_PAYMENT"

    elif delivery_variance_hours > 0 and len(late_handoff_seller_ids) > 0:
        primary_issue = "late_delivery_seller"
        responsible_party_type = "seller"
        responsible_party_ids = late_handoff_seller_ids
        recommended_refund_brl = freight_total_brl if freight_total_brl is not None else 0.0
        primary_action = "refund_freight"
        root_cause_code = "SELLER_HANDOFF_AFTER_LIMIT"

    elif delivery_variance_hours > 0 and len(late_handoff_seller_ids) == 0:
        primary_issue = "late_delivery_logistics"
        responsible_party_type = "logistics_provider"
        responsible_party_ids = ["LOGISTICS_PROVIDER"]
        recommended_refund_brl = freight_total_brl if freight_total_brl is not None else 0.0
        primary_action = "refund_freight"
        root_cause_code = "CARRIER_DELIVERED_AFTER_ESTIMATE"

    elif len(payment_ids) >= 2 and reconciled is True:
        primary_issue = "valid_split_payment"
        responsible_party_type = None
        responsible_party_ids = []
        recommended_refund_brl = 0.0
        primary_action = "explain_valid_split_payment"
        root_cause_code = "MULTIPLE_PAYMENTS_RECONCILED"

    else:
        primary_issue = "unsupported_late_claim"
        responsible_party_type = None
        responsible_party_ids = []
        recommended_refund_brl = 0.0
        primary_action = "reject_late_refund"
        root_cause_code = "DELIVERY_WITHIN_ESTIMATE"

    # 3. Determine Secondary Issues (strictly in order)
    secondary_issues = []
    if len(item_ids) >= 2:
        secondary_issues.append("multi_item_order")
    if len(seller_ids) >= 2:
        secondary_issues.append("multi_seller_order")
    if len(payment_ids) >= 2:
        secondary_issues.append("split_payment")
    if len(related_order_ids) >= 1:
        secondary_issues.append("repeat_customer")
    if len(category_names) >= 2:
        secondary_issues.append("multiple_categories")

    # 4. Determine Supplementary Actions
    actions = [primary_action]
    if primary_issue == "late_delivery_seller":
        actions.append("review_seller_handoff")
    elif primary_issue == "late_delivery_logistics":
        actions.append("review_carrier_delay")

    if recommended_refund_brl > 0:
        actions.append("verify_refund_completion")

    if "multi_seller_order" in secondary_issues:
        actions.append("coordinate_multi_seller_case")

    if "split_payment" in secondary_issues and primary_issue != "valid_split_payment":
        actions.append("verify_payment_allocation")

    # Limit actions to max 5
    actions = actions[:5]

    # 5. Build Responsible Parties structure
    responsible_parties = []
    if responsible_party_type == "platform":
        responsible_parties.append({"party_type": "platform", "party_id": "OLIST_PLATFORM"})
    elif responsible_party_type == "logistics_provider":
        responsible_parties.append({"party_type": "logistics_provider", "party_id": "LOGISTICS_PROVIDER"})
    elif responsible_party_type == "seller":
        for sid in responsible_party_ids[:3]:
            responsible_parties.append({"party_type": "seller", "party_id": sid})

    # 6. Build Evidence IDs
    evidence_ids = [f"order:{order_id}"]
    for iid in item_ids:
        evidence_ids.append(f"item:{iid}")
    for pid in payment_ids:
        evidence_ids.append(f"payment:{pid}")

    if responsible_party_type == "seller":
        for sid in responsible_party_ids:
            evidence_ids.append(f"seller:{sid}")

    evidence_ids.append(f"policy:{root_cause_code}")
    # Deduplicate while preserving order and limit to max 20
    seen = set()
    deduped_evidences = []
    for ev in evidence_ids:
        if ev not in seen:
            seen.add(ev)
            deduped_evidences.append(ev)
    evidence_ids = deduped_evidences[:20]

    # 7. Case Status
    case_status = "action_required" if recommended_refund_brl > 0 else "no_action"

    return {
        "primary_issue": primary_issue,
        "secondary_issues": secondary_issues,
        "case_status": case_status,
        "confidence": 0.95,
        "root_cause_code": root_cause_code,
        "responsible_parties": responsible_parties,
        "evidence_ids": evidence_ids,
        "recommended_refund_brl": round(recommended_refund_brl, 2),
        "actions": actions
    }
