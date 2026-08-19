// public/js/views/config/errors_tab.js
// Sub-view managing Chatter-Facing Error Catalogs and Security Gate.

import { escapeHtml } from '../../utils/web_emotes.js';
import { attachSyntaxHighlighter, insertTokenAtCursor } from '../../utils/syntax_highlighter.js';

export const FACTORY_ERRORS = {
    RATE_LIMIT_EXHAUSTED: '⏰ All API keys rate limited. Try again tomorrow.',
    GEMINI_EMPTY_RESPONSE: "🔭 Empty Response. Google's servers are having issues. Try again in 30 seconds.",
    POLLINATIONS_NOT_CONFIGURED: '❌ Pollinations API key not configured.',
    POLLINATIONS_AUDIO_EMPTY_INPUT: '⚠️ Text Required. You need to add text for TTS, tags alone are not enough.',
    POLLINATIONS_BAD_PROMPT: '🚫 Content Blocked. That prompt violates the terms of service. Try something else.',
    POLLINATIONS_INSUFFICIENT_BALANCE: '📉 Insufficient Pollen. Pollen refills every hour. Try again later.',
    POLLINATIONS_CONTENT_BLOCKED: '🚫 Content Blocked. The request was deemed inappropriate. Try being more specific or use different words.',
    POLLINATIONS_SERVER_DOWN: '🔧 Server Down. Pollinations servers are offline. Try again later.',
    POLLINATIONS_BAD_GATEWAY: '🔧 Bad Gateway. Pollinations servers are having issues. Try again in 30 seconds.',
    POLLINATIONS_SERVER_ERROR: '🔧 Server Error. Pollinations servers are having issues. Try again in 30 seconds.',
    POLLINATIONS_GATEWAY_TIMEOUT: '⏱️ Gateway Timeout. Pollinations took too long. Try again in 30 seconds.',
    POLLINATIONS_BAD_REQUEST: '❌ Bad Request. Pollinations rejected that prompt. Try different words.',
    POLLINATIONS_RATE_LIMITED: '⏰ Rate Limited. Pollinations is busy. Try again in 30 seconds.',
    POLLINATIONS_GENERIC_ERROR: '🔧 Pollinations {modelType} Error. Something went wrong. Try again in 30 seconds.',
    MEDIA_PROMPT_REQUIRED: '@{username} Please provide a description for the {mediaType}.',
    MEDIA_NO_DATA: '🔧 {service} Error. No {mediaType} data returned. Try again.',
    MEDIA_FALLBACK_RESPONSE: "Here's your {mediaType} {username}: {url}",
    COOLDOWN_ACTIVE: 'Cooldown active. Please wait {remainingTime} seconds before sending another message.',
    VIDEO_UPLOAD_EMPTY: '❌ Video Upload Failed. Host returned empty response. Try again.',
    VIDEO_UPLOAD_TIMEOUT: '⏱️ Video Upload Timeout. Host took too long. Try again.',
    VIDEO_UPLOAD_FAILED: '❌ Video Upload Failed. Could not upload video. Try again in 30 seconds.',
    VIDEO_TOO_LARGE: '🎬 Video Too Large. The generated video was too big. Try a simpler prompt.',
    AUDIO_UPLOAD_EMPTY: '❌ Audio Upload Failed. Host returned empty response. Try again.',
    AUDIO_UPLOAD_BAD_GATEWAY: '🔧 Audio Upload Error. Audio host is having issues. Try again in 30 seconds.',
    AUDIO_UPLOAD_SERVICE_UNAVAILABLE: '🔧 Audio Upload Error. Audio host is overloaded. Try again in 30 seconds.',
    AUDIO_UPLOAD_TIMEOUT: '⏱️ Audio Upload Timeout. Audio host took too long. Try again.',
    AUDIO_UPLOAD_FAILED: '❌ Audio Upload Failed. Could not upload audio. Try again in 30 seconds.',
    FETCH_TIMEOUT: '⏱️ Connection Timeout. The server took too long to respond. Try again.',
    FETCH_REFUSED: '🌐 Connection Refused. Could not reach the server. Try again.',
    FETCH_NOT_FOUND: '🌐 Server Not Found. Could not reach the server. Try again.',
    FETCH_RESET: '🌐 Connection Reset. The server dropped the connection. Try again.',
    FETCH_NETWORK_ERROR: '🌐 Network Error. Connection failed. Try again.',
    REQUEST_TIMEOUT: '⏱️ Timeout Error. The request took too long. Try again.',
    REQUEST_ABORTED: '⏱️ Request Aborted. The request was cancelled. Try again.',
    IMAGE_UPLOAD_EMPTY: '❌ Upload Failed. Image host returned empty response. Try again.',
    IMAGE_UPLOAD_BAD_GATEWAY: '🔧 Upload Error. Image host is having issues. Try again in 30 seconds.',
    IMAGE_UPLOAD_SERVICE_UNAVAILABLE: '🔧 Upload Error. Image host is overloaded. Try again in 30 seconds.',
    IMAGE_UPLOAD_TIMEOUT: '⏱️ Upload Timeout. Image host took too long. Try again.',
    IMAGE_UPLOAD_FAILED: '❌ Upload Failed. Could not upload image. Try again in 30 seconds.',
    IMAGE_TOO_LARGE: '🖼️ Image Too Large. Try a smaller image.',
    IMAGE_LOAD_ERROR: '🖼️ Image Error. Could not load that image. Try a different URL.',
    CONTENT_BLOCKED: '🚫 Content Blocked. The request was deemed inappropriate. Try being more specific or use different words.',
    SAFETY_FILTER: '⚠️ Safety Filter Triggered. Flagged as {categories}. Try rephrasing your message.',
    HTTP_429: '⏰ Quota Exceeded. API rate limit reached. Try again in 30 seconds.',
    HTTP_401: '🔐 Authentication Error. Ask the bot owner to fix this.',
    HTTP_403: '🚫 Access Denied. Ask the bot owner to fix this.',
    YOUTUBE_RESTRICTED: '🚫 Access Denied. The video is likely copyrighted or geo-restricted.',
    BOT_NOT_MODERATOR: 'I need moderator status in this channel to do that! Please /mod the bot in chat.',
    BROADCASTER_AUTH_REQUIRED: 'I need broadcaster authorization to update the stream in this channel.',
    HELIX_ACTION_TIMEOUT: '⏱️ Twitch took too long to respond. Try again in a moment.',
    HELIX_ACTION_FAILED: '🔧 Twitch action failed. Try again in a moment.',
    HTTP_400: '❌ Bad Request. Ask the bot owner to fix this.',
    HTTP_404: '🔍 Not Found. Ask the bot owner to fix this.',
    HTTP_500: "🔧 Server Error. Google's servers are having issues. Try again in 30 seconds.",
    HTTP_521: '🔧 Server Down. Origin server is offline. Try again later.',
    HTTP_504: '⏱️ Gateway Timeout. Server took too long. Try again.',
    HTTP_UNKNOWN: '❌ HTTP Error {statusCode}: {message}.',
    RENDER_NETWORK_ERROR: '🌐 Network Error. Could not reach external services. Try again.',
    JSON_PARSE_ERROR: '📄 Parse Error. Ask the bot owner to fix this.',
    UNKNOWN_ERROR: '❌ Unknown Error. Ask the bot owner to fix this.'
};

