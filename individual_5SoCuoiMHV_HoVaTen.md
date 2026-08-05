# Báo cáo cá nhân — Day 9 Multi-Agent A2A

## 1. Thông tin

| Thông tin | Nội dung |
| --- | --- |
| Họ và tên | Thái Hoài An |
| MSSV | 2A202601862 |
| Khóa/Lớp | K4 |
| Vai trò | Thiết kế agent pipeline, tools, policy validation, verifier và audit |
| Model | gpt-4o-mini qua OpenAI |

## 2. Kiến trúc đã triển khai

Hệ thống là một **agent-causal multi-agent pipeline**. Coordinator LLM đọc request/scope và tạo
task plan. Bốn specialist tự chọn tools qua JSON action protocol để điều tra từng domain. Policy LLM nhận
structured handoffs. Policy Core LLM tạo verdict chính; Policy Context LLM tạo secondary/actions
rồi runtime merge hai handoff. Verifier LLM tự gọi evidence/artifact tools
trước khi cho writer ghi file.

Code tất định được giới hạn ở data access, arithmetic và constraint validation. Production source
không có full policy solver và không có rules fallback. Model sai sau retry limit làm case fail
closed, không được thay bằng đáp án sinh từ code.

## 3. Ranh giới trách nhiệm

| Thành phần | Trách nhiệm |
| --- | --- |
| Coordinator LLM | Đọc message, scope, policy version; tạo task objectives và waves |
| Customer LLM | Gọi `lookup_customer`; phát hành repeat-customer finding |
| Order/Product LLM | Gọi status/items tools; phát hành multi-item/seller/category findings |
| Delivery LLM | Gọi timestamp/variance tools; phát hành late-delivery/handoff findings |
| Payment LLM | Gọi payment/reconcile tools; phát hành split/reconciled findings |
| Policy Core LLM | Tạo primary, cause, party IDs, refund, status, confidence |
| Policy Context LLM | Nhận core verdict + boolean checklist; tạo secondary issues và actions |
| Verifier LLM | Gọi validation tools; pass/reject artifact |
| Deterministic tools | Đọc CSV, join, cộng tiền, tính giờ, kiểm evidence/null/caps |
| Writer | Chỉ ghi case đã pass; xóa artifact cũ nếu case fail |

## 4. Tool calling và handoff

Tool catalog được gửi trong prompt. Model tự phát hành `action=tool`; runtime thực thi,
trả `TOOL_RESULT`, và chờ model phát hành `action=final`. Trace ghi agent, sender/receiver,
facts, evidence, missing, next step và danh sách tool model đã chọn.

Handoff là structured A2A-style message trong cùng process, chưa phải A2A network protocol. Dự án
chưa dùng MCP; local tools không được mô tả là MCP tools.

## 5. Retry và liêm chính

- Mỗi agent/mỗi pha Policy có tối đa 2 correction retries.
- Validator chỉ nêu constraint violation, không tạo hoặc cung cấp sẵn verdict đúng.
- Không có `policyAgent()` deterministic làm production fallback.
- Không có silent override.
- Groundtruth regression là manual-only và không được production runtime đọc.

## 6. Kiểm tra

```bash
npm test
LLM_PROVIDER=openai node src/run.js EC_001
LLM_PROVIDER=openai CONCURRENCY=8 npm run solve
npm run audit
```

Số liệu của lượt pipeline cũ không còn được dùng để mô tả implementation mới. `trace.jsonl` và
`metadata.json` phải được sinh lại từ full run mới trước khi nộp.

**Họ và tên:** Thái Hoài An
