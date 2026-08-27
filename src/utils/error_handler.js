// src/utils/error_handler.js
import { FACTORY } from './bot_config.js';

const HARD_FALLBACK = '❌ Unknown Error';
const INFO_CATEGORY = 'info';
const RETRYABLE_CATEGORIES = new Set(['quota', 'network', 'server']);

const KEY_CATEGORY = {
    RATE_LIMIT_EXHAUSTED: 'quota',
    HTTP_429: 'quota',
    POLLINATIONS_RATE_LIMITED: 'quota',

    CONTENT_BLOCKED: 'safety',
    SAFETY_FILTER: 'safety',

    FETCH_TIMEOUT: 'network',
    FETCH_REFUSED: 'network',
    FETCH_NOT_FOUND: 'network',
    FETCH_RESET: 'network',
    FETCH_NETWORK_ERROR: 'network',
    REQUEST_TIMEOUT: 'network',
    REQUEST_ABORTED: 'network',
    RENDER_NETWORK_ERROR: 'network',

    HTTP_500: 'server',
    HTTP_521: 'server',
    HTTP_504: 'server',
    GEMINI_EMPTY_RESPONSE: 'server',
    POLLINATIONS_SERVER_DOWN: 'server',
    POLLINATIONS_BAD_GATEWAY: 'server',
    POLLINATIONS_GATEWAY_TIMEOUT: 'server',
    POLLINATIONS_GENERIC_ERROR: 'server',
    MEDIA_NO_DATA: 'server',
    MEDIA_PROVIDER_UNAVAILABLE: 'server',
    MEDIA_MODEL_UNAVAILABLE: 'validation',
    VIDEO_UPLOAD_EMPTY: 'server',
    VIDEO_UPLOAD_TIMEOUT: 'server',
    VIDEO_UPLOAD_FAILED: 'server',
    AUDIO_UPLOAD_EMPTY: 'server',
    AUDIO_UPLOAD_BAD_GATEWAY: 'server',
    AUDIO_UPLOAD_SERVICE_UNAVAILABLE: 'server',
    AUDIO_UPLOAD_TIMEOUT: 'server',
    AUDIO_UPLOAD_FAILED: 'server',
    IMAGE_UPLOAD_EMPTY: 'server',
    IMAGE_UPLOAD_BAD_GATEWAY: 'server',
    IMAGE_UPLOAD_SERVICE_UNAVAILABLE: 'server',
    IMAGE_UPLOAD_TIMEOUT: 'server',
    IMAGE_UPLOAD_FAILED: 'server',

    HTTP_401: 'auth',
    HTTP_403: 'auth',
    YOUTUBE_RESTRICTED: 'auth',
    BOT_NOT_MODERATOR: 'auth',
    BROADCASTER_AUTH_REQUIRED: 'auth',
    BOT_SCOPE_MISSING: 'auth',
    POLL_UNAVAILABLE: 'validation',
    PREDICTION_UNAVAILABLE: 'validation',
    HELIX_ACTION_TIMEOUT: 'network',
    HELIX_ACTION_FAILED: 'server',

    HTTP_400: 'client',
    HTTP_404: 'client',
    HTTP_UNKNOWN: 'client',
    POLLINATIONS_BAD_REQUEST: 'client',
    JSON_PARSE_ERROR: 'client',
    IMAGE_LOAD_ERROR: 'client',
    IMAGE_TOO_LARGE: 'client',
    VIDEO_TOO_LARGE: 'client',

    COOLDOWN_ACTIVE: 'validation',
    MEDIA_PROMPT_REQUIRED: 'validation',

    MEDIA_FALLBACK_RESPONSE: INFO_CATEGORY,
    UNKNOWN_ERROR: 'unknown'
};

