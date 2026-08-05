# Architecture - Multi-Agent E-commerce Dispute Resolution

Hệ thống Multi-Agent được thiết kế dựa trên mô hình phân công chuyên môn hóa (Domain-Driven Multi-Agent Architecture) nhằm tự động hóa quy trình điều tra khiếu nại thương mại điện tử trên bộ dữ liệu Olist.

---

## 1. Sơ đồ Kiến trúc Tổng quan (System Architecture Diagram)

```mermaid
flowchart TD
    subgraph Input & Data Layer
        InputCase["Input Case (EC_xxx.json)"]
        CSVData["Olist CSV Datasets (9 files)"]
    end

    subgraph MCP Protocol (Model Context Protocol Layer)
        MCPServer["MCP Data Server (Pandas/SQLite Query Engine)"]
        CSVData <--> MCPServer
    end

    subgraph A2A Protocol (Agent-to-Agent Handoff Layer)
        Coordinator["Coordinator Agent (Orchestrator)"]
        
        CustomerAgent["Customer Domain Agent"]
        OrderProductAgent["Order & Product Agent"]
        PaymentAgent["Payment Domain Agent"]
        DeliveryAgent["Delivery Domain Agent"]
        PolicyAgent["Policy & Reasoning Agent"]
        VerifierAgent["Verifier Agent (Guardrail)"]
        
        InputCase --> Coordinator
        
        Coordinator -->|A2A Task Dispatch| CustomerAgent
        Coordinator -->|A2A Task Dispatch| OrderProductAgent
        Coordinator -->|A2A Task Dispatch| PaymentAgent
        Coordinator -->|A2A Task Dispatch| DeliveryAgent
        
        CustomerAgent <-->|MCP Tool Calls| MCPServer
        OrderProductAgent <-->|MCP Tool Calls| MCPServer
        PaymentAgent <-->|MCP Tool Calls| MCPServer
        DeliveryAgent <-->|MCP Tool Calls| MCPServer
        
        CustomerAgent -->|A2A State Response| Coordinator
        OrderProductAgent -->|A2A State Response| Coordinator
        PaymentAgent -->|A2A State Response| Coordinator
        DeliveryAgent -->|A2A State Response| Coordinator
        
        Coordinator -->|Unified Evidence Payload| PolicyAgent
        PolicyAgent -->|Policy Assessment| VerifierAgent
        VerifierAgent -->|Validated JSON Output| OutputFile["Output File (output/EC_xxx.json)"]
    end

    subgraph Observability & Audit Logging
        Coordinator -->|Structured Audit Event| TraceFile["trace.jsonl"]
        CustomerAgent -->|App Log| AppLog["logging/app.log"]
        OrderProductAgent -->|App Log| AppLog
        PaymentAgent -->|App Log| AppLog
        DeliveryAgent -->|App Log| AppLog
        PolicyAgent -->|App Log| AppLog
        VerifierAgent -->|App Log| AppLog
    end
```

---

## 2. Chi tiết các Agent và Phân vùng Quyền hạn (Agent Roles & Permissions)

