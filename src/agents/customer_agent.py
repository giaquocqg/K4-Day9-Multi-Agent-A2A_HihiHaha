from typing import Dict, Any
from src.agents.base_agent import BaseAgent
from src.data_engine.tools import MCPDataServer

class CustomerAgent(BaseAgent):
    """
    Customer Domain Agent: Uses MCP tools for data retrieval to resolve 
    customer identity (customer_unique_id) and related order history.
    """

    def __init__(self):
        super().__init__(agent_name="CustomerAgent", protocol="A2A/MCP")
        self.data_server = MCPDataServer()

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        claimed_order_id = payload.get("claimed_order_id")
        customer_id = payload.get("customer_id")

        if not customer_id and claimed_order_id:
            order_data = self.data_server.get_order(claimed_order_id)
            if order_data:
                customer_id = order_data.get("customer_id")

        if not customer_id:
            return {"customer_unique_id": None, "related_order_ids": []}

        cust_history = self.data_server.get_customer_history(
            customer_id=customer_id,
            claimed_order_id=claimed_order_id
        )

        return {
            "customer_unique_id": cust_history.get("customer_unique_id"),
            "related_order_ids": cust_history.get("related_order_ids", [])
        }
