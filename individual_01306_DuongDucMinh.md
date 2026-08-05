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

## 5. Một quyết định kỹ thuật quan trọng

- **Bối cảnh:** Cần chọn cơ chế tương tác giữa các Agent sao cho vừa đảm bảo tính linh hoạt của LLM vừa đảm bảo độ chính xác tuyệt đối (Grounding) không bị ảo giác.
- **Các phương án đã cân nhắc:**
  1. Cho LLM sinh trực tiếp toàn bộ file JSON từ prompt dài.
  2. Sử dụng kiến trúc Multi-Agent A2A kết hợp Tools tính toán deterministic và Verifier Agent.
- **Phương án đã chọn:** Phương án 2.
- **Lý do:** Đảm bảo 100% dữ liệu grounded từ CSV, tránh LLM bị hallucinate ngày tháng hay số tiền, đồng thời đáp ứng tiêu chí phân công handoff của bài lab.

## 6. Một lỗi hoặc blocker đã xử lý

- **Triệu chứng/lỗi nguyên văn:** Order hủy không có item row làm cho phép tính `expected_total_brl` bị lỗi.
- **Lệnh hoặc bước tái hiện:** Chạy case đơn hàng hủy/không khả dụng chưa có item rows.
- **Nguyên nhân gốc:** `expected_total_brl` cần trả về `null` thay vì 0.0 theo đúng quy định đề bài.
- **Cách xử lý:** Xử lý điều kiện `if not items` trong `lookup_payments` để trả về `null` cho các trường tài chính liên quan.
- **Cách xác minh sau khi sửa:** Chạy lại `verify_outputs.py` và kiểm tra JSON đầu ra.

## 7. Hiểu biết về luồng end-to-end

1. Dữ liệu đi từ các file CSV Olist trong `data/` được load vào bộ nhớ thông qua `OlistDataLoader`.
2. Khi nhận input JSON case, Coordinator gửi message giao task tới Customer Agent, Order Product Agent, Payment Agent, Delivery Agent.
3. Policy Agent nhận thông tin đã tổng hợp để áp dụng chính sách EC_POLICY_V2 và gọi Groq API.
4. Verifier Agent kiểm tra tính toàn vẹn của Pydantic schema, array limits, và kiểm chứng các evidence ID tồn tại trong CSV.
5. Ghi file kết quả `output/EC_NNN.json` và log lại toàn bộ trace tương tác vào `trace.jsonl`.

## 8. Cam kết của thành viên

Đánh dấu sau khi tự kiểm tra:

- [x] Nội dung báo cáo phản ánh đúng phần việc và mức hiểu của tôi.
- [x] Tôi có thể giải thích luồng end-to-end, không chỉ module mình phụ trách.
- [x] Tôi không ghi “đã chạy thành công” cho phần chưa được kiểm chứng.
- [x] Báo cáo không chứa `.env`, API key, token hoặc secret.
- [x] Báo cáo này không phải bản sao nguyên văn của báo cáo nhóm hoặc báo cáo thành viên khác.

**Họ và tên:** Dương Đức Minh  
**Ngày xác nhận:** 2026-08-05
