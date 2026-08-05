# Member Role Report — Day 9: Multi Agent A2A

## 1. Thông tin cá nhân

| Thông tin       | Nội dung     |
| --------------- | ------------ |
| Họ và tên       | Phạm Tấn Gia Quốc  |
| MSSV            | 01606       |
| Khóa/Lớp        | K4         |
| Vai trò chính   | Phân chia Agent (Coordinator)    |
| Ngày hoàn thành | 2026-08-05 |

## 2. Vai trò và phạm vi công việc

### Phần việc sở hữu

| Module/deliverable | File/hàm phụ trách | Input nhận vào | Output bàn giao   | Trạng thái                            |
| ------------------ | ------------------ | -------------- | ----------------- | ------------------------------------- |
| Điều phối luồng xử lý (Orchestration) | `run_investigation.py` / Lớp `Coordinator` | `case` JSON (Yêu cầu của KH) và dữ liệu CSV | `dossier` tổng hợp, JSON output cuối | Hoàn thành |
| Tổng hợp và kiểm tra chéo (Synthesis) | `run_investigation.py` / `Coordinator.synthesize()` | Outputs từ Customer, Order, Payment, Delivery | Facts thống nhất hoặc lỗi mâu thuẫn | Hoàn thành |

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

Tôi đã thiết kế `Coordinator` như một Orchestrator. Nó không dùng AI sinh chữ ngẫu nhiên mà gọi các class chuyên biệt (`CustomerAgent`, `CustomerClaimsAgent`, `OrderProductAgent`, `PaymentAgent`, `DeliveryAgent`) một cách tuần tự (deterministic). Khi tất cả agent trả về thông tin qua đối tượng `Handoff`, Coordinator dùng hàm `synthesize()` để gộp facts, evidence_ids và kiểm tra mâu thuẫn (VD: claim cho rằng order có 3 item nhưng DB chỉ có 2). Sau đó, nó mới đẩy cho `PolicyAgent`.

### Input, output và contract

| Thành phần              | Mô tả                                  |
| ----------------------- | -------------------------------------- |
| Input                   | Yêu cầu của KH (case JSON) và DataStore (chứa DB CSV in-memory) |
| Output                  | Dictionary chứa kết quả đánh giá cuối (lưu thành JSON vào `output/`) |
| Module phụ thuộc        | Customer, Order, Payment, Delivery Agents |
| Module sử dụng output   | `PolicyAgent` (nhận dossier) và `VerifierAgent` (nhận JSON draft) |
| Điều kiện lỗi cần xử lý | Mâu thuẫn logic giữa các agent (ví dụ sai lệch số lượng payment_rows), thiếu order ID thực tế |

### Cách xác minh

```bash
python run_investigation.py --case all
```

- **Kết quả mong đợi:** Script chạy qua 50 case, không văng lỗi mâu thuẫn nội bộ, sinh ra 50 file JSON chuẩn trong thư mục `output/`.
- **Kết quả thực tế:** Hệ thống tạo thành công 50 file và sinh ra `trace.jsonl` phản ánh luồng handoff hoàn hảo.
- **Artifact/log:** `output/` folder, `trace.jsonl`

## 5. Một quyết định kỹ thuật quan trọng

- **Bối cảnh:** Cần chọn phương pháp phân chia luồng làm việc giữa các Agent. Có hai hướng: để các Agent tự nói chuyện với nhau (LLM-based multi-agent framework) hay dùng deterministic orchestrator.
- **Các phương án đã cân nhắc:** (1) Dùng LangChain/AutoGen cho các agent giao tiếp tự do; (2) Dùng Python Coordinator thuần túy thu thập facts.
- **Phương án đã chọn:** (2) Dùng Python Coordinator (Deterministic logic) kết hợp DataStore.
- **Lý do:** Đối với Dispute Resolution, correctness (tính chính xác) và khả năng đối soát (reproducibility) với DB là tuyệt đối. Việc để LLM tự trích xuất và chuyển giao số tiền dễ gây ảo giác (hallucination) và sai lệch khoản hoàn (refund).
- **Bằng chứng quyết định phù hợp:** Script xử lý gọn gàng 50 json trong thời gian ngắn và toàn bộ dữ liệu tiền nong, evidence được nối chuẩn xác.

## 6. Một lỗi hoặc blocker đã xử lý

- **Triệu chứng/lỗi nguyên văn:** Điểm số đánh giá tổng hợp trên hệ thống bị kẹt ở mức 67-68% đồng đều trên tất cả các tiêu chí.
- **Lệnh hoặc bước tái hiện:** Kiểm tra các case có lượng lớn dữ liệu (nhiều hơn 5 item/payment) hoặc các case có yêu cầu bật/tắt `investigation_scope` trong JSON input.
- **Nguyên nhân gốc:** (1) Lỗi tính toán `multiple_categories` và `multi_seller_order` do mảng bị cắt (slice `[:5]`) TRƯỚC KHI Agent gom nhóm, làm thiếu thông tin. (2) Lỗi làm tròn số thập phân (rounding) quá sớm ở từng khoản nhỏ trong `PaymentAgent` gây sai số cộng dồn, dẫn đến bắt lỗi sai đối soát. (3) Các Agent không tôn trọng cấu hình `investigation_scope` (thiếu tính độc lập và kiểm chứng chéo).
- **Cách xử lý:** Sửa code `OrderProductAgent` để tính toán trên toàn bộ danh sách item trước, gán biến boolean, rồi mới slice kết quả đầu ra. Đưa việc làm tròn số (`number()`) về bước cuối cùng trong `PaymentAgent`. Bổ sung kiểm tra cấu hình scope để chủ động chặn output lịch sử mua hàng / sản phẩm nếu `investigation_scope` là false.
- **Cách xác minh sau khi sửa:** Chạy lại `python run_investigation.py --case all`, tái tạo lại toàn bộ file JSON chuẩn xác.
- **Điều học được:** Trong thiết kế Multi-Agent đối soát (Reconciliation), việc cắt tỉa evidence chỉ nên làm ở bước Handoff cho Coordinator, còn Agent nội bộ bắt buộc phải tính toán trên tập data đầy đủ để không đánh rơi các edge cases. Hơn nữa, việc làm tròn số khi đối soát tiền tệ cần hết sức cẩn trọng.

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
