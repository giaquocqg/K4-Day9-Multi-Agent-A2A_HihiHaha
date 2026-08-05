import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDataset } from './data.js';
import { runCase, writeArtifacts } from './pipeline.js';
import { setChatResponderForTests } from './llm.js';

test('runCase dùng đủ Coordinator → specialists/model-selected tools → Policy → Verifier, không rules fallback', async () => {
    const ds = loadDataset('data');
    const input = JSON.parse(fs.readFileSync('input/EC_001.json', 'utf8'));
    setChatResponderForTests(async body => {
        const system = body.messages[0].content;
        const toolResults = body.messages.filter(m => m.role === 'user' && m.content.startsWith('TOOL_RESULT'));
        const toolSequence = system.includes('Customer Agent') ? ['lookup_customer']
            : system.includes('Order & Product Agent') ? ['fetch_order_status', 'fetch_items']
                : system.includes('Delivery Agent') ? ['fetch_delivery_timestamps', 'compute_variances']
                    : system.includes('Payment Agent') ? ['fetch_payments', 'reconcile']
                        : system.includes('Verifier Agent') ? ['validate_evidence', 'validate_artifact']
                            : [];

        if (toolResults.length < toolSequence.length) {
            return { role: 'assistant', content: JSON.stringify({
                action: 'tool', tool: toolSequence[toolResults.length], arguments: {},
            }) };
        }
        if (system.includes('Coordinator Agent')) {
            return { role: 'assistant', content: JSON.stringify({
                tasks: [
                    { agent: 'customer', objective: 'Kiểm tra customer identity và lịch sử.' },
                    { agent: 'order_product', objective: 'Kiểm tra order, items, seller và category.' },
                    { agent: 'delivery', objective: 'Kiểm tra delivery và seller handoff.' },
                    { agent: 'payment', objective: 'Đối soát payment với order totals.' },
                ],
                execution_waves: [['customer', 'order_product', 'delivery'], ['payment']],
                rationale: 'Ba domain độc lập chạy trước; payment phụ thuộc order totals.',
            }) };
        }
        if (system.includes('Customer Agent'))
            return { role: 'assistant', content: '{"action":"final","result":{"is_repeat_customer":true,"note":"Có một order liên quan."}}' };
        if (system.includes('Order & Product Agent'))
            return { role: 'assistant', content: '{"action":"final","result":{"is_multi_item":true,"is_multi_seller":false,"is_multi_category":false,"note":"Hai item cùng seller/category."}}' };
        if (system.includes('Delivery Agent'))
            return { role: 'assistant', content: '{"action":"final","result":{"delivered_late":false,"has_late_seller_handoff":false,"note":"Giao trước estimated date."}}' };
        if (system.includes('Payment Agent'))
            return { role: 'assistant', content: '{"action":"final","result":{"is_split_payment":false,"reconciled":true,"note":"Payment khớp item + freight."}}' };
        if (system.includes('Policy Context Agent')) {
            return { role: 'assistant', content: JSON.stringify({
                secondary_issues: ['multi_item_order', 'repeat_customer'],
                resolution_actions: ['reject_late_refund'],
                reasoning: 'Quét đủ năm boolean theo thứ tự.',
            }) };
        }
        if (system.includes('Policy Agent')) {
            return { role: 'assistant', content: JSON.stringify({
                primary_issue: 'unsupported_late_claim',
                secondary_issues: ['multi_item_order', 'repeat_customer'],
                case_status: 'no_action', confidence: 0.94,
                cause_code: 'DELIVERY_WITHIN_ESTIMATE',
                responsible_party_type: null, responsible_party_ids: [],
                recommended_refund_brl: 0,
                resolution_actions: ['reject_late_refund'],
                reasoning: 'Delivery finding cho thấy đơn đúng hạn và payment đã khớp.',
            }) };
        }
        if (system.includes('Verifier Agent'))
            return { role: 'assistant', content: '{"action":"final","result":{"passed":true,"issues":[],"note":"Evidence và artifact đều hợp lệ."}}' };
        throw new Error(`Mock không nhận diện agent: ${system.slice(0, 80)}`);
    });

    try {
        const run = await runCase(input, ds);
        assert.deepEqual(run.errors, []);
        assert.equal(run.result.case_assessment.primary_issue, 'unsupported_late_claim');
        assert.equal(run.result.case_assessment.confidence, 0.94);
        assert.equal(run.handoffs.some(h => h.llm?.decided_by === 'rules_fallback'), false);
        const toolAgents = run.handoffs.filter(h => h.llm?.tools_called?.length).map(h => h.agent);
        assert.deepEqual(toolAgents, ['customer', 'order_product', 'delivery', 'payment', 'verifier']);
    } finally {
        setChatResponderForTests(null);
    }
});

test('writer fail-closed: case lỗi không được ghi và artifact cũ cùng case bị loại bỏ', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pipeline-test-'));
    const outDir = path.join(root, 'output');
    const logDir = path.join(root, 'logging');
    fs.mkdirSync(outDir);
    const stale = path.join(outDir, 'EC_999.json');
    fs.writeFileSync(stale, '{"stale":true}');
    try {
        const result = writeArtifacts([{
            caseId: 'EC_999', result: null, errors: ['policy validation failed'], handoffs: [],
            durationMs: 1, coordinatorRetries: 0, specialistRetries: 0, policyRetries: 2, verifierRetries: 0,
        }], outDir, logDir, { model: 'mock-8b' });
        assert.equal(result.written, 0);
        assert.equal(result.failed.length, 1);
        assert.equal(fs.existsSync(stale), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
