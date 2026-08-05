# Member Role Report — Day 9: Multi Agent A2A

## 1. Thông tin cá nhân

| Thông tin | Nội dung |
| --- | --- |
| Họ và tên | Dương Đức Minh |
| MSSV | 01306 |
| Khóa/Lớp | K4 |
| Vai trò chính | Core Developer & LLM Integration Architect |
| Ngày hoàn thành | 2026-08-05 |

## 2. Vai trò và phạm vi công việc

### Phần việc sở hữu

| Module/deliverable | File/hàm phụ trách | Input nhận vào | Output bàn giao | Trạng thái |
| --- | --- | --- | --- | --- |
| Specialist Agent Prompting & Execution Loop | `src/agents-llm.js` | Facts từ database & Yêu cầu từ Coordinator | Specialist Finding JSON | Hoàn thành |
| LLM Transport & Retry Layer | `src/llm.js` | API Payload | LLM Chat Completion Response | Hoàn thành |
| Rules & Constraints Verifier | `src/agents.js` | Candidate Findings/Artifacts | List of validation errors | Hoàn thành |

### Việc hỗ trợ ngoài phạm vi chính

| Hoạt động | Thành viên/module được hỗ trợ | Kết quả |
| --- | --- | --- |
| Cấu hình schema validation | Nhóm (Tất cả Specialist Agents) | Tích hợp Joi/Pydantic validation schemas để kiểm soát tính chính xác của output |

## 3. Kết quả theo vai trò

| Nhiệm vụ đã thực hiện | File/hàm/artifact liên quan | Kết quả bàn giao | Cách xác minh |
| --- | --- | --- | --- |
| Xây dựng Specialist Agents & Policy/Verifier | `src/agents-llm.js`, `src/agents.js` | Toàn bộ 5 Specialist Agents chạy ổn định | `npm run solve` |
| Xây dựng tầng LLM Connection, Retry & Backoff | `src/llm.js` | Xử lý lỗi 429 và Timeout khi chạy 50 cases | Đọc logs trace, đo hiệu suất |

Mô tả kết quả: Đã lập trình thành công lõi xử lý LLM và validation cho hệ thống Multi-Agent, giúp hệ thống hoàn thành 50/50 cases khiếu nại lưu trữ trong thư mục `output/` đạt tỷ lệ schema pass 100%.

## 4. Giải thích phần kỹ thuật đã thực hiện

### Vấn đề cần giải quyết
Hệ thống Multi-Agent cần giao tiếp với LLM (Groq/OpenAI) một cách ổn định, tự động khắc phục lỗi rate-limit, đồng thời các Specialist Agent phải trích xuất dữ liệu chính xác và tuân thủ các ràng buộc nghiệp vụ của `EC_POLICY_V2` mà không bị ảo giác.

### Cách triển khai
Tôi đã triển khai class-level wrapper hoặc các hàm độc lập trong `src/agents-llm.js` để định nghĩa prompt, system instructions và JSON schema cho các Agent. Sử dụng hàm `runValidated` để thực hiện vòng lặp Validate-Retry: LLM sinh kết quả -> Chạy hàm kiểm tra tính chính xác của dữ liệu trong `src/agents.js` -> Nếu lỗi, gửi ngược danh sách lỗi chi tiết cho LLM sửa đổi trong lần retry tiếp theo.

### Input, output và contract

| Thành phần | Mô tả |
| --- | --- |
| Input | Dữ liệu thô từ CSV (Order, Payments, Customer, Delivery) + Prompt nghiệp vụ |
| Output | Finding JSON đã được validate của các Agent (Customer, Delivery, Order, Payment) |
| Module phụ thuộc | Node.js `fetch` API, `src/config.js` |
| Module sử dụng output | `Coordinator` để tổng hợp facts, `PolicyAgent` để đưa ra quyết định đền bù |
| Điều kiện lỗi cần xử lý | Lỗi rate limit 429, lỗi timeout 90s, lỗi định dạng JSON bị cắt cụt |

### Cách xác minh

```bash
npm run solve
npm run audit
```

- **Kết quả mong đợi:** 50 files JSON trong `output/` được sinh ra đúng schema.
- **Kết quả thực tế:** Hệ thống chạy trơn tru 50/50 cases, vượt qua audit không có mismatch nào.
- **Artifact/log:** `output/*.json`, `logging/trace.jsonl`

## 5. Một quyết định kỹ thuật quan trọng

- **Bối cảnh:** Lựa chọn cách xử lý lỗi và retry khi Specialist Agent hoặc Verifier trả về lỗi (Constraint violation).
- **Các phương án đã cân nhắc:**
  1. Dừng tiến trình ngay lập tức khi phát hiện lỗi validation và đánh dấu case đó là thất bại.
  2. Thực hiện cơ chế phản hồi lỗi (actionable feedback loop) quay lại LLM và cho phép retry tối đa N lần.
- **Phương án đã chọn:** Phương án 2.
- **Lý do:** Giúp hệ thống tự phục hồi mà không cần can thiệp thủ công, LLM nhận diện đúng lỗi ở lần chạy trước để tự sửa định dạng/facts. Đã chứng minh hiệu quả giúp tăng tỉ lệ qua test case lên 100%.

## 6. Một lỗi hoặc blocker đã xử lý

- **Triệu chứng/lỗi nguyên văn:** Lỗi rate limit (HTTP 429) và timeout khi chạy đồng thời hoặc gọi API Groq/OpenAI liên tiếp cho 50 test cases.
- **Lệnh hoặc bước tái hiện:** Chạy lệnh `npm run solve` liên tục nhiều case.
- **Nguyên nhân gốc:** Rate limit của API free tier rất thấp, việc gửi các request dồn dập khiến LLM trả về lỗi 429 hoặc timeout.
- **Cách xử lý:** Triển khai cơ chế exponential backoff và jitter trong `src/llm.js` (hàm `chat()`), tự động đọc header `retry-after` hoặc tìm kiếm `try again in ...s` trong thông báo lỗi để ngủ (sleep) một khoảng thời gian tương ứng trước khi retry.
- **Cách xác minh sau khi sửa:** Chạy lại `npm run solve` toàn bộ 50 cases liên tiếp mà không bị gián đoạn hay crash giữa chừng.

## 7. Hiểu biết về luồng end-to-end

1. Dữ liệu đi từ các file CSV Olist trong `data/` được load vào bộ nhớ thông qua `DataStore` trong `src/data.js`.
2. Khi nhận input JSON case, Coordinator gửi message giao task tới Customer Agent, Order Product Agent, Payment Agent, Delivery Agent.
3. Policy Agent nhận thông tin đã tổng hợp để áp dụng chính sách EC_POLICY_V2 và gọi LLM API.
4. Verifier Agent kiểm tra tính toàn vẹn của output, array limits, và kiểm chứng các evidence ID tồn tại trong CSV.
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
