import json
from pathlib import Path
from typing import Dict, Any
from src.agents.base_agent import BaseAgent
from src.config import OUTPUT_DIR
from src.utils.logger import logger

class VerifierAgent(BaseAgent):
    """
    Verifier Agent (Guardrail & Output Formatting): Validates output JSON against 
    strict constraints, null rules, array bounds, decimal rounding, and writes 
    the output to output/EC_xxx.json.
    """

    def __init__(self):
        super().__init__(agent_name="VerifierAgent", protocol="A2A/Guardrail")

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        claimed_order_id = payload.get("claimed_order_id")
        customer_info = payload.get("customer_info", {})
        item_info = payload.get("item_info", {})
        payment_info = payload.get("payment_info", {})
        delivery_info = payload.get("delivery_info", {})
        policy_res = payload.get("policy_res", {})

        item_ids = item_info.get("item_ids", [])
        has_items = len(item_ids) > 0

        # Construct final output dictionary matching README.md Section 6 schema exactly
        output_data = {
            "case_id": case_id,
            "case_assessment": {
                "primary_issue": policy_res.get("primary_issue"),
                "secondary_issues": policy_res.get("secondary_issues", []),
                "case_status": policy_res.get("case_status", "no_action"),
                "confidence": round(float(policy_res.get("confidence", 0.95)), 2)
            },
            "affected_entities": {
                "order_ids": [claimed_order_id][:5],
                "item_ids": item_ids[:5],
                "seller_ids": item_info.get("seller_ids", [])[:3],
                "payment_ids": payment_info.get("payment_ids", [])[:5]
            },
            "customer_context": {
                "customer_unique_id": customer_info.get("customer_unique_id"),
                "related_order_ids": customer_info.get("related_order_ids", [])[:5]
            },
            "product_context": {
                "product_ids": item_info.get("product_ids", [])[:5],
                "category_names": item_info.get("category_names", [])[:5]
            },
            "delivery_analysis": {
                "delivered_at": delivery_info.get("delivered_at"),
                "estimated_delivery_at": delivery_info.get("estimated_delivery_at"),
                "carrier_handoff_at": delivery_info.get("carrier_handoff_at"),
                "delivery_variance_hours": round(float(delivery_info.get("delivery_variance_hours", 0.0)), 2),
                "seller_handoff_analysis": delivery_info.get("seller_handoff_analysis", []) if has_items else [],
                "late_handoff_seller_ids": delivery_info.get("late_handoff_seller_ids", [])[:3] if has_items else []
            },
            "payment_reconciliation": {
                "currency": "BRL",
                "item_total_brl": round(float(payment_info["item_total_brl"]), 2) if payment_info.get("item_total_brl") is not None else None,
                "freight_total_brl": round(float(payment_info["freight_total_brl"]), 2) if payment_info.get("freight_total_brl") is not None else None,
                "expected_total_brl": round(float(payment_info["expected_total_brl"]), 2) if payment_info.get("expected_total_brl") is not None else None,
                "payment_total_brl": round(float(payment_info.get("payment_total_brl", 0.0)), 2),
                "difference_brl": round(float(payment_info["difference_brl"]), 2) if payment_info.get("difference_brl") is not None else None,
                "reconciled": payment_info.get("reconciled"),
                "payment_types": payment_info.get("payment_types", [])
            },
            "root_cause_analysis": {
                "ranked_causes": [
                    {
                        "cause_code": policy_res.get("root_cause_code"),
                        "rank": 1
                    }
                ][:3],
                "responsible_parties": policy_res.get("responsible_parties", [])[:3]
            },
            "evidence_ids": policy_res.get("evidence_ids", [])[:20],
            "financial_resolution": {
                "currency": "BRL",
                "recommended_refund_brl": round(float(policy_res.get("recommended_refund_brl", 0.0)), 2)
            },
            "resolution_actions": policy_res.get("actions", [])[:5]
        }

        # Enforce empty item rules if has_items is False
        if not has_items:
            output_data["affected_entities"]["item_ids"] = []
            output_data["affected_entities"]["seller_ids"] = []
            output_data["product_context"]["product_ids"] = []
            output_data["product_context"]["category_names"] = []
            output_data["delivery_analysis"]["seller_handoff_analysis"] = []
            output_data["delivery_analysis"]["late_handoff_seller_ids"] = []
            output_data["payment_reconciliation"]["expected_total_brl"] = None
            output_data["payment_reconciliation"]["difference_brl"] = None
            output_data["payment_reconciliation"]["reconciled"] = None

        # Write to file output/EC_xxx.json
        output_file = OUTPUT_DIR / f"{case_id}.json"
        try:
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(output_data, f, ensure_ascii=False, indent=2)
            logger.info(f"Successfully wrote verified output to {output_file}")
        except Exception as e:
            logger.error(f"Failed writing output file {output_file}: {e}")
            raise e

        return {"verified": True, "output_path": str(output_file), "output_data": output_data}
