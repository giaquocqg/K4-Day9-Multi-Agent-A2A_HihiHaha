# Member Role Report — Day 9: Multi Agent A2A

## 1. Thông tin cá nhân

| Thông tin | Nội dung |
| --- | --- |
| Họ và tên | Thái Hoài An |
| MSSV | 2A202601862 |
| Khóa/Lớp | K4 |
| Vai trò chính | Phân chia Agent và điều phối luồng xử lý (Coordinator) |
| Model sử dụng | Qwen3 8B qua OpenRouter; Llama 3.1 8B qua Groq dự phòng |
| Ngày hoàn thành | 2026-08-05 |

## 2. Vai trò và phạm vi công việc

### Phần việc sở hữu

| Module/deliverable | File/hàm phụ trách | Input | Output bàn giao | Trạng thái |
| --- | --- | --- | --- | --- |
| Lập kế hoạch điều tra | `src/agents-llm.js` / `llmCoordinatorAgent` | Case JSON, scope, policy version | Task objectives và execution waves | Hoàn thành |
| Điều phối pipeline | `src/pipeline.js` / `runCase` | Case JSON và dataset CSV | Structured handoffs, result hoặc lỗi fail-closed | Hoàn thành |
| Quản lý batch | `src/run.js` | Danh sách case và provider config | Worker pool, output, trace, metadata | Hoàn thành |
| Hợp nhất Policy | `src/agents-llm.js` / `llmPolicyAgent` | Findings từ bốn specialist | Core verdict, secondary issues, actions | Hoàn thành |

### Việc hỗ trợ ngoài phạm vi chính

| Hoạt động | Module được hỗ trợ | Kết quả |
| --- | --- | --- |
| Thiết kế giao tiếp | Toàn bộ agent pipeline | Chuẩn hóa `Handoff`: `from`, `to`, `facts`, `evidence`, `missing`, `note`, `next` |
| Fail-closed | Policy, Verifier, Writer | Case lỗi không ghi output và không giữ artifact cũ |
| Kiểm thử | Pipeline và tool loop | Xác minh Coordinator → specialists → Policy → Verifier, không fallback |

## 3. Kết quả theo vai trò

| Nhiệm vụ | File/hàm/artifact | Kết quả | Xác minh |
| --- | --- | --- | --- |
| Chia task cho bốn specialist | `llmCoordinatorAgent` | Customer, Order/Product, Delivery, Payment; Payment chạy sau Order/Product | `npm test`, `logging/trace.jsonl` |
| Tổ chức execution waves | `runCase` | Wave 1 chạy song song ba domain; wave 2 chạy Payment | Integration test pipeline |
| Chuyển findings sang Policy | `src/pipeline.js` | Facts và evidence được handoff có cấu trúc | Trace theo `case_id` và `agent` |
| Tách Policy thành hai pha | `llmPolicyAgent` | Policy Core tạo verdict; Policy Context tạo secondary/actions | Validators và integration test |

Output cụ thể được xác minh trong test `EC_001`: Coordinator phát hành đủ bốn task, specialist chọn đúng tool, Policy tạo candidate hợp lệ và Verifier chỉ cho phép ghi khi evidence/artifact pass.

## 4. Giải thích kỹ thuật

### Vấn đề

Các nguồn order, payment, delivery, product và customer độc lập; Payment phụ thuộc totals của Order/Product. Cần Coordinator để phân chia đúng domain, giữ dependency và chuyển dữ liệu thống nhất cho Policy.

### Cách triển khai

`llmCoordinatorAgent` là LLM thật, đọc request, scope và policy version rồi phát hành task plan. `runCase` là runtime orchestrator: Customer, Order/Product và Delivery chạy wave 1; Payment chạy wave 2 sau khi có item/freight totals.

Specialist tự chọn tool bằng JSON action protocol. Runtime chỉ thực thi tool được model chọn và trả `TOOL_RESULT`. Findings được validate trước handoff. Policy Core xử lý primary/cause/party/refund/status/confidence; Policy Context xử lý secondary issues/actions. Verifier LLM gọi các tool kiểm chứng trước Writer.

### Input, output và contract

