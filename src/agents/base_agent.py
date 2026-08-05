import time
from typing import Dict, Any
from src.utils.logger import logger, log_trace_event

class BaseAgent:
    """
    Abstract Base Class for all Agents communicating via A2A Protocol.
    """

    def __init__(self, agent_name: str, protocol: str = "A2A"):
        self.agent_name = agent_name
        self.protocol = protocol

    def process_task(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Wrapper method to handle A2A task processing with latency timing and trace logging.
        """
        start_time = time.time()
        logger.info(f"[{self.agent_name}] Started task action='{action}' for case_id='{case_id}'")
        status = "SUCCESS"
        result = {}

        try:
            result = self.execute(case_id, action, payload)
        except Exception as e:
            status = "ERROR"
            logger.error(f"[{self.agent_name}] Error processing task '{action}' on case '{case_id}': {e}", exc_info=True)
            result = {"error": str(e)}
        finally:
            latency_ms = (time.time() - start_time) * 1000.0
            log_trace_event(
                case_id=case_id,
                agent_name=self.agent_name,
                action=action,
                protocol=self.protocol,
                input_data=payload,
                output_data=result,
                status=status,
                latency_ms=latency_ms
            )
            logger.info(f"[{self.agent_name}] Finished task '{action}' in {latency_ms:.2f}ms with status={status}")

        return result

    def execute(self, case_id: str, action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError("Subclasses must implement execute()")
