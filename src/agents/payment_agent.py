from typing import Dict, Any
from src.agents.base_agent import BaseAgent
from src.data_engine.tools import MCPDataServer

class PaymentAgent(BaseAgent):
    """
    Payment Domain Agent: Uses MCP tools to perform payment breakdown and financial math.
    """

    def __init__(self):
        super().__init__(agent_name="PaymentAgent", protocol="A2A/MCP")
        self.data_server = MCPDataServer()

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        claimed_order_id = payload.get("claimed_order_id")
        item_total_brl = payload.get("item_total_brl")
        freight_total_brl = payload.get("freight_total_brl")
        has_items = payload.get("has_items", True)

        payment_info = self.data_server.get_order_payments(claimed_order_id)
        payment_total_brl = payment_info.get("payment_total_brl", 0.0)
        payment_ids = payment_info.get("payment_ids", [])
        payment_types = payment_info.get("payment_types", [])

        if not has_items or item_total_brl is None or freight_total_brl is None:
            return {
                "currency": "BRL",
                "item_total_brl": item_total_brl,
                "freight_total_brl": freight_total_brl,
                "expected_total_brl": None,
                "payment_total_brl": round(payment_total_brl, 2),
                "difference_brl": None,
                "reconciled": None,
                "payment_types": payment_types,
                "payment_ids": payment_ids
            }

        expected_total_brl = round(item_total_brl + freight_total_brl, 2)
        difference_brl = round(payment_total_brl - expected_total_brl, 2)
        reconciled = bool(abs(difference_brl) <= 0.10)

        return {
            "currency": "BRL",
            "item_total_brl": round(item_total_brl, 2),
            "freight_total_brl": round(freight_total_brl, 2),
            "expected_total_brl": expected_total_brl,
            "payment_total_brl": round(payment_total_brl, 2),
            "difference_brl": difference_brl,
            "reconciled": reconciled,
            "payment_types": payment_types,
            "payment_ids": payment_ids
        }
