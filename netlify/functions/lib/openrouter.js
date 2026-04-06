const DEFAULT_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MODEL_ALIASES = {
    // OpenRouter renamed this model slug in March 2026.
    'nvidia/nemotron-3-super:free': 'nvidia/nemotron-3-super-120b-a12b:free'
};

function normalizeModelName(model) {
    if (typeof model !== 'string' || !model.trim()) {
        return model;
    }

    const normalized = model.trim();
    return MODEL_ALIASES[normalized] || normalized;
}

const DEFAULT_MODEL = normalizeModelName(
    process.env.OPENROUTER_DEFAULT_MODEL || 'nvidia/nemotron-3-super:free'
);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS || '45000', 10);
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.OPENROUTER_MAX_TOKENS || '320', 10);

function parseMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter((part) => part && typeof part === 'object' && part.type === 'text')
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('\n')
            .trim();
    }

    return '';
}

function buildError(status, message, details) {
    const err = new Error(message);
    err.status = status;
    err.details = details;
    return err;
}

async function createChatCompletion({ model = DEFAULT_MODEL, messages, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw buildError(400, 'Chat messages are required');
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw buildError(500, 'OpenRouter API key is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    const requestModel = normalizeModelName(model || DEFAULT_MODEL);

    try {
        const response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: requestModel,
                messages,
                temperature: 0.2,
                max_tokens: DEFAULT_MAX_TOKENS
            }),
            signal: controller.signal
        });

        const elapsedMs = Date.now() - start;
        const contentType = response.headers.get('content-type') || '';
        let payload;

        if (contentType.includes('application/json')) {
            payload = await response.json();
        } else {
            payload = { raw: await response.text() };
        }

        if (!response.ok) {
            const apiMessage =
                (payload && payload.error && payload.error.message) ||
                payload.message ||
                'OpenRouter request failed';

            console.warn('[openrouter] non-2xx response', {
                status: response.status,
                model: requestModel,
                elapsedMs,
                error: apiMessage
            });

            throw buildError(502, apiMessage, { upstreamStatus: response.status });
        }

        const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
        const assistantContent = parseMessageContent(choice && choice.message && choice.message.content);

        if (!assistantContent) {
            throw buildError(502, 'OpenRouter returned an empty response');
        }

        console.info('[openrouter] completion ok', {
            status: response.status,
            model: payload.model || requestModel,
            elapsedMs
        });

        return {
            model: payload.model || requestModel,
            content: assistantContent,
            tokenUsage: payload.usage || null
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            throw buildError(504, 'OpenRouter request timed out');
        }

        if (typeof error.status === 'number') {
            throw error;
        }

        throw buildError(502, 'Failed to contact OpenRouter');
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    createChatCompletion,
    DEFAULT_MODEL
};
