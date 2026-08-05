# Member Role Report — Day 9: Multi Agent A2A

## 1. Thông tin cá nhân

| Thông tin | Nội dung |
| --- | --- |
| Họ và tên | Dương Đức Minh |
| MSSV | 01306 |
| Khóa/Lớp | K4 |
| Vai trò chính | Core Developer & Agent Architect |
| Ngày hoàn thành | 2026-08-05 |

## 2. Vai trò và phạm vi công việc

### Phần việc sở hữu

| Module/deliverable | File/hàm phụ trách | Input nhận vào | Output bàn giao | Trạng thái |
| --- | --- | --- | --- | --- |
| Multi-Agent Architecture & A2A Bus | `src/protocols/agent_bus.py`, `src/protocols/a2a_message.py` | A2AMessage | A2AResponse + Trace Log | Hoàn thành |
| Agent Implementation & Core Policy Tools | `src/agents/*.py`, `src/tools/*.py` | Olist CSV Data + Input JSON | Analysis & Policy Resolution | Hoàn thành |
| Verifier & Pydantic Schema Guard | `src/models/output_schema.py`, `src/agents/verifier_agent.py` | Draft JSON Output | Validated Output Schema JSON | Hoàn thành |

### Việc hỗ trợ ngoài phạm vi chính

| Hoạt động | Thành viên/module được hỗ trợ | Kết quả |
| --- | --- | --- |
| Tích hợp Groq API & Trace Logging | All Agents | Tích hợp thành công Groq LLM llama-3.1-8b-instant và logging trace.jsonl |

## 3. Kết quả theo vai trò

| Nhiệm vụ đã thực hiện | File/hàm/artifact liên quan | Kết quả bàn giao | Cách xác minh |
| --- | --- | --- | --- |
| Xây dựng hệ thống Multi-Agent A2A | `main.py`, `src/agents/coordinator.py` | Chạy thành công 50/50 cases khiếu nại | `python main.py` |
| Kiểm chứng Schema và Data Grounding | `verify_outputs.py`, `src/tools/validation_tools.py` | 50 file output JSON trong `output/` đạt 100% test schema | `python verify_outputs.py` |

Mô tả kết quả: Đã chạy thành công pipeline thực tế sinh ra 50 file JSON khiếu nại từ `output/EC_001.json` đến `output/EC_050.json` kèm log `logging/trace.jsonl` và `metadata.json`.

## 4. Giải thích phần kỹ thuật đã thực hiện

### Vấn đề cần giải quyết
Bài lab yêu cầu xây dựng hệ thống Multi-Agent có phân công vai trò, handoff và kiểm chứng giữa các agent để giải quyết 50 khiếu nại thương mại điện tử Olist mà không được hardcode.

### Cách triển khai
Triển khai hệ thống A2A (Agent-to-Agent) với AgentBus làm router giao tiếp giữa 7 Agent chuyên môn hóa. Kết hợp quy tắc `EC_POLICY_V2` và mô hình Groq `llama-3.1-8b-instant` để đưa ra các phán quyết chính xác.

### Input, output và contract

| Thành phần | Mô tả |
| --- | --- |
| Input | `input/EC_NNN.json` chứa `claimed_order_id` |
| Output | `output/EC_NNN.json` chứa đánh giá khiếu nại, đối soát tài chính, bằng chứng và hành động |
| Module phụ thuộc | `pandas`, `pydantic`, `groq` |
| Module sử dụng output | Giám khảo chấm điểm tự động |
| Điều kiện lỗi cần xử lý | Order không có item row, timestamp trễ, chênh lệch thanh toán |

### Cách xác minh

```bash
python main.py
python verify_outputs.py
```

- **Kết quả mong đợi:** 50 file JSON sinh ra khớp schema, không có lỗi.
- **Kết quả thực tế:** 50/50 file đã sinh thành công, vượt qua toàn bộ các bài test schema.
- **Artifact/log:** `logging/trace.jsonl`, `output/*.json`, `metadata.json`
