import json
import time
from pathlib import Path
from src.config import INPUT_DIR, OUTPUT_DIR, TRACE_FILE, LOGGING_DIR
from src.utils.logger import logger
from src.agents.coordinator_agent import CoordinatorAgent

def main():
    logger.info("=========================================================")
    logger.info(" Starting Multi-Agent Dispute Resolution Execution Pipeline")
    logger.info("=========================================================")

    # Ensure output directory exists
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOGGING_DIR.mkdir(parents=True, exist_ok=True)

    # Clean previous trace.jsonl for fresh run as per README requirements
    if TRACE_FILE.exists():
        logger.info(f"Clearing old trace file: {TRACE_FILE}")
        TRACE_FILE.unlink()

    # Find all input JSON cases
    input_files = sorted(list(INPUT_DIR.glob("EC_*.json")))
    if not input_files:
        logger.error(f"No input cases found in {INPUT_DIR}")
        return

    logger.info(f"Found {len(input_files)} cases in {INPUT_DIR}")

    coordinator = CoordinatorAgent()
    success_count = 0
    start_all_time = time.time()

    for idx, input_path in enumerate(input_files, 1):
        case_id = input_path.stem
        logger.info(f"[{idx}/{len(input_files)}] Processing case: {case_id}")
        
        try:
            with open(input_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            
            res = coordinator.process_task(
                case_id=case_id,
                action="resolve_dispute_case",
                payload=payload
            )
            
            if res.get("verified"):
                success_count += 1
                logger.info(f"Case {case_id} processed successfully.")
            else:
                logger.warning(f"Case {case_id} finished with warning.")

        except Exception as e:
            logger.error(f"Failed processing case {case_id}: {e}", exc_info=True)

    total_time = time.time() - start_all_time
    logger.info("=========================================================")
    logger.info(f" Pipeline Execution Summary:")
    logger.info(f" - Total Cases Processed : {len(input_files)}")
    logger.info(f" - Successful Outputs    : {success_count} / {len(input_files)}")
    logger.info(f" - Total Execution Time  : {total_time:.2f} seconds")
    logger.info(f" - Output Directory      : {OUTPUT_DIR.resolve()}")
    logger.info(f" - Audit Trace Log File  : {TRACE_FILE.resolve()}")
    logger.info("=========================================================")

if __name__ == "__main__":
    main()