| Agent | Vai trò & Trách nhiệm | Dữ liệu truy cập (MCP Server) | Giao thức áp dụng |
| :--- | :--- | :--- | :--- |
| **Coordinator Agent** | Lập lịch, điều phối công việc cho các domain agent, tổng hợp dữ liệu, ghi log audit `trace.jsonl`. | Không truy cập trực tiếp CSV | A2A Orchestrator |
| **Customer Domain Agent** | Xác định `customer_unique_id`, tra cứu lịch sử order (`related_order_ids`), phát hiện `repeat_customer`. | `orders.csv`, `customers.csv` | MCP Client / A2A Worker |
| **Order & Product Agent** | Kiểm tra danh sách item, seller, product ID, category name. Phát hiện `multi_item_order`, `multi_seller_order`, `multiple_categories`. | `order_items.csv`, `products.csv`, `sellers.csv`, `product_category_name_translation.csv` | MCP Client / A2A Worker |
| **Payment Domain Agent** | Thống kê dòng payment, tính tổng tiền đã trả, tính `expected_total_brl`, kiểm tra `difference_brl` & `reconciled`, phát hiện `split_payment`, `valid_split_payment`. | `order_payments.csv`, `order_items.csv` | MCP Client / A2A Worker |
| **Delivery Agent** | Tính độ trễ giao hàng `delivery_variance_hours`, độ trễ bàn giao seller `handoff_variance_hours`, xác định `late_handoff_seller_ids`. | `orders.csv`, `order_items.csv` | MCP Client / A2A Worker |
| **Policy & Reasoning Agent** | Áp dụng `EC_POLICY_V2` xếp hạng root cause, xác định responsible party, khoản refund, action và evidence IDs. | Không truy cập CSV (dùng Unified Context từ Coordinator) | A2A Worker / LLM Reasoning (<10B) |
| **Verifier Agent** | Kiểm tra schema, giới hạn mảng (max 5/3/20), xử lý null, kiểm tra số thập phân, ghi file đầu ra. | Không truy cập CSV | A2A Guardrail Worker |

---

## 3. Luồng Giao tiếp & Handoff (Communication & Handoff Flow)

1. **Khởi tạo (Initialization)**: Coordinator nhận file input `EC_xxx.json`, đọc `claimed_order_id`.
2. **Giai đoạn Thu thập Dữ liệu (Parallel/Sequential Domain Data Gathering)**:
   - Coordinator gửi `TaskRequest` tới **Customer Domain Agent** -> Nhận về thông tin khách hàng & lịch sử.
   - Coordinator gửi `TaskRequest` tới **Order & Product Agent** -> Nhận về items, sellers, products, categories.
   - Coordinator gửi `TaskRequest` tới **Payment Domain Agent** -> Nhận về đối soát thanh toán.
   - Coordinator gửi `TaskRequest` tới **Delivery Agent** -> Nhận về phân tích mốc thời gian và độ trễ.
3. **Giai đoạn Đánh giá Chính sách (Policy & Reasoning Handoff)**:
   - Coordinator tổng hợp 4 kết quả thành `Unified Evidence Payload` và gửi tới **Policy Agent**.
   - **Policy Agent** áp dụng thuật toán quyết định ưu tiên của `EC_POLICY_V2` (với LLM hỗ trợ kiểm tra lập luận) để suy ra:
     - `primary_issue` & `secondary_issues` (theo thứ tự nghiệp vụ chuẩn).
     - `ranked_causes` & `responsible_parties`.
     - `recommended_refund_brl` & `resolution_actions`.
     - Standardized `evidence_ids`.
4. **Giai đoạn Verification & Ghi Output**:
   - Result được handoff tới **Verifier Agent**.
   - **Verifier Agent** kiểm tra toàn bộ hard bounds, xử lý null theo quy tắc (ví dụ: đơn không có item thì `expected_total_brl`, `difference_brl`, `reconciled` bằng `null`).
   - Ghi file JSON vào `output/EC_xxx.json`.
5. **Ghi nhật ký Vết (Trace Audit Logging)**:
   - Coordinator ghi lại từng sự kiện chuyển giao agent vào file `trace.jsonl`.

---

## 4. Mô hình LLM & Cấu hình Logging

- **LLM Specification**: Mô hình dưới 10B parameters (ví dụ: `Qwen 2.5 7B Instruct` / `Gemma 2 9B` / `Llama 3.1 8B`).
- **Provider Support**: Hỗ trợ Groq API, Google AI Studio, OpenRouter, hoặc local Ollama backend (`http://localhost:11434`).
- **File Logging**:
  - `logging/app.log`: Nhật ký thực thi ứng dụng chi tiết (DEBUG, INFO, ERROR).
  - `trace.jsonl`: Nhật ký vết audit dạng JSON Lines ghi lại toàn bộ tương tác giữa các Agent qua từng case.
