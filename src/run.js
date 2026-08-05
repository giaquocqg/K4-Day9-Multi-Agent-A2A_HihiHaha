#!/usr/bin/env node
/**
 * Chạy 50 case qua Coordinator + 4 specialist + Policy Core/Context + Verifier LLM agents.
 *
 *   echo "GROQ_API_KEY=gsk_..." > .env
 *   node src/run.js              # cả 50 case qua Groq
 *   LLM_PROVIDER=openrouter node src/run.js  # dùng OPENROUTER_API_KEY trong .env
 *   node src/run.js EC_001       # 1 case, để thử trước khi đốt quota
 *
 * CONCURRENCY: số case chạy song song; điều chỉnh theo rate limit của provider.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadDataset } from './data.js';
import { loadCases, runCase, writeArtifacts } from './pipeline.js';
import { API_KEY_ENV, MODEL, PARAMS_B, PROVIDER, assertUnder10B } from './config.js';
import { loadEnv, stats } from './llm.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] || null;
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const t0 = Date.now();

loadEnv(join(repo, '.env'));
const paramsB = assertUnder10B(MODEL, PARAMS_B); // gate 10B chạy trước mọi thứ khác
if (!process.env[API_KEY_ENV]) {
    console.error(`Thiếu ${API_KEY_ENV}. Thêm key này vào file .env ở gốc repo.\n(.env KHÔNG được commit — README §9.4)`);
    process.exit(2);
}

const ds = loadDataset(join(repo, 'data'));
const allCases = loadCases(join(repo, 'input'));
const cases = only ? allCases.filter(c => c.case_id === only) : allCases;
if (!cases.length) { console.error(`Không có case nào khớp "${only}"`); process.exit(2); }

console.log(`model=${MODEL} (${paramsB}B) · ${cases.length} case · song song ${CONCURRENCY}`);

/** ponytail: worker pool 10 dòng, đủ để giữ rate limit. Thêm queue lib khi nào cần ưu tiên. */
const runs = new Array(cases.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, async () => {
    while (next < cases.length) {
        const i = next++;
        const started = Date.now();
        try {
            runs[i] = await runCase(cases[i], ds);
        } catch (error) {
            // Fail closed theo từng case: provider/runtime error không được làm sập cả batch.
            runs[i] = {
                caseId: cases[i].case_id,
                orderId: cases[i].customer_request?.claimed_order_id || null,
                result: null,
                errors: [`runtime: ${error.message}`],
                handoffs: [],
                coordinatorRetries: 0, specialistRetries: 0, policyRetries: 0, verifierRetries: 0,
                durationMs: Date.now() - started,
            };
        }
        process.stdout.write(`\r  ${runs.filter(Boolean).length}/${cases.length} case`);
    }
}));
console.log('');

const a = writeArtifacts(runs, join(repo, 'output'), join(repo, 'logging'), {
    cohort: 'K4',
    policy_version: 'EC_POLICY_V2',
    model: MODEL,
    parameter_size: `${paramsB}B`,
    provider: PROVIDER,
    llm_role: 'causal agent pipeline — Coordinator lập task plan; specialists tự gọi tools; Policy Core/Context tạo verdict; Verifier tự gọi validation tools; không rules fallback',
    framework: 'custom A2A-style multi-agent pipeline (Node ESM, zero deps) with model-selected JSON tool actions',
    runtime: `node ${process.version}`,
    llm_calls: stats.calls,
    llm_tool_calls: stats.toolCalls,
    llm_rate_limit_retries: stats.retries,
    llm_prompt_tokens: stats.promptTokens,
    llm_completion_tokens: stats.completionTokens,
});

console.log(`cases=${runs.length} written=${a.written} flagged=${a.flagged.length} failed=${a.failed.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`llm: ${stats.calls} call · ${stats.toolCalls} tool call · ${stats.retries} rate-limit retry · ${stats.promptTokens + stats.completionTokens} token`);
console.log(`agent retries: coordinator=${runs.reduce((s, r) => s + (r?.coordinatorRetries || 0), 0)} · specialist=${runs.reduce((s, r) => s + (r?.specialistRetries || 0), 0)} · policy=${runs.reduce((s, r) => s + (r?.policyRetries || 0), 0)} · verifier=${runs.reduce((s, r) => s + (r?.verifierRetries || 0), 0)} · rules fallback=0`);
for (const f of a.flagged) console.warn('  FLAGGED', f);
for (const f of a.failed) console.error('  BLOCKED', f);
console.log('artifacts: output/ · logging/trace.jsonl · logging/metadata.json');

if (a.written !== cases.length) console.warn('⚠️  Thiếu file output — sửa agent/policy, đừng sửa tay JSON.');
process.exit(a.failed.length ? 1 : 0);
