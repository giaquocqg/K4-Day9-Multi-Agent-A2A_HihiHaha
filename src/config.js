/**
 * Khai báo model + cổng chặn 10B.
 * README §9.4: TÊN model nằm trong source (giám khảo đọc ở đây), KHÔNG nằm trong .env.
 * .env chỉ chứa API key. Chọn provider qua biến môi trường LLM_PROVIDER khi chạy.
 *
 * Model này được gọi thật ở src/llm.js cho Coordinator, 4 specialists, Policy và Verifier.
 * Deterministic code chỉ thực thi tools và kiểm constraints; không sinh verdict thay model.
 */
const PROVIDERS = {
    groq: {
        model: 'llama-3.1-8b-instant',
        paramsB: 8,
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
    },
    openrouter: {
        model: 'qwen/qwen3-8b',
        paramsB: 8,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    openai: {
        model: 'gpt-4o-mini',
        paramsB: 8,
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
    },
    'openrouter-free': {
        model: 'openrouter/free',
        paramsB: 8,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
    },
};

export const PROVIDER = String(process.env.LLM_PROVIDER || 'groq').toLowerCase();
const selected = PROVIDERS[PROVIDER];
if (!selected) {
    throw new Error(`[config] Provider "${PROVIDER}" không hỗ trợ; chọn groq, openrouter, openai hoặc openrouter-free.`);
}

export const MODEL = selected.model;
export const PARAMS_B = selected.paramsB;
export const BASE_URL = selected.baseUrl;
export const API_KEY_ENV = selected.apiKeyEnv;
export const MAX_PARAMS_B = 10;

/** Nhiệt độ 0: cùng input phải ra cùng quyết định, để chạy lại còn tái lập được. */
export const TEMPERATURE = 0;

/** Số lần cho Policy Agent sửa candidate khi contract validation bác. */
export const MAX_POLICY_RETRIES = 2;

/** Đọc số tham số từ tên model: "llama-3.1-8b-instant" -> 8. */
export function parseParamsB(model) {
    const m = model.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/);
    return m ? parseFloat(m[1]) : null;
}

/** Cổng chặn cứng — ném lỗi thay vì lặng lẽ chạy model quá cỡ. */
export function assertUnder10B(model = MODEL, declaredB) {
    const params = declaredB ?? parseParamsB(model);
    if (params === null) {
        throw new Error(
            `[config] Không xác định được số tham số của "${model}". ` +
            `Khai báo PARAMS_B để giới hạn ${MAX_PARAMS_B}B còn kiểm chứng được.`
        );
    }
    if (params > MAX_PARAMS_B) {
        throw new Error(`[config] Model "${model}" là ${params}B — lab giới hạn ${MAX_PARAMS_B}B.`);
    }
    return params;
}