export const ERROR_GROUPS = [
    {
        id: 'common',
        name: 'High Impact & Critical',
        icon: '⚡',
        desc: 'Most frequently triggered runtime fallbacks across AI, media, and Twitch moderation.',
        keys: [
            { key: 'RATE_LIMIT_EXHAUSTED', desc: 'All Gemini API keys exhausted daily quota limits', vars: [] },
            { key: 'GEMINI_EMPTY_RESPONSE', desc: 'Gemini API returned an empty payload or 500 error', vars: [] },
            { key: 'SAFETY_FILTER', desc: 'Input prompt or AI output flagged by safety filters', vars: ['categories'] },
            { key: 'CONTENT_BLOCKED', desc: 'Upstream content moderation triggered', vars: [] },
            { key: 'POLLINATIONS_BAD_PROMPT', desc: 'Media generation prompt rejected by filters', vars: [] },
            { key: 'POLLINATIONS_SERVER_DOWN', desc: 'Media generation host unavailable or 503', vars: [] },
            { key: 'COOLDOWN_ACTIVE', desc: 'User rate-limiting cooldown notice', vars: ['remainingTime'] },
            { key: 'BOT_NOT_MODERATOR', desc: 'Chat moderator permission missing for Helix action', vars: [] },
            { key: 'BROADCASTER_AUTH_REQUIRED', desc: 'Broadcaster OAuth token missing for stream metadata edit', vars: [] }
        ]
    },
    {
        id: 'gemini',
        name: 'Gemini & AI Engine',
        icon: '🤖',
        desc: 'LLM reasoning errors, token exhaustion, and content safety filtering.',
        keys: [
            { key: 'RATE_LIMIT_EXHAUSTED', desc: 'All Gemini API keys exhausted daily quota limits', vars: [] },
            { key: 'GEMINI_EMPTY_RESPONSE', desc: 'Gemini API returned an empty payload or 500 error', vars: [] },
            { key: 'SAFETY_FILTER', desc: 'Input prompt or AI output flagged by safety filters', vars: ['categories'] },
            { key: 'CONTENT_BLOCKED', desc: 'Upstream content moderation triggered', vars: [] }
        ]
    },
    {
        id: 'pollinations',
        name: 'Pollinations & Media',
        icon: '🎨',
        desc: 'Image, video, audio generation pipeline errors and delivery fallbacks.',
        keys: [
            { key: 'POLLINATIONS_NOT_CONFIGURED', desc: 'Pollinations API key missing from environment', vars: [] },
            { key: 'POLLINATIONS_AUDIO_EMPTY_INPUT', desc: 'Audio generation invoked with empty prompt text', vars: [] },
            { key: 'POLLINATIONS_BAD_PROMPT', desc: 'Media generation prompt rejected by filters', vars: [] },
            { key: 'POLLINATIONS_INSUFFICIENT_BALANCE', desc: 'Hourly generation balance exhausted', vars: [] },
            { key: 'POLLINATIONS_CONTENT_BLOCKED', desc: 'Prompt deemed inappropriate by upstream filter', vars: [] },
            { key: 'POLLINATIONS_SERVER_DOWN', desc: 'Pollinations origin servers unreachable', vars: [] },
            { key: 'POLLINATIONS_BAD_GATEWAY', desc: 'Pollinations upstream returned 502 Bad Gateway', vars: [] },
            { key: 'POLLINATIONS_SERVER_ERROR', desc: 'Pollinations upstream returned 500 Server Error', vars: [] },
            { key: 'POLLINATIONS_GATEWAY_TIMEOUT', desc: 'Pollinations upstream returned 504 Gateway Timeout', vars: [] },
            { key: 'POLLINATIONS_BAD_REQUEST', desc: 'Pollinations rejected prompt syntax (400)', vars: [] },
            { key: 'POLLINATIONS_RATE_LIMITED', desc: 'Pollinations rate limit active (429)', vars: [] },
            { key: 'POLLINATIONS_GENERIC_ERROR', desc: 'General Pollinations generation error', vars: ['modelType'] },
            { key: 'MEDIA_PROMPT_REQUIRED', desc: 'Command invoked without required description prompt', vars: ['username', 'mediaType'] },
            { key: 'MEDIA_NO_DATA', desc: 'Host returned success status with zero byte buffer', vars: ['service', 'mediaType'] },
            { key: 'MEDIA_FALLBACK_RESPONSE', desc: 'Chat notification delivering generated media URL', vars: ['mediaType', 'username', 'url'] },
            { key: 'COOLDOWN_ACTIVE', desc: 'User rate-limiting cooldown notice', vars: ['remainingTime'] }
        ]
    },
    {
        id: 'uploads',
        name: 'Media Uploads & CDN',
        icon: '☁️',
        desc: 'Direct CDN uploads (Catbox, Litterbox, Pomf) and file size restrictions.',
        keys: [
            { key: 'VIDEO_UPLOAD_EMPTY', desc: 'Video host returned empty response buffer', vars: [] },
            { key: 'VIDEO_UPLOAD_TIMEOUT', desc: 'Video upload network timeout', vars: [] },
            { key: 'VIDEO_UPLOAD_FAILED', desc: 'Video upload multipart request failure', vars: [] },
            { key: 'VIDEO_TOO_LARGE', desc: 'Rendered video exceeds host byte size ceiling', vars: [] },
            { key: 'AUDIO_UPLOAD_EMPTY', desc: 'Audio host returned empty response buffer', vars: [] },
            { key: 'AUDIO_UPLOAD_BAD_GATEWAY', desc: 'Audio host returned 502 Bad Gateway', vars: [] },
            { key: 'AUDIO_UPLOAD_SERVICE_UNAVAILABLE', desc: 'Audio host returned 503 Service Unavailable', vars: [] },
            { key: 'AUDIO_UPLOAD_TIMEOUT', desc: 'Audio upload network timeout', vars: [] },
            { key: 'AUDIO_UPLOAD_FAILED', desc: 'Audio upload multipart request failure', vars: [] },
            { key: 'IMAGE_UPLOAD_EMPTY', desc: 'Image host returned empty response buffer', vars: [] },
            { key: 'IMAGE_UPLOAD_BAD_GATEWAY', desc: 'Image host returned 502 Bad Gateway', vars: [] },
            { key: 'IMAGE_UPLOAD_SERVICE_UNAVAILABLE', desc: 'Image host returned 503 Service Unavailable', vars: [] },
            { key: 'IMAGE_UPLOAD_TIMEOUT', desc: 'Image upload network timeout', vars: [] },
            { key: 'IMAGE_UPLOAD_FAILED', desc: 'Image upload multipart request failure', vars: [] },
            { key: 'IMAGE_TOO_LARGE', desc: 'Rendered image exceeds host byte size ceiling', vars: [] },
            { key: 'IMAGE_LOAD_ERROR', desc: 'Failed to fetch source image URL into memory buffer', vars: [] }
        ]
    },
    {
        id: 'network',
        name: 'Network & Connectivity',
        icon: '🌐',
        desc: 'TCP sockets, DNS resolution, and outbound HTTP request failures.',
        keys: [
            { key: 'FETCH_TIMEOUT', desc: 'Outbound fetch connection timed out', vars: [] },
            { key: 'FETCH_REFUSED', desc: 'Connection refused by remote host (ECONNREFUSED)', vars: [] },
            { key: 'FETCH_NOT_FOUND', desc: 'Remote host DNS resolution failed (ENOTFOUND)', vars: [] },
            { key: 'FETCH_RESET', desc: 'TCP connection reset by peer (ECONNRESET)', vars: [] },
            { key: 'FETCH_NETWORK_ERROR', desc: 'General socket network I/O error', vars: [] },
            { key: 'REQUEST_TIMEOUT', desc: 'HTTP transaction deadline exceeded', vars: [] },
            { key: 'REQUEST_ABORTED', desc: 'HTTP request aborted by signal controller', vars: [] },
            { key: 'RENDER_NETWORK_ERROR', desc: 'Render hosting outbound connectivity failure', vars: [] }
        ]
    },
    {
        id: 'twitch',
        name: 'Twitch & Moderation',
        icon: '📺',
        desc: 'Twitch Helix REST API actions, scopes, and moderation enforcement.',
        keys: [
            { key: 'BOT_NOT_MODERATOR', desc: 'Bot lacks moderator permission in chat', vars: [] },
            { key: 'BROADCASTER_AUTH_REQUIRED', desc: 'Broadcaster authorization required for title/category', vars: [] },
            { key: 'HELIX_ACTION_TIMEOUT', desc: 'Twitch Helix API network request timed out', vars: [] },
            { key: 'HELIX_ACTION_FAILED', desc: 'Twitch Helix action execution failed', vars: [] },
            { key: 'YOUTUBE_RESTRICTED', desc: 'YouTube video restricted or unavailable', vars: [] }
        ]
    },
    {
        id: 'http',
        name: 'HTTP & Status Codes',
        icon: '⚠️',
        desc: 'HTTP status codes and general application catch-alls.',
        keys: [
            { key: 'HTTP_400', desc: 'HTTP 400 Bad Request error', vars: [] },
            { key: 'HTTP_401', desc: 'HTTP 401 Unauthorized error', vars: [] },
            { key: 'HTTP_403', desc: 'HTTP 403 Access Denied error', vars: [] },
            { key: 'HTTP_404', desc: 'HTTP 404 Not Found error', vars: [] },
            { key: 'HTTP_429', desc: 'HTTP 429 Rate Limit Exceeded error', vars: [] },
            { key: 'HTTP_500', desc: 'HTTP 500 Server Error', vars: [] },
            { key: 'HTTP_504', desc: 'HTTP 504 Gateway Timeout', vars: [] },
            { key: 'HTTP_521', desc: 'HTTP 521 Origin Server Down', vars: [] },
            { key: 'HTTP_UNKNOWN', desc: 'Generic unexpected HTTP error code', vars: ['statusCode', 'message'] },
            { key: 'JSON_PARSE_ERROR', desc: 'JSON response body parse failure', vars: [] },
            { key: 'UNKNOWN_ERROR', desc: 'Ultimate catch-all unhandled fallback', vars: [] }
        ]
    }
];

