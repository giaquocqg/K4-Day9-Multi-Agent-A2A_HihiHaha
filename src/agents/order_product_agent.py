from typing import Dict, Any
from src.agents.base_agent import BaseAgent
from src.data_engine.tools import MCPDataServer

class OrderProductAgent(BaseAgent):
    """
    Order & Product Domain Agent: Uses MCP tools to inspect order items, 
    products, sellers, and translated product categories.
    """

    def __init__(self):
        super().__init__(agent_name="OrderProductAgent", protocol="A2A/MCP")
        self.data_server = MCPDataServer()

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        claimed_order_id = payload.get("claimed_order_id")
        if not claimed_order_id:
            return {
                "item_ids": [],
                "seller_ids": [],
                "product_ids": [],
                "category_names": [],
                "item_total_brl": None,
                "freight_total_brl": None,
                "items_detail": []
            }

        res = self.data_server.get_order_items_and_products(claimed_order_id)
        return res
