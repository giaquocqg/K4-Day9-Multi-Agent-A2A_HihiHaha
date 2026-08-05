import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from src.config import LOGGING_DIR, TRACE_FILE, LOG_LEVEL, LLM_MODEL_NAME

# Configure Python logging for app.log
app_log_path = LOGGING_DIR / "app.log"
logger = logging.getLogger("MultiAgentECom")
logger.setLevel(getattr(logging, LOG_LEVEL.upper(), logging.INFO))

# File Handler for app.log
file_handler = logging.FileHandler(app_log_path, encoding="utf-8")
file_formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s]: %(message)s")
file_handler.setFormatter(file_formatter)

# Console Handler
console_handler = logging.StreamHandler()
console_handler.setFormatter(file_formatter)

if not logger.handlers:
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)


def log_trace_event(
    case_id: str,
    agent_name: str,
    action: str,
    protocol: str = "A2A",
    input_data: dict = None,
    output_data: dict = None,
    status: str = "SUCCESS",
    latency_ms: float = 0.0,
    model_name: str = LLM_MODEL_NAME
):
    """
    Appends a structured trace event to trace.jsonl for auditing and multi-agent tracking.
    """
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "case_id": case_id,
        "agent": agent_name,
        "action": action,
        "protocol": protocol,
        "model_used": model_name,
        "input": input_data or {},
        "output": output_data or {},
        "status": status,
        "latency_ms": round(latency_ms, 2)
    }

    try:
        with open(TRACE_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.error(f"Failed to write to trace.jsonl: {e}")
