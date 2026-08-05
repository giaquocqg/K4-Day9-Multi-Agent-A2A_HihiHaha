# Member Role Report — Day 9: Multi Agent A2A

## 1. Thông tin cá nhân

| Thông tin       | Nội dung     |
| --------------- | ------------ |
| Họ và tên       | Phạm Tấn Gia Quốc  |
| MSSV            | 01606       |
| Khóa/Lớp        | K4         |
| Vai trò chính   | Phân chia Agent (Coordinator)    |
| Model sử dụng   | gpt-4o-mini (OpenAI)             |
| Ngày hoàn thành | 2026-08-05 |

## 2. Vai trò và phạm vi công việc

### Phần việc sở hữu

| Module/deliverable | File/hàm phụ trách | Input nhận vào | Output bàn giao   | Trạng thái                            |
| ------------------ | ------------------ | -------------- | ----------------- | ------------------------------------- |
| Điều phối luồng xử lý (Orchestration) | `src/pipeline.js` / Lớp `Coordinator` | `case` JSON (Yêu cầu của KH) và dữ liệu CSV | `dossier` tổng hợp, JSON output cuối | Hoàn thành |
| Tổng hợp và kiểm tra chéo (Synthesis) | `src/pipeline.js` / `runCase` và `runAgent` | Outputs từ Customer, Order, Payment, Delivery | Facts thống nhất hoặc lỗi mâu thuẫn | Hoàn thành |

### Việc hỗ trợ ngoài phạm vi chính

| Hoạt động                 | Thành viên/module được hỗ trợ | Kết quả                 |
| ------------------------- | ----------------------------- | ----------------------- |
| Thiết kế cấu trúc giao tiếp | Nhóm (Tất cả Agent) | Định dạng chung `Handoff` struct giúp các module dễ truyền dữ liệu |

## 3. Kết quả theo vai trò

| Nhiệm vụ đã thực hiện | File/hàm/artifact liên quan | Kết quả bàn giao          | Cách xác minh   |
| --------------------- | --------------------------- | ------------------------- | --------------- |
| Xây dựng luồng gọi tuần tự cho 5 Agent | `Coordinator.investigate()` | Trace chi tiết ghi nhận từng bước handoff | Đọc file `trace.jsonl` |
| Ghép nối đánh giá Policy và Validation | `run_investigation.py` | JSON output tuân thủ EC_POLICY_V2 schema | Chạy script kiểm tra 50 test cases |

Nêu một output cụ thể mà phần việc của bạn tạo ra hoặc giúp xác minh:

Hệ thống coordinator đã gọi đúng các tác vụ xử lý thông tin, kết hợp được kết quả kiểm tra thanh toán và giao hàng, phát hiện các trường hợp claim vô lý và chốt được định dạng JSON chuẩn (gồm 50 file trong thư mục `output/`) mà không bị Verifier từ chối.

## 4. Giải thích phần kỹ thuật đã thực hiện

### Vấn đề cần giải quyết

Bài toán yêu cầu kết hợp thông tin từ nhiều nguồn (order, payment, delivery) mà mỗi phần xử lý độc lập. Vấn đề là cần một agent trung tâm (Coordinator) để phân chia dữ liệu, gọi các agent nhánh một cách chuẩn xác, và đối chiếu chéo (cross-check) để tránh mâu thuẫn trước khi đưa ra quyết định đền bù (Policy).

### Cách triển khai

Tôi đã thiết kế `Coordinator` như một Orchestrator trong Node.js. Nó nhận yêu cầu đầu vào và gọi các agent chuyên biệt (`customer`, `order_product`, `payment`, `delivery`) theo luồng tuần tự và độc lập (wave 1 và wave 2). Khi tất cả các agent hoàn thành đối soát dữ liệu và trả về kết quả qua đối tượng Handoff, Coordinator thực hiện gộp dữ liệu facts, evidence_ids và kiểm tra mâu thuẫn logic, sau đó chuyển giao hồ sơ hoàn chỉnh cho Policy Agent để đưa ra phán quyết cuối cùng.