const KEY_STATUS = {
    HTTP_429: 429,
    RATE_LIMIT_EXHAUSTED: 429,
    POLLINATIONS_RATE_LIMITED: 429,
    HTTP_401: 401,
    HTTP_403: 403,
    HTTP_400: 400,
    POLLINATIONS_BAD_REQUEST: 400,
    HTTP_404: 404,
    HTTP_500: 500,
    HTTP_521: 521,
    POLLINATIONS_SERVER_DOWN: 521,
    HTTP_504: 504,
    POLLINATIONS_GATEWAY_TIMEOUT: 504,
    POLLINATIONS_BAD_GATEWAY: 502
};

const HTTP_STATUS_TO_KEY = {
    429: 'HTTP_429',
    401: 'HTTP_401',
    403: 'HTTP_403',
    400: 'HTTP_400',
    404: 'HTTP_404',
    500: 'HTTP_500',
    502: 'HTTP_500',
    503: 'HTTP_500',
    521: 'HTTP_521',
    504: 'HTTP_504'
};

const NETWORK_CODE_TO_KEY = {
    ETIMEDOUT: 'FETCH_TIMEOUT',
    UND_ERR_CONNECT_TIMEOUT: 'FETCH_TIMEOUT',
    UND_ERR_HEADERS_TIMEOUT: 'FETCH_TIMEOUT',
    UND_ERR_BODY_TIMEOUT: 'FETCH_TIMEOUT',
    ECONNREFUSED: 'FETCH_REFUSED',
    ENOTFOUND: 'FETCH_NOT_FOUND',
    EAI_AGAIN: 'FETCH_NOT_FOUND',
    ECONNRESET: 'FETCH_RESET',
    UND_ERR_SOCKET: 'FETCH_RESET',
    EPIPE: 'FETCH_RESET',
    ERR_CANCELED: 'REQUEST_ABORTED',
    ABORT_ERR: 'REQUEST_ABORTED'
};