export class ErrorsTab {
    constructor() {
        this.id = 'error_messages';
        this._container = null;
        this._context = null;
        this.errorsUnlocked = false;
        this.selectedErrorGroup = 'common';
        this.errorsConfig = {};
        this._gateOverlayEl = null;
        this._contentWrapperEl = null;
        this._btnProceedEl = null;
        this._navListEl = null;
        this._detailPanelEl = null;
        this._isDirty = false;
    }

    /**
     * @param {HTMLElement} container
     * @param {Object} context
     * @param {import('../../runtime/dashboard_runtime.js').DashboardRuntime} context.runtime
     * @param {import('../../runtime/api_client.js').ApiClient} context.apiClient
     * @param {(type: string, isOverride: boolean, isDirty?: boolean) => void} context.updateStatusBadge
     * @param {(type: string, payload: any) => Promise<void>} context.saveConfig
     * @param {(type: string) => Promise<void>} context.resetConfig
     */
    mount(container, context) {
        this._container = container;
        this._context = context;

        this._gateOverlayEl = container.querySelector('#errors-gate-overlay');
        this._contentWrapperEl = container.querySelector('#errors-content-wrapper');
        this._btnProceedEl = container.querySelector('#btn-errors-proceed');
        this._navListEl = container.querySelector('#errors-nav-list');
        this._detailPanelEl = container.querySelector('#errors-detail-panel');

        if (this._btnProceedEl) {
            this._btnProceedEl.addEventListener('click', () => {
                this.unlockGate();
            });
        }

        const saveBtn = container.querySelector('.btn-save[data-type="error_messages"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const payload = this.collectErrors();
                this._context?.saveConfig(this.id, payload).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }

        const resetBtn = container.querySelector('.btn-reset[data-type="error_messages"]');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this._context?.resetConfig(this.id).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }
    }

    unlockGate() {
        this.errorsUnlocked = true;
        this.updateGateVisibility();
        this.renderMasterDetail();
    }

    updateGateVisibility() {
        if (!this._gateOverlayEl || !this._contentWrapperEl) return;
        if (this.errorsUnlocked) {
            this._gateOverlayEl.style.display = 'none';
            this._contentWrapperEl.style.display = 'block';
        } else {
            this._gateOverlayEl.style.display = 'flex';
            this._contentWrapperEl.style.display = 'none';
        }
    }

    render(config) {
        if (!config) return;
        this.errorsConfig = structuredClone(config.error_messages || {});
        this._isDirty = false;

        this.updateGateVisibility();
        if (this.errorsUnlocked) {
            this.renderMasterDetail();
        }

        const isOverride = Boolean(config.overrides?.error_messages);
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, isOverride, false);
        }
    }

    renderMasterDetail() {
        this.updateGateVisibility();
        if (!this.errorsUnlocked) return;

        if (!this.selectedErrorGroup || !ERROR_GROUPS.some(g => g.id === this.selectedErrorGroup)) {
            this.selectedErrorGroup = ERROR_GROUPS[0].id;
        }

        this.renderNav();
        this.renderDetail(this.selectedErrorGroup);
    }

    _markDirty() {
        this._isDirty = true;
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, true, true);
        }
    }

    _createElement(tagName) {
        const doc = this._container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
        return doc ? doc.createElement(tagName) : null;
    }

    renderNav() {
        if (!this._navListEl) return;
        this._navListEl.innerHTML = '';

        ERROR_GROUPS.forEach(group => {
            const navItem = this._createElement('div');
            if (!navItem) return;
            navItem.className = `errors-nav-item ${this.selectedErrorGroup === group.id ? 'active' : ''}`;
            navItem.dataset.id = group.id;

            navItem.innerHTML = `
                <div class="errors-nav-left">
                    <span class="errors-nav-icon">${group.icon}</span>
                    <span class="errors-nav-title">${escapeHtml(group.name)}</span>
                </div>
                <span class="errors-nav-count">${group.keys.length}</span>
            `;

            navItem.addEventListener('click', () => {
                if (this.selectedErrorGroup !== group.id) {
                    this.selectGroup(group.id);
                }
            });

            this._navListEl.appendChild(navItem);
        });
    }

    selectGroup(groupId) {
        this.selectedErrorGroup = groupId;
        if (this._navListEl) {
            this._navListEl.querySelectorAll('.errors-nav-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === groupId);
            });
        }
        this.renderDetail(groupId);
    }

    attachSyntaxHighlighter(inputEl, validVars = []) {
        attachSyntaxHighlighter(inputEl, validVars);
    }

    renderDetail(groupId) {
        if (!this._detailPanelEl) return;
        this._detailPanelEl.innerHTML = '';

        const group = ERROR_GROUPS.find(g => g.id === groupId) || ERROR_GROUPS[0];
        if (!group) return;

        const detailEl = this._createElement('div');
        if (!detailEl) return;
        detailEl.className = 'errors-detail-content';

        detailEl.innerHTML = `
            <div class="errors-detail-header">
                <div class="errors-detail-title-group">
                    <strong class="errors-detail-title">${group.icon} ${escapeHtml(group.name)}</strong>
                    <span class="errors-detail-desc">${escapeHtml(group.desc)}</span>
                </div>
                <button type="button" class="btn btn-secondary btn-reset-group" title="Reset all errors in this category to factory default">↺ Reset Category</button>
            </div>
            <div class="errors-items-list"></div>
        `;

        const itemsContainer = detailEl.querySelector('.errors-items-list');
        const btnResetGroup = detailEl.querySelector('.btn-reset-group');

        btnResetGroup.addEventListener('click', () => {
            group.keys.forEach(k => {
                const defVal = FACTORY_ERRORS[k.key] || '';
                this.errorsConfig[k.key] = defVal;
            });
            this.renderDetail(groupId);
            this._markDirty();
        });

        group.keys.forEach(item => {
            const curVal = this.errorsConfig[item.key] !== undefined
                ? this.errorsConfig[item.key]
                : (FACTORY_ERRORS[item.key] || '');

            const card = this._createElement('div');
            if (!card) return;
            card.className = 'error-item-card';
            card.dataset.key = item.key;

            const pillsHtml = (item.vars || []).map(v =>
                `<button type="button" class="var-pill" data-var="{${v}}">+ {${v}}</button>`
            ).join('');

            card.innerHTML = `
                <div class="error-item-header">
                    <div class="error-key-group">
                        <span class="error-key-badge">${escapeHtml(item.key)}</span>
                        <span class="error-desc">${escapeHtml(item.desc)}</span>
                    </div>
                    <button type="button" class="btn-item-reset" data-key="${item.key}" title="Reset to factory default">↺ Reset</button>
                </div>
                <div class="error-input-block">
                    <div class="highlight-input-wrapper multiline">
                        <div class="highlight-backdrop" aria-hidden="true"></div>
                        <textarea class="table-input code-font highlight-textarea error-msg-input" rows="1" maxlength="450" placeholder="Chat fallback message..." spellcheck="false" autocomplete="off">${escapeHtml(curVal)}</textarea>
                    </div>
                    <div class="var-pills-row" style="margin-top: 2px;">
                        <div class="pills-group">${pillsHtml}</div>
                        <span class="char-counter error-counter">${curVal.length} / 450 chars</span>
                    </div>
                </div>
            `;

            const input = card.querySelector('.error-msg-input');
            const btnReset = card.querySelector('.btn-item-reset');
            const counter = card.querySelector('.error-counter');

            this.attachSyntaxHighlighter(input, item.vars || []);

            const updateCount = () => {
                if (counter && input) {
                    const len = input.value.length;
                    counter.textContent = `${len} / 450 chars`;
                    counter.classList.toggle('warning', len > 400);
                    counter.classList.toggle('error', len > 450);
                }
            };

            input.addEventListener('input', () => {
                updateCount();
                this.errorsConfig[item.key] = input.value;
                this._markDirty();
            });

            btnReset.addEventListener('click', () => {
                const defaultVal = FACTORY_ERRORS[item.key] || '';
                input.value = defaultVal;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                this.errorsConfig[item.key] = defaultVal;
                updateCount();
                this._markDirty();
            });

            card.querySelectorAll('.var-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    insertTokenAtCursor(input, pill.dataset.var);
                    this.errorsConfig[item.key] = input.value;
                    updateCount();
                    this._markDirty();
                });
            });

            updateCount();
            itemsContainer.appendChild(card);
        });

        this._detailPanelEl.appendChild(detailEl);
    }

    collectErrors() {
        return structuredClone(this.errorsConfig);
    }

    unmount() {
        this._container = null;
        this._context = null;
        this._gateOverlayEl = null;
        this._contentWrapperEl = null;
        this._btnProceedEl = null;
        this._navListEl = null;
        this._detailPanelEl = null;
    }
}
