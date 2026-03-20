import fs from 'fs';

class ErrorHandler {
    constructor() {
        this.messages = this.loadMessages();
    }

    loadMessages() {
        try {
            const data = fs.readFileSync('./error_messages.json', 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error loading error_messages.json:', error);
            // Returning an empty object will cause getMessage to fall back to the key name
            return {};
        }
    }

    getMessage(key, placeholders = {}) {
        let msg = this.messages[key];
        if (!msg) {
            console.warn(`[ErrorHandler] Missing message key: ${key}`);
            msg = this.messages['UNKNOWN_ERROR'] || '❌ Unknown Error';
        }
        for (const [k, v] of Object.entries(placeholders)) {
            msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
        }
        return msg;
    }

    createErrorResponse(error, blockReason = null, safetyRatings = null) {
        // Check for rate limit exhaustion first
        if (error && error.message && error.message.includes('All API keys exhausted due to rate limits')) {
            return this.getMessage('RATE_LIMIT_EXHAUSTED');
        }

        // Unified Pollinations Error Handling
        const pollMatch = error && error.message && error.message.match(/Pollinations(?: (Audio|Music|Video|Text))? HTTP (\d+)(?:: (.+))?/);
        if (pollMatch) {
            const modelType = pollMatch[1] || 'Image';
            const statusCode = parseInt(pollMatch[2], 10);
            const responseBody = pollMatch[3];
            let lowerBody = responseBody ? responseBody.toLowerCase() : error.message.toLowerCase();
            let lowerMessage = error.message.toLowerCase();

            let deepDetail = null;
            try {
                if (responseBody) {
                    const parsedBody = JSON.parse(responseBody);
                    if (parsedBody.error && typeof parsedBody.error.message === 'string' && parsedBody.error.message.startsWith('{')) {
                        deepDetail = JSON.parse(parsedBody.error.message);
                    }
                }
            } catch (e) { }

            const deepStatus = deepDetail?.detail?.status;

            if (deepStatus === 'input_text_empty') return this.getMessage('POLLINATIONS_AUDIO_EMPTY_INPUT');
            if (deepStatus === 'bad_prompt' || lowerBody.includes('terms of service')) return this.getMessage('POLLINATIONS_BAD_PROMPT');
            if (statusCode === 402 || lowerBody.includes('insufficient pollen') || lowerBody.includes('payment_required')) {
                return this.getMessage('POLLINATIONS_INSUFFICIENT_BALANCE');
            }

            if (lowerMessage.includes('image_prohibited_content') || lowerMessage.includes('image_safety') || lowerMessage.includes('content rejected') || lowerMessage.includes('prohibited') || lowerMessage.includes('safety') || (statusCode === 400 && lowerMessage.includes('gemini'))) {
                return this.getMessage('POLLINATIONS_CONTENT_BLOCKED');
            }

            if (statusCode === 521) return this.getMessage('POLLINATIONS_SERVER_DOWN');
            if (statusCode === 502) return this.getMessage('POLLINATIONS_BAD_GATEWAY');
            if (statusCode === 503 || statusCode === 500) return this.getMessage('POLLINATIONS_SERVER_ERROR');
            if (statusCode === 504) return this.getMessage('POLLINATIONS_GATEWAY_TIMEOUT');
            if (statusCode === 400) return this.getMessage('POLLINATIONS_BAD_REQUEST');
            if (statusCode === 429) return this.getMessage('POLLINATIONS_RATE_LIMITED');

            return this.getMessage('POLLINATIONS_GENERIC_ERROR', { modelType });
        }

        // Video upload failures
        if (error && error.message && error.message.includes('Video upload failed')) {
            const lowerMessage = error.message.toLowerCase();
            if (lowerMessage.includes('<none>') || lowerMessage.includes('empty')) return this.getMessage('VIDEO_UPLOAD_EMPTY');
            if (lowerMessage.includes('timeout')) return this.getMessage('VIDEO_UPLOAD_TIMEOUT');
            return this.getMessage('VIDEO_UPLOAD_FAILED');
        }

        // Video size errors
        if (error && error.message) {
            const lowerMsg = error.message.toLowerCase();
            if (lowerMsg.includes('video') && (lowerMsg.includes('too large') || lowerMsg.includes('size') || lowerMsg.includes('exceeds'))) {
                return this.getMessage('VIDEO_TOO_LARGE');
            }
        }

        // Fetch failures
        if (error && error.message === 'fetch failed') {
            if (error.cause) {
                const causeMessage = (error.cause.message || '').toLowerCase();
                if (causeMessage.includes('connect timeout') || causeMessage.includes('etimedout')) return this.getMessage('FETCH_TIMEOUT');
                if (causeMessage.includes('econnrefused')) return this.getMessage('FETCH_REFUSED');
                if (causeMessage.includes('enotfound')) return this.getMessage('FETCH_NOT_FOUND');
                if (causeMessage.includes('econnreset')) return this.getMessage('FETCH_RESET');
            }
            return this.getMessage('FETCH_NETWORK_ERROR');
        }

        // Timeout errors
        if (error && error.message) {
            const lowerMsg = error.message.toLowerCase();
            if (lowerMsg.includes('timeout') || lowerMsg.includes('etimedout') || lowerMsg.includes('timed out')) {
                return this.getMessage('REQUEST_TIMEOUT');
            }
            if (lowerMsg.includes('aborted') || error.name === 'AbortError') {
                return this.getMessage('REQUEST_ABORTED');
            }
        }

        // Image upload failures
        if (error && error.message && error.message.includes('Image upload failed')) {
            const lowerMessage = error.message.toLowerCase();
            if (lowerMessage.includes('<none>') || lowerMessage.includes('empty')) return this.getMessage('IMAGE_UPLOAD_EMPTY');
            if (lowerMessage.includes('bad gateway') || lowerMessage.includes('502')) return this.getMessage('IMAGE_UPLOAD_BAD_GATEWAY');
            if (lowerMessage.includes('service unavailable') || lowerMessage.includes('503')) return this.getMessage('IMAGE_UPLOAD_SERVICE_UNAVAILABLE');
            if (lowerMessage.includes('timeout')) return this.getMessage('IMAGE_UPLOAD_TIMEOUT');
            return this.getMessage('IMAGE_UPLOAD_FAILED');
        }

        // Image download/processing errors
        if (error && error.message) {
            const lowerMsg = error.message.toLowerCase();
            if (lowerMsg.includes('image') && (lowerMsg.includes('too large') || lowerMsg.includes('size') || lowerMsg.includes('exceeds'))) {
                return this.getMessage('IMAGE_TOO_LARGE');
            }
            if (lowerMsg.includes('image') || lowerMsg.includes('download')) {
                return this.getMessage('IMAGE_LOAD_ERROR');
            }
        }

        // Block reasons
        if (blockReason === 'PROHIBITED_CONTENT' || (error && error.message === "Safety block")) {
            return this.getMessage('CONTENT_BLOCKED');
        }

        // Safety ratings
        if (safetyRatings && safetyRatings.some(r => r.probability === 'HIGH' || r.probability === 'MEDIUM')) {
            console.error('Safety ratings from API:', JSON.stringify(safetyRatings, null, 2));
            const flaggedCategories = safetyRatings
                .filter(r => r.probability === 'HIGH' || r.probability === 'MEDIUM')
                .map(r => {
                    const raw = r.category || r.name || r.type || '';
                    if (typeof raw === 'string' && raw.length > 0) return raw.replace(/^HARM_CATEGORY_/, '');
                    return 'inappropriate content';
                }).join(', ');

            return this.getMessage('SAFETY_FILTER', { categories: flaggedCategories || 'unspecified content' });
        }

        // Permission Denied (Often triggered by restricted/copyrighted YouTube videos)
        if (error && error.message && (error.message.includes('PERMISSION_DENIED') || error.message.includes('caller does not have permission'))) {
            return this.getMessage('YOUTUBE_RESTRICTED');
        }

        // HTTP status code errors
        if (error && (error.status || error.code)) {
            const statusCode = error.status || error.code;
            switch (statusCode) {
                case 429: return this.getMessage('HTTP_429');
                case 401: return this.getMessage('HTTP_401');
                case 403: return this.getMessage('HTTP_403');
                case 400: return this.getMessage('HTTP_400');
                case 404: return this.getMessage('HTTP_404');
                case 500: case 502: case 503: return this.getMessage('HTTP_500');
                case 521: return this.getMessage('HTTP_521');
                case 504: return this.getMessage('HTTP_504');
                default: return this.getMessage('HTTP_UNKNOWN', { statusCode, message: error.message || 'Unknown error' });
            }
        }

        // Network / Parse errors
        if (error && error.message && error.message.toLowerCase().includes('network')) return this.getMessage('RENDER_NETWORK_ERROR');
        if (error && error.message && error.message.includes('JSON')) return this.getMessage('JSON_PARSE_ERROR');

        return this.getMessage('UNKNOWN_ERROR');
    }
}

export default ErrorHandler;