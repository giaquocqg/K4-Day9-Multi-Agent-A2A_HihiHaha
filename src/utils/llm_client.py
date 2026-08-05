import json
import requests
import time
from typing import Dict, Any
from src.config import OPENROUTER_API_KEY, GROQ_API_KEY, LLM_MODEL_NAME
from src.utils.logger import logger

class LLMClient:
    """
    Centralized LLM Client supporting OpenRouter API and Groq API for <10B parameter models.
    """

    def __init__(self, model_name: str = None):
        self.model_name = model_name or LLM_MODEL_NAME or "qwen/qwen-2.5-7b-instruct"
        self.openrouter_key = OPENROUTER_API_KEY
        self.groq_key = GROQ_API_KEY

        if not self.openrouter_key and not self.groq_key:
            raise ValueError("No API key set in .env! OPENROUTER_API_KEY or GROQ_API_KEY is required.")

    def generate_json(self, system_prompt: str, user_prompt: str, temperature: float = 0.0, max_retries: int = 5) -> Dict[str, Any]:
        """
        Calls OpenRouter API or Groq API to generate JSON output using <10B model.
        """
        full_system_prompt = system_prompt
        if "json" not in full_system_prompt.lower():
            full_system_prompt += " Output strictly in valid JSON format."

        # Option A: OpenRouter API (Primary if OPENROUTER_API_KEY is set)
        if self.openrouter_key:
            url = "https://openrouter.ai/api/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {self.openrouter_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com",
                "X-Title": "Multi-Agent-A2A"
            }
            data = {
                "model": self.model_name,
                "messages": [
                    {"role": "system", "content": full_system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": temperature,
                "response_format": {"type": "json_object"}
            }

            last_error = None
            for attempt in range(1, max_retries + 1):
                try:
                    start_time = time.time()
                    res = requests.post(url, headers=headers, json=data, timeout=30)
                    elapsed = (time.time() - start_time) * 1000.0

                    if res.status_code == 200:
                        res_json = res.json()
                        content = res_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                        parsed = json.loads(content)
                        logger.debug(f"OpenRouter LLM [{self.model_name}] responded in {elapsed:.2f}ms")
                        time.sleep(0.5)
                        return parsed
                    elif res.status_code == 429:
                        wait_time = min(3 * attempt, 15)
                        logger.warning(f"OpenRouter API rate limited (429), attempt {attempt}/{max_retries}. Waiting {wait_time}s...")
                        time.sleep(wait_time)
                    else:
                        last_error = f"HTTP {res.status_code}: {res.text}"
                        logger.warning(f"OpenRouter API error {last_error}, attempt {attempt}/{max_retries}")
                        time.sleep(2)

                except Exception as e:
                    last_error = e
                    logger.warning(f"OpenRouter LLM call attempt {attempt}/{max_retries} failed: {e}")
                    time.sleep(1.5)

            raise RuntimeError(f"Failed calling OpenRouter model '{self.model_name}' after {max_retries} retries: {last_error}")

        # Option B: Groq API
        elif self.groq_key:
            url = "https://api.groq.com/openai/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {self.groq_key}",
                "Content-Type": "application/json"
            }
            data = {
                "model": self.model_name if "/" not in self.model_name else "llama-3.1-8b-instant",
                "messages": [
                    {"role": "system", "content": full_system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": temperature,
                "response_format": {"type": "json_object"}
            }

            last_error = None
            for attempt in range(1, max_retries + 1):
                try:
                    start_time = time.time()
                    res = requests.post(url, headers=headers, json=data, timeout=30)
                    elapsed = (time.time() - start_time) * 1000.0

                    if res.status_code == 200:
                        res_json = res.json()
                        content = res_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                        parsed = json.loads(content)
                        logger.debug(f"Groq LLM responded in {elapsed:.2f}ms")
                        time.sleep(1.0)
                        return parsed
                    elif res.status_code == 429:
                        wait_time = min(4 * (2 ** (attempt - 1)), 30)
                        logger.warning(f"Groq API rate limited (429), attempt {attempt}/{max_retries}. Waiting {wait_time}s...")
                        time.sleep(wait_time)
                    else:
                        last_error = f"HTTP {res.status_code}: {res.text}"
                        logger.warning(f"Groq API error {last_error}, attempt {attempt}/{max_retries}")
                        time.sleep(2)

                except Exception as e:
                    last_error = e
                    logger.warning(f"Groq LLM call attempt {attempt}/{max_retries} failed: {e}")
                    time.sleep(2)

            raise RuntimeError(f"Failed calling Groq model after {max_retries} retries: {last_error}")