### Input, output và contract

| Thành phần              | Mô tả                                  |
| ----------------------- | -------------------------------------- |
| Input                   | Yêu cầu của KH (case JSON) và Dataset (chứa dữ liệu CSV đã nạp vào bộ nhớ) |
| Output                  | Định dạng JSON chứa đánh giá cuối cùng (lưu vào thư mục `output/`) |
| Module phụ thuộc        | Các Specialist Agents (Customer, Order & Product, Payment, Delivery) |
| Module sử dụng output   | `Policy Agent` (nhận dossier) và `Verifier Agent` (để kiểm tra định dạng và tính hợp lệ) |
| Điều kiện lỗi cần xử lý | Phân tích mâu thuẫn dữ liệu thực tế với khiếu nại (ví dụ: giao hàng thực tế không muộn so với cam kết) |

### Cách xác minh

```bash
npm run solve
```

- **Kết quả mong đợi:** Hệ thống chạy thành công toàn bộ 50 case, tự động điều phối qua các Agent và xuất ra 50 file JSON trong thư mục `output/` mà không bị Verifier đánh chặn.
- **Kết quả thực tế:** Hệ thống chạy thành công 50/50 cases và lưu toàn bộ vết hoạt động (trace) chi tiết.
- **Artifact/log:** `output/` folder, `logging/trace.jsonl`, `logging/metadata.json`

## 5. Một quyết định kỹ thuật quan trọng

- **Bối cảnh:** Cần chọn phương pháp phân chia luồng làm việc giữa các Agent. Có hai hướng: để các Agent tự nói chuyện với nhau (LLM-based multi-agent framework) hay dùng deterministic orchestrator.
- **Các phương án đã cân nhắc:** (1) Dùng LangChain/AutoGen cho các agent giao tiếp tự do; (2) Dùng Python Coordinator thuần túy thu thập facts.
- **Phương án đã chọn:** (2) Dùng Python Coordinator (Deterministic logic) kết hợp DataStore.
- **Lý do:** Đối với Dispute Resolution, correctness (tính chính xác) và khả năng đối soát (reproducibility) với DB là tuyệt đối. Việc để LLM tự trích xuất và chuyển giao số tiền dễ gây ảo giác (hallucination) và sai lệch khoản hoàn (refund).
- **Bằng chứng quyết định phù hợp:** Script xử lý gọn gàng 50 json trong thời gian ngắn và toàn bộ dữ liệu tiền nong, evidence được nối chuẩn xác.

## 6. Một lỗi hoặc blocker đã xử lý

- **Triệu chứng/lỗi nguyên văn:** Khi chạy với model `gpt-4o-mini` của OpenAI, có **15/50 cases bị lỗi BLOCKED** ở khâu đánh giá Policy (Policy Context validation) do các mảng `secondary_issues` và `resolution_actions` bị lệch hoặc sai thứ tự so với checklist, hoặc bị lỗi parse JSON do phản hồi bị cắt cụt.
- **Lệnh hoặc bước tái hiện:** Chạy lệnh `npm run solve` với `LLM_PROVIDER=openai`.
- **Nguyên nhân gốc:**
  1. Lỗi phản hồi JSON bị cắt cụt: Biến cấu hình `MAX_COMPLETION_TOKENS` trong `src/llm.js` mặc định chỉ là `500` khiến các phản hồi chi tiết từ LLM cho các trường hợp phức tạp bị ngắt giữa chừng, gây lỗi cú pháp JSON.
  2. Lỗi logic phản hồi của Verifier/Validator: Phản hồi lỗi trả về cho mô hình ở các lượt retry quá chung chung (chỉ báo lỗi mâu thuẫn mà không đưa ra thông tin đối chiếu), khiến GPT-4o-mini không xác định được danh sách chính xác cần tạo và bị kẹt sau 2 lượt thử lại.
  3. Lỗi UnicodeDecodeError: Khi chạy script kiểm tra `tools/audit.py` trên hệ điều hành Windows, Python mặc định mở file bằng encoding CP1252 thay vì UTF-8, gây lỗi sập tiến trình khi đọc ký tự đặc biệt.