| Thành phần | Mô tả |
| --- | --- |
| Input | Case JSON với `claimed_order_id`, customer message, scope, policy version và Olist CSV dataset |
| Output | JSON theo EC_POLICY_V2 hoặc `result=null` kèm errors |
| Module phụ thuộc | Bốn specialist và deterministic data/calculation tools |
| Module dùng output | Policy Core/Context, Verifier, Writer |
| Điều kiện lỗi | Order không tồn tại, finding mâu thuẫn tool, Policy sai contract, evidence giả, timeout/quota hoặc Verifier reject |

### Xác minh

```bash
npm test
LLM_PROVIDER=openrouter node src/run.js EC_001
LLM_PROVIDER=openrouter CONCURRENCY=6 npm run solve
npm run audit
```

10 test tự động pass và 1 groundtruth regression được để manual-only. Smoke test Qwen3 8B cho EC_001 đã chạy qua LLM/tool loop thật trong quá trình phát triển. Full 50 case phải được chạy lại sau khi provider có quota; không ghi nhận 50/50 khi chưa kiểm chứng.

## 5. Quyết định kỹ thuật quan trọng

- **Các phương án:** deterministic coordinator tính toàn bộ verdict; một LLM đọc toàn bộ dữ liệu; hoặc agent pipeline kết hợp LLM với deterministic tools.
- **Lựa chọn:** LLM Coordinator, specialist agents, Policy Core/Context và Verifier; deterministic code chỉ đọc dữ liệu, tính toán và validate.
- **Lý do:** Đáp ứng yêu cầu agent pipeline thật, đồng thời giữ độ chính xác cho tiền, timestamp và evidence. Không có `policyAgent()` deterministic làm fallback.
- **Giao tiếp:** Dùng A2A-style structured handoff trong cùng Node.js process; chưa dùng A2A network protocol hoặc MCP server/client.

## 6. Lỗi hoặc blocker đã xử lý

- **Lỗi:** Native function-calling không ổn định giữa các endpoint OpenAI-compatible; model 8B có lúc đưa finding vào tool arguments hoặc lặp Policy candidate sai.
- **Cách tái hiện:** Chạy smoke test provider thật trong giai đoạn dùng native tool schema.
- **Nguyên nhân:** Khác biệt provider khi kết hợp JSON mode với function calling và prompt Policy quá nhiều nhiệm vụ.
- **Cách xử lý:** Chuyển `runAgent` sang JSON action protocol; thêm `requiredTools`, timeout 90 giây, retry hữu hạn, fail-closed và tách Policy Core/Context.
- **Xác minh:** `npm test` pass 10 test; integration test ghi nhận đủ agent/tool actions và không có rules fallback.
- **Blocker còn lại:** Full run phụ thuộc API key, credit và daily token quota. Khi provider hết quota, hệ thống chặn case thay vì sinh output giả.

## 7. Luồng end-to-end

1. `loadCases` đọc case JSON và `loadDataset` nạp CSV/index.
2. Coordinator LLM lập task plan và execution waves.
3. Customer, Order/Product, Delivery chạy wave 1; mỗi agent tự chọn tool và tạo finding.
4. Payment chạy wave 2, đối soát payment với item + freight trong tolerance 0,10 BRL.
5. `runCase` ghi Handoff gồm facts, evidence, missing, note và next.
6. Policy Core chọn branch EC_POLICY_V2; Policy Context tạo secondary/actions.
7. Validators kiểm candidate; Schema Builder tạo output.
8. Verifier LLM gọi `validate_evidence` và `validate_artifact`.
9. Writer chỉ ghi case pass; case fail có `result=null` và loại artifact cũ.
10. Batch ghi `logging/trace.jsonl` và `logging/metadata.json`.

## 8. Cam kết

- [x] Báo cáo phản ánh đúng phần việc và mức hiểu của tôi.
- [x] Có thể giải thích end-to-end, không chỉ module Coordinator.
- [x] Không ghi thành công cho phần chưa được kiểm chứng.
- [x] Không chứa `.env`, API key, token hoặc secret.
- [x] Không sao chép nguyên văn báo cáo thành viên khác.

**Họ và tên:** Thái Hoài An  
**Mã thành viên:** 2A202601862  
**Ngày xác nhận:** 2026-08-05
