// public/js/runtime/api_client.js
// Typed REST client for Twitch Gemini AI Chatbot dashboard endpoints.

export class ApiClient {
    /**
     * @param {Object} [options]
     * @param {typeof fetch} [options.fetch] - Custom fetch implementation for Node/mock testing.
     * @param {string} [options.baseUrl] - Base URL prefix for API requests.
     */
    constructor(options = {}) {
        this._fetch = options.fetch || (typeof window !== 'undefined' ? window.fetch.bind(window) : globalThis.fetch);
        this._baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    }

    /**
     * Helper to perform fetch and parse JSON or text response.
     * @private
     */
    async _request(endpoint, options = {}) {
        const url = `${this._baseUrl}${endpoint}`;
        const res = await this._fetch(url, options);

        if (!res.ok) {
            let errorMessage = `HTTP error ${res.status} on ${endpoint}`;
            try {
                const data = await res.json();
                errorMessage = data.message || data.error || errorMessage;
            } catch {
                try {
                    const text = await res.text();
                    if (text) errorMessage = text;
                } catch {
                    // ignore secondary parse error
                }
            }
            const err = new Error(errorMessage);
            err.status = res.status;
            throw err;
        }

        const contentType = res.headers?.get?.('content-type') || '';
        if (contentType.includes('application/json')) {
            return res.json();
        }
        return res.text();
    }

    /**
     * Fetches list of joined Twitch channels.
     * @returns {Promise<string[]>}
     */
    async fetchChannels() {
        return this._request('/api/channels');
    }

    /**
     * Fetches authorization and bot status per channel.
     * @returns {Promise<Record<string, { channel: string, authorized: boolean, isBot: boolean }>>}
     */
    async fetchChannelStatuses() {
        try {
            return await this._request('/api/channel-status');
        } catch (err) {
            console.warn('[ApiClient] Failed to fetch channel status:', err.message);
            return {};
        }
    }

    /**
     * Fetches unified emote dictionary for a given channel.
     * @param {string} channel
     * @returns {Promise<Record<string, { url: string, provider: string }>>}
     */
    async fetchEmotes(channel) {
        const safe = String(channel || '').replace(/^#/, '');
        return this._request(`/api/emotes/${encodeURIComponent(safe)}`);
    }

    /**
     * Fetches recent chat message logs for a given channel.
     * @param {string} channel
     * @returns {Promise<Array<{ timestamp: string|number, username: string, message: string, meta?: any }>>}
     */
    async fetchChat(channel) {
        const safe = String(channel || '').replace(/^#/, '');
        return this._request(`/api/chat/${encodeURIComponent(safe)}`);
    }

    /**
     * Fetches media gallery item logs.
     * @returns {Promise<Array<any>>}
     */
    async fetchMedia() {
        return this._request('/api/media');
    }

    /**
     * Fetches full bot configuration (Admin only).
     * @returns {Promise<Object>}
     */
    async fetchConfig() {
        return this._request('/api/config');
    }

    /**
     * Saves a specific configuration category (Admin only).
     * @param {string} type - 'system_instructions' | 'custom_commands' | 'event_alerts' | 'error_messages'
     * @param {any} value - Configuration value payload
     * @returns {Promise<{ value: any, override: boolean, message?: string }>}
     */
    async saveConfig(type, value) {
        return this._request(`/api/config/${encodeURIComponent(type)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });
    }

    /**
     * Resets a specific configuration category to factory presets (Admin only).
     * @param {string} type - 'system_instructions' | 'custom_commands' | 'event_alerts' | 'error_messages'
     * @returns {Promise<{ value: any, override: boolean, message?: string }>}
     */
    async resetConfig(type) {
        return this._request(`/api/config/${encodeURIComponent(type)}/reset`, {
            method: 'POST'
        });
    }

    /**
     * Generates a live AI response for testing prompts via Gemini.
     * @param {string} promptText
     * @returns {Promise<string>}
     */
    async generateAiTestResponse(promptText) {
        return this._request(`/gemini/${encodeURIComponent(promptText)}`);
    }
}
