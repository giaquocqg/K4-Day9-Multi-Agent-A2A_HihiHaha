from typing import Dict, Any, List
from src.agents.base_agent import BaseAgent
from src.data_engine.tools import MCPDataServer
from src.utils.policy import parse_datetime, compute_hours_difference

class DeliveryAgent(BaseAgent):
    """
    Delivery Domain Agent: Uses MCP tools to evaluate delivery timestamps, 
    delivery variance hours, and seller handoff delays.
    """

    def __init__(self):
        super().__init__(agent_name="DeliveryAgent", protocol="A2A/MCP")
        self.data_server = MCPDataServer()

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        claimed_order_id = payload.get("claimed_order_id")
        items_detail = payload.get("items_detail", [])

        order_data = self.data_server.get_order(claimed_order_id)
        if not order_data:
            return {
                "delivered_at": None,
                "estimated_delivery_at": None,
                "carrier_handoff_at": None,
                "delivery_variance_hours": None,
                "seller_handoff_analysis": [],
                "late_handoff_seller_ids": []
            }

        delivered_at = order_data.get("order_delivered_customer_date")
        estimated_delivery_at = order_data.get("order_estimated_delivery_date")
        carrier_handoff_at = order_data.get("order_delivered_carrier_date")

        delivery_variance_hours = None
        if delivered_at and estimated_delivery_at and str(delivered_at).strip().lower() not in ("null", "none", "") and str(estimated_delivery_at).strip().lower() not in ("null", "none", ""):
            delivery_variance_hours = compute_hours_difference(delivered_at, estimated_delivery_at)

        seller_limits: Dict[str, str] = {}
        for item in items_detail:
            sid = item.get("seller_id")
            s_limit = item.get("shipping_limit_at")
            if sid and s_limit:
                if sid not in seller_limits:
                    seller_limits[sid] = s_limit
                else:
                    dt_existing = parse_datetime(seller_limits[sid])
                    dt_new = parse_datetime(s_limit)
                    if dt_new and dt_existing and dt_new < dt_existing:
                        seller_limits[sid] = s_limit

        seller_handoff_analysis: List[Dict[str, Any]] = []
        late_handoff_seller_ids: List[str] = []

        for sid, s_limit in seller_limits.items():
            if carrier_handoff_at and str(carrier_handoff_at).strip().lower() not in ("null", "none", ""):
                h_variance = compute_hours_difference(carrier_handoff_at, s_limit)
                is_late = bool(h_variance > 0.0)
            else:
                h_variance = None
                is_late = False

            seller_handoff_analysis.append({
                "seller_id": sid,
                "shipping_limit_at": s_limit,
                "handoff_variance_hours": h_variance,
                "late_handoff": is_late
            })
            if is_late and sid not in late_handoff_seller_ids:
                late_handoff_seller_ids.append(sid)

        return {
            "delivered_at": delivered_at if str(delivered_at).strip().lower() not in ("null", "none", "") else None,
            "estimated_delivery_at": estimated_delivery_at if str(estimated_delivery_at).strip().lower() not in ("null", "none", "") else None,
            "carrier_handoff_at": carrier_handoff_at if str(carrier_handoff_at).strip().lower() not in ("null", "none", "") else None,
            "delivery_variance_hours": delivery_variance_hours,
            "seller_handoff_analysis": seller_handoff_analysis,
            "late_handoff_seller_ids": late_handoff_seller_ids
        }
