import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file if available
env_path = Path(".env")
if env_path.exists():
    load_dotenv(dotenv_path=env_path, override=True)
else:
    load_dotenv(override=True)

# Workspace Root
BASE_DIR = Path(__file__).resolve().parent.parent

# Directories
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
INPUT_DIR = Path(os.getenv("INPUT_DIR", BASE_DIR / "input"))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", BASE_DIR / "output"))
LOGGING_DIR = Path(os.getenv("LOGGING_DIR", BASE_DIR / "logging"))
TRACE_FILE = Path(os.getenv("TRACE_FILE", BASE_DIR / "trace.jsonl"))

# Ensure directories exist
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
LOGGING_DIR.mkdir(parents=True, exist_ok=True)

# LLM Configuration (<10B Parameter models)
LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "qwen/qwen-2.5-7b-instruct")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
