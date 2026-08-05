from typing import Dict, Any
from src.agents.base_agent import BaseAgent
from src.agents.customer_agent import CustomerAgent
from src.agents.order_product_agent import OrderProductAgent
from src.agents.payment_agent import PaymentAgent
from src.agents.delivery_agent import DeliveryAgent
from src.agents.policy_agent import PolicyAgent
from src.agents.verifier_agent import VerifierAgent
from src.utils.logger import logger

class CoordinatorAgent(BaseAgent):
    """
    Coordinator Agent (Orchestrator): Entry point for dispute cases. Orchestrates the 
    A2A handoff flow across all domain agents, LLM policy reasoning agent, and verifier.
    """

    def __init__(self):
        super().__init__(agent_name="CoordinatorAgent", protocol="A2A/Orchestrator")
        self.customer_agent = CustomerAgent()
        self.order_product_agent = OrderProductAgent()
        self.payment_agent = PaymentAgent()
        self.delivery_agent = DeliveryAgent()
        self.policy_agent = PolicyAgent()
        self.verifier_agent = VerifierAgent()

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        customer_request = payload.get("customer_request", {})
        claimed_order_id = customer_request.get("claimed_order_id")

        if not claimed_order_id:
            raise ValueError(f"Case {case_id} missing claimed_order_id in customer_request")

        logger.info(f"Coordinator orchestrating case {case_id} for order_id {claimed_order_id}")

        # Step 1: Customer Domain Handoff
        customer_info = self.customer_agent.process_task(
            case_id=case_id,
            action="investigate_customer_history",
            payload={"claimed_order_id": claimed_order_id}
        )

        # Step 2: Order & Product Domain Handoff
        item_info = self.order_product_agent.process_task(
            case_id=case_id,
            action="inspect_order_items_and_products",
            payload={"claimed_order_id": claimed_order_id}
        )

        item_total_brl = item_info.get("item_total_brl")
        freight_total_brl = item_info.get("freight_total_brl")
        has_items = len(item_info.get("item_ids", [])) > 0

        # Step 3: Payment Domain Handoff
        payment_info = self.payment_agent.process_task(
            case_id=case_id,
            action="reconcile_payments",
            payload={
                "claimed_order_id": claimed_order_id,
                "item_total_brl": item_total_brl,
                "freight_total_brl": freight_total_brl,
                "has_items": has_items
            }
        )

        # Step 4: Delivery Domain Handoff
        delivery_info = self.delivery_agent.process_task(
            case_id=case_id,
            action="analyze_delivery_timestamps",
            payload={
                "claimed_order_id": claimed_order_id,
                "items_detail": item_info.get("items_detail", [])
            }
        )

        # Step 5: Policy & Reasoning Handoff (Executes Groq LLM API model call per case)
        order_status = "delivered"
        if self.customer_agent.data_server:
            order_row = self.customer_agent.data_server.get_order(claimed_order_id)
            if order_row:
                order_status = order_row.get("order_status", "delivered")

        policy_res = self.policy_agent.process_task(
            case_id=case_id,
            action="evaluate_dispute_policy",
            payload={
                "claimed_order_id": claimed_order_id,
                "order_status": order_status,
                "customer_info": customer_info,
                "item_info": item_info,
                "payment_info": payment_info,
                "delivery_info": delivery_info
            }
        )

        # Step 6: Verifier Guardrail Handoff & Output Generation
        verification_res = self.verifier_agent.process_task(
            case_id=case_id,
            action="verify_and_write_output",
            payload={
                "claimed_order_id": claimed_order_id,
                "customer_info": customer_info,
                "item_info": item_info,
                "payment_info": payment_info,
                "delivery_info": delivery_info,
                "policy_res": policy_res
            }
        )

        return verification_res