- **Cách xử lý:**
  1. Tăng `MAX_COMPLETION_TOKENS` trong `src/llm.js` từ `500` lên `1500` để đảm bảo LLM sinh đủ nội dung JSON.
  2. Chỉnh sửa hàm kiểm duyệt `validatePolicyContextCandidate` và `validatePolicyCoreCandidate` trong `src/agents.js` để in ra danh sách mong muốn chính xác trong chuỗi thông báo lỗi (ví dụ: `Cần có chính xác: [...]`). Khi nhận được feedback chi tiết này, LLM Agent tự động sửa lỗi và trả về dữ liệu khớp hoàn hảo ở lượt retry tiếp theo.
  3. Bổ sung `encoding="utf-8"` vào các hàm `open()` trong `tools/audit.py` để tương thích hoàn toàn trên môi trường Windows.
- **Cách xác minh sau khi sửa:** Chạy lại `npm run solve` đạt tỷ lệ thành công tuyệt đối 50/50 cases và `npm run audit` đạt 0 mismatches.
- **Điều học được:** Khi xây dựng quy trình kiểm duyệt (validation) trong hệ thống multi-agent, việc trả về phản hồi lỗi mang tính định hướng rõ ràng (actionable feedback) là cực kỳ quan trọng để mô hình nhỏ hoặc trung bình tự sửa lỗi thành công qua các lượt retry.

## 7. Hiểu biết về luồng end-to-end

**Câu trả lời:**

Bài lab K4 Day 9 là một hệ thống Multi-Agent mô phỏng quy trình xử lý khiếu nại (Dispute Resolution) trong thương mại điện tử dựa trên dữ liệu Olist.

Luồng end-to-end hoạt động như sau:
1. Input: Đọc file khiếu nại định dạng JSON chứa thông điệp của khách hàng và `claimed_order_id`.
2. Extract Data: `DataStore` tải trước toàn bộ dữ liệu bảng Olist từ file CSV vào in-memory để truy xuất nhanh.
3. Feature Extraction (Agents): Coordinator điều phối và gọi tuần tự 5 Agent (Customer, CustomerClaims, OrderProduct, Payment, Delivery). Mỗi agent chịu trách nhiệm đọc dữ liệu của domain tương ứng và trả về `Handoff` struct chứa facts và evidence.
4. Synthesis: Coordinator tổng hợp (synthesize) toàn bộ kết quả trả về, kiểm tra nếu có mâu thuẫn (như số lượng đơn hàng, item không khớp).
5. Policy Execution: `PolicyAgent` nhận thông tin đã tổng hợp và áp dụng các rule trong `EC_POLICY_V2` (chẳng hạn như trả hàng trễ do seller, hay thanh toán sai lệch) để quyết định issue chính, khoản tiền hoàn lại và các action.
6. Verification & Output: Coordinator chuyển tiếp kết quả sơ bộ sang cho `VerifierAgent` để validate lại tính đúng đắn của dữ liệu (số evidence tối đa, id format). Nếu đạt, file JSON cuối cùng được ghi vào thư mục `output/` kèm theo file `trace.jsonl` phản ánh lại toàn bộ luồng.

## 8. Cam kết của thành viên

Đánh dấu sau khi tự kiểm tra:

- [x] Nội dung báo cáo phản ánh đúng phần việc và mức hiểu của tôi.
- [x] Tôi có thể giải thích luồng end-to-end, không chỉ module mình phụ trách.
- [x] Tôi không ghi “đã chạy thành công” cho phần chưa được kiểm chứng.
- [x] Báo cáo không chứa `.env`, API key, token hoặc secret.
- [x] Báo cáo này không phải bản sao nguyên văn của báo cáo nhóm hoặc báo cáo thành viên khác.

**Họ và tên:** Phạm Tấn Gia Quốc
**Ngày xác nhận:** 2026-08-05