function defaultFileReader(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function oneLine(value) {
    return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function sanitizeParam(value) {
    const text = oneLine(value);
    return text.length > 180 ? text.slice(0, 180) : text;
}

function interpolate(template, params) {
    let out = String(template ?? '');
    if (!params || typeof params !== 'object') return oneLine(out);
    for (const [key, value] of Object.entries(params)) {
        out = out.split(`{${key}}`).join(sanitizeParam(value));
    }
    return oneLine(out);
}

function safetyCategoryName(rating) {
    const raw = String(rating?.category || rating?.name || rating?.type || '');
    const prefix = 'HARM_CATEGORY_';
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
    return raw || 'inappropriate content';
}

function flaggedSafetyCategories(safetyRatings) {
    if (!Array.isArray(safetyRatings)) return [];
    return safetyRatings
        .filter((rating) => rating?.probability === 'HIGH' || rating?.probability === 'MEDIUM')
        .map(safetyCategoryName);
}

function readStatus(input) {
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object') return null;
    if (typeof input.status === 'number') return input.status;
    if (typeof input.code === 'number') return input.code;
    return null;
}

function readNetworkCode(input) {
    if (!input || typeof input !== 'object') return null;
    const candidates = [input.code, input.errno, input.cause?.code, input.cause?.errno];
    for (const code of candidates) {
        if (typeof code === 'string' && code) return code;
    }
    return null;
}

function metaFor(key, overrides = {}) {
    const category = overrides.category || KEY_CATEGORY[key] || 'unknown';
    const retryable = typeof overrides.retryable === 'boolean'
        ? overrides.retryable
        : RETRYABLE_CATEGORIES.has(category);
    const status = overrides.status ?? KEY_STATUS[key] ?? null;
    return { key, category, retryable, status };
}

export class BotError extends Error {
    /**
     * Structured domain failure. Throw this from subsystems; pass it to format/classify.
     * @param {string} key Canonical catalog key
     * @param {object} [options]
     */
    constructor(key, {
        message = '',
        status = null,
        retryable = null,
        category = null,
        cause = null,
        params = {}
    } = {}) {
        const resolvedKey = String(key || 'UNKNOWN_ERROR');
        super(message || resolvedKey);
        this.name = 'BotError';
        this.key = resolvedKey;
        this.status = status;
        this.retryable = retryable;
        this.category = category;
        this.cause = cause;
        this.params = params && typeof params === 'object' ? params : {};
    }
}

export class ErrorHandler {
    #failureExact = new Set();
    #failurePrefixes = [];

    /**
     * @param {object} [options]
     * @param {Record<string, string>|null} [options.messages] In-memory dictionary
     */
    constructor({
        messages = null
    } = {}) {
        this.messages = { ...FACTORY.error_messages, ...(messages && typeof messages === 'object' ? messages : {}) };
        this.#indexCatalog();
    }

    reload(messages) {
        this.messages = { ...FACTORY.error_messages, ...(messages || {}) };
        this.#indexCatalog();
    }

    #indexCatalog() {
        this.#failureExact = new Set();
        this.#failurePrefixes = [];
        for (const [key, template] of Object.entries(this.messages)) {
            if ((KEY_CATEGORY[key] || 'unknown') === INFO_CATEGORY) continue;
            const text = oneLine(template);
            if (!text) continue;
            const brace = text.indexOf('{');
            if (brace === -1) {
                this.#failureExact.add(text);
            } else {
                const prefix = text.slice(0, brace).trim();
                if (prefix.length >= 6) this.#failurePrefixes.push(prefix);
            }
        }
    }

    #lookupMessage(key, params) {
        const template = this.messages[key];
        if (typeof template === 'string' && template) {
            return interpolate(template, params);
        }
        if (key !== 'UNKNOWN_ERROR') {
            console.warn(`[ErrorHandler] Missing message key: ${key}`);
            const fallback = this.messages.UNKNOWN_ERROR;
            if (typeof fallback === 'string' && fallback) {
                return interpolate(fallback, params);
            }
        }
        return HARD_FALLBACK;
    }

    #descriptor(key, params, overrides = {}) {
        const meta = metaFor(key, overrides);
        return {
            key: meta.key,
            category: meta.category,
            retryable: meta.retryable,
            status: meta.status,
            message: this.#lookupMessage(meta.key, params)
        };
    }

    #classifyUnsafe(input, params = {}) {
        if (input == null || input === '') {
            return this.#descriptor('UNKNOWN_ERROR', params);
        }

        if (input instanceof BotError) {
            return this.#descriptor(input.key, { ...input.params, ...params }, {
                category: input.category,
                retryable: input.retryable,
                status: input.status
            });
        }

        if (typeof input === 'number') {
            const key = HTTP_STATUS_TO_KEY[input] || 'HTTP_UNKNOWN';
            return this.#descriptor(key, { ...params, statusCode: input }, { status: input });
        }

        if (typeof input === 'string') {
            if (this.messages[input]) return this.#descriptor(input, params);
            return this.#descriptor('UNKNOWN_ERROR', params);
        }

        if (typeof input !== 'object') {
            return this.#descriptor('UNKNOWN_ERROR', params);
        }

        if (input.cause instanceof BotError) {
            return this.#classifyUnsafe(input.cause, params);
        }

        const explicitKey = (typeof input.errorKey === 'string' && input.errorKey)
            || (typeof input.key === 'string' && input.key)
            || null;
        if (explicitKey && (this.messages[explicitKey] || KEY_CATEGORY[explicitKey])) {
            return this.#descriptor(explicitKey, { ...input.params, ...params }, {
                category: input.category,
                retryable: input.retryable,
                status: input.status
            });
        }

        const blockReason = input.blockReason || input.promptFeedback?.blockReason || null;
        const safetyRatings = input.safetyRatings
            || input.candidates?.[0]?.safetyRatings
            || null;
        const finishReason = input.finishReason || input.candidates?.[0]?.finishReason || null;
        const flagged = flaggedSafetyCategories(safetyRatings);

        if (blockReason) {
            return this.#descriptor('CONTENT_BLOCKED', params);
        }
        if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY' || flagged.length > 0) {
            if (flagged.length > 0) {
                console.error('[ErrorHandler] Safety ratings:', flagged.join(', '));
            }
            return this.#descriptor('SAFETY_FILTER', {
                ...params,
                categories: flagged.join(', ') || 'unspecified content'
            });
        }
        if (input.blocked === true || input.safetyBlocked === true) {
            return this.#descriptor('CONTENT_BLOCKED', params);
        }
        if (input.message === 'Safety block' || input.message === 'Content blocked') {
            return this.#descriptor('CONTENT_BLOCKED', params);
        }

        if (input.status === 403 && (input.code === 'PERMISSION_DENIED' || input.message === 'PERMISSION_DENIED')) {
            return this.#descriptor('YOUTUBE_RESTRICTED', params, { status: 403 });
        }

        const status = readStatus(input);
        if (typeof status === 'number' && status >= 400) {
            const key = HTTP_STATUS_TO_KEY[status] || 'HTTP_UNKNOWN';
            return this.#descriptor(key, {
                ...params,
                statusCode: status,
                message: sanitizeParam(input.message || 'Unknown error')
            }, { status });
        }

        if (input.name === 'AbortError') {
            return this.#descriptor('REQUEST_ABORTED', params);
        }

        const networkCode = readNetworkCode(input);
        if (networkCode && NETWORK_CODE_TO_KEY[networkCode]) {
            return this.#descriptor(NETWORK_CODE_TO_KEY[networkCode], params);
        }

        if (input.message === 'fetch failed') {
            if (input.cause) return this.#classifyUnsafe(input.cause, params);
            return this.#descriptor('FETCH_NETWORK_ERROR', params);
        }

        return this.#descriptor('UNKNOWN_ERROR', params);
    }

    /**
     * Structured descriptor for control flow (key rotation, fallbacks). Never throws.
     * @returns {{ key: string, category: string, retryable: boolean, status: number|null, message: string }}
     */
    classify(input, params = {}) {
        try {
            return this.#classifyUnsafe(input, params);
        } catch (error) {
            console.error('[ErrorHandler] classify failed:', error?.message || error);
            return {
                key: 'UNKNOWN_ERROR',
                category: 'unknown',
                retryable: false,
                status: null,
                message: this.messages.UNKNOWN_ERROR || HARD_FALLBACK
            };
        }
    }

    /**
     * Chatter-safe single-line string. Accepts BotError, catalog keys, HTTP statuses,
     * Node/Gemini objects, or already-structured descriptors. Never throws.
     */
    format(input, params = {}) {
        try {
            return this.classify(input, params).message;
        } catch {
            return HARD_FALLBACK;
        }
    }

    /**
     * Semantic failure/block predicate. No caller-side catalog scraping.
     */
    isFailure(result) {
        try {
            if (result == null) return true;
            if (result instanceof BotError) return true;
            if (typeof result === 'object') {
                if (result.blocked === true || result.safetyBlocked === true) return true;
                if (result.key && KEY_CATEGORY[result.key] && KEY_CATEGORY[result.key] !== INFO_CATEGORY) {
                    return true;
                }
                if (result.promptFeedback?.blockReason || result.blockReason) return true;
                const finishReason = result.finishReason || result.candidates?.[0]?.finishReason;
                if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY') return true;
                if ('text' in result && !String(result.text || '').trim()) return true;
                return false;
            }
            if (typeof result !== 'string') return false;
            const text = oneLine(result);
            if (!text) return true;
            if (this.#failureExact.has(text)) return true;
            return this.#failurePrefixes.some((prefix) => text.startsWith(prefix));
        } catch {
            return true;
        }
    }
}

export default ErrorHandler;
