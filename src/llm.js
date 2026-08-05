/**
 * Tầng gọi model thật qua API OpenAI-compatible /chat/completions.
 *
 * Agent gọi model để lập kế hoạch, điều tra, tạo policy verdict và verify. Tool chạy bằng code để
 * đọc dữ liệu/tính số, nhưng chính model phát hành JSON tool action. Final policy đến từ Policy LLM đã
 * qua constraint validation; không có deterministic answer fallback.
 *
 * API key đọc từ .env (KHÔNG commit). Tên model nằm ở config.js (README §9.4).
 */
import { readFileSync, existsSync } from 'fs';
import { API_KEY_ENV, BASE_URL, MODEL, PROVIDER, TEMPERATURE } from './config.js';

/** ponytail: .env chỉ có KEY=VALUE, không cần dotenv. */
export function loadEnv(path = '.env') {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

export const stats = { calls: 0, toolCalls: 0, retries: 0, promptTokens: 0, completionTokens: 0 };

// Test hook: production luôn để null; unit test có thể giả lập provider mà không gọi mạng.
let chatResponder = null;
export function setChatResponderForTests(responder) { chatResponder = responder; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_TRANSPORT_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_COMPLETION_TOKENS = 1500;

function providerErrorMessage(text) {
    try { return JSON.parse(text)?.error?.message || String(text).slice(0, 500); }
    catch { return String(text).slice(0, 500); }
}

async function retryTransport(body, attempt, error) {
    if (attempt >= MAX_TRANSPORT_RETRIES)
        throw new Error(`[llm] transport fail sau ${attempt + 1} lần: ${error.message}`);
    stats.retries++;
    await sleep(1000 * 2 ** attempt);
    return chat(body, attempt + 1);
}

/** Một lượt gọi model. Retry 429/5xx với backoff — free tier hay chạm rate limit. */
async function chat(body, attempt = 0) {
    if (chatResponder) {
        const message = await chatResponder(body);
        stats.calls++;
        return message;
    }

    const key = process.env[API_KEY_ENV];
    if (!key) throw new Error(`[llm] Thiếu ${API_KEY_ENV} trong .env — agent không gọi được model.`);

    let res;
    try {
        res = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
                ...(PROVIDER === 'openrouter' ? { 'X-Title': 'K4 Day 09 Multi-Agent A2A' } : {}),
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
                model: MODEL,
                temperature: TEMPERATURE,
                max_tokens: MAX_COMPLETION_TOKENS,
                ...(PROVIDER === 'openrouter' ? { reasoning: { enabled: false } } : {}),
                ...body,
            }),
        });
    } catch (error) {
        return retryTransport(body, attempt, error);
    }

    if (res.status === 429 || res.status >= 500) {
        let text;
        try { text = await res.text(); }
        catch (error) { return retryTransport(body, attempt, error); }
        if (attempt >= MAX_TRANSPORT_RETRIES)
            throw new Error(`[llm] ${res.status} sau ${attempt + 1} lần thử: ${providerErrorMessage(text)}`);
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const retryHint = Number(text.match(/try again in ([\d.]+)s/i)?.[1]) * 1000;
        const wait = retryAfter || retryHint || 2000 * 2 ** Math.min(attempt, 5);
        stats.retries++;
        await sleep(Math.min(wait + 1000, 45_000));
        return chat(body, attempt + 1);
    }
    if (!res.ok) {
        let text;
        try { text = await res.text(); }
        catch (error) { return retryTransport(body, attempt, error); }
        throw new Error(`[llm] ${res.status}: ${providerErrorMessage(text)}`);
    }

    let json;
    try { json = await res.json(); }
    catch (error) { return retryTransport(body, attempt, error); }
    if (!Array.isArray(json.choices) || !json.choices[0]?.message) {
        const detail = json.error?.message || json.message || JSON.stringify(json).slice(0, 1200);
        throw new Error(`[llm] provider response thiếu choices[0].message: ${detail}`);
    }
    stats.calls++;
    stats.promptTokens += json.usage?.prompt_tokens || 0;
    stats.completionTokens += json.usage?.completion_tokens || 0;
    return json.choices[0].message;
}

/**
 * Agent loop: model tự chọn tool bằng JSON action protocol, code thực thi đúng tool được chọn rồi
 * trả observation vào conversation. JSON protocol giữ hành vi nhất quán giữa các endpoint
 * OpenAI-compatible không đồng nhất native function calling. `requiredTools` chỉ là completeness guard.
 */
export async function runAgent({
    system, user, tools = [], impls = {}, requiredTools = [], maxSteps = 8,
}) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const toolTrace = [];

    if (tools.length) {
        const catalog = tools.map(t => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        }));
        messages.push({
            role: 'user',
            content: `TOOL_PROTOCOL\nAVAILABLE_TOOLS=${JSON.stringify(catalog)}\nREQUIRED_TOOLS=${JSON.stringify(requiredTools)}\n` +
                'Mỗi lượt chỉ trả một JSON action. Gọi tool: {"action":"tool","tool":"<name>","arguments":{}}. ' +
                'Sau khi đã điều tra đủ, kết luận: {"action":"final","result":<object đúng schema agent>}. ' +
                'Không đặt finding vào tool arguments.',
        });
    }

    for (let step = 0; step < maxSteps; step++) {
        const request = {
            messages,
            response_format: { type: 'json_object' },
        };
        const msg = await chat(request);
        const parsed = parseJson(msg.content);

        if (!tools.length) return { decision: parsed, toolTrace, errors: [] };

        messages.push({ role: 'assistant', content: msg.content ?? '{}' });

        if (parsed?.action === 'tool') {
            const name = parsed.tool;
            const fn = impls[name];
            if (!fn) {
                messages.push({
                    role: 'user',
                    content: `TOOL_ERROR: không có tool "${name}". Chỉ chọn trong AVAILABLE_TOOLS.`,
                });
                continue;
            }
            let out;
            try {
                out = fn(parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {});
            } catch (e) {
                out = { error: String(e.message) };
            }
            stats.toolCalls++;
            toolTrace.push({ tool: name, args: JSON.stringify(parsed.arguments || {}), output: out });
            messages.push({
                role: 'user',
                content: `TOOL_RESULT ${name}: ${JSON.stringify(out)}\nTiếp tục theo TOOL_PROTOCOL.`,
            });
            continue;
        }

        const decision = parsed?.action === 'final' ? parsed.result : parsed;
        if (decision) {
            const called = new Set(toolTrace.map(t => t.tool));
            const missing = requiredTools.filter(name => !called.has(name));
            if (missing.length) {
                messages.push({
                    role: 'user',
                    content: `Bạn chưa gọi tool bắt buộc: ${missing.join(', ')}. Hãy gọi tool còn thiếu trước khi kết luận.`,
                });
                continue;
            }
            return { decision, toolTrace, errors: [] };
        }

        messages.push({ role: 'user', content: 'JSON không đúng TOOL_PROTOCOL. Hãy trả action=tool hoặc action=final.' });
    }

    return {
        decision: null,
        toolTrace,
        errors: [`agent vượt quá ${maxSteps} bước hoặc chưa gọi đủ tool bắt buộc`],
    };
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        const m = String(text).match(/\{[\s\S]*\}/);   // model 8B đôi khi bọc JSON trong văn xuôi
        if (m) { try { return JSON.parse(m[0]); } catch { /* rơi xuống dưới */ } }
        return null;
    }
}
