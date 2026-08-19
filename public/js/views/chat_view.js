// public/js/views/chat_view.js
// Autonomous ChatView module managing channel tabs, auth pill, and real-time chat log.

import { escapeHtml, renderMessageHtml, handleEmoteError } from '../utils/web_emotes.js';

export class ChatView {
    constructor() {
        this.id = 'chat';
        this._container = null;
        this._context = null;
        this._unsubscribers = [];
        this._tabsEl = null;
        this._authPillEl = null;
        this._chatLogEl = null;
        this._handleEmoteError = this._handleEmoteError.bind(this);
    }

    /**
     * @param {HTMLElement} container
     * @param {Object} context
     * @param {import('../runtime/dashboard_runtime.js').DashboardRuntime} context.runtime
     * @param {import('../runtime/api_client.js').ApiClient} context.apiClient
     */
    mount(container, context) {
        this._container = container;
        this._context = context;

        const doc = container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
        this._tabsEl = container.querySelector('#channel-tabs') || doc?.getElementById?.('channel-tabs');
        this._authPillEl = container.querySelector('#channel-auth-pill') || doc?.getElementById?.('channel-auth-pill');
        this._chatLogEl = container.querySelector('#chat-log') || doc?.getElementById?.('chat-log');

        // Emote error retry listener on chat log
        if (this._chatLogEl) {
            this._chatLogEl.addEventListener('error', this._handleEmoteError, true);
        }

        // Subscribe to runtime events
        const { runtime } = context;
        this._unsubscribers.push(
            runtime.on('channels:updated', () => {
                this.renderTabs();
                this.renderChat();
            }),
            runtime.on('channel:changed', () => {
                this.renderTabs();
                this.renderChat();
            }),
            runtime.on('auth:status', () => {
                this.renderTabs();
                this.renderAuthPill();
            }),
            runtime.on('chat:loaded', (data) => {
                if (data.channel === runtime.activeChannel) {
                    this.renderChat();
                }
            }),
            runtime.on('chat:updated', (data) => {
                if (data.channel === runtime.activeChannel) {
                    this.renderChat();
                }
            }),
            runtime.on('chat:message', (data) => {
                this._onChatMessage(data);
            }),
            runtime.on('emotes:loaded', (data) => {
                if (data.channel === runtime.activeChannel) {
                    this.renderChat();
                }
            }),
            runtime.on('emotes:updated', (data) => {
                if (data.channel === runtime.activeChannel) {
                    this.renderChat();
                }
            })
        );

        // Initial render if runtime is already hydrated
        this.renderTabs();
        this.renderChat();
    }

    renderTabs() {
        if (!this._tabsEl || !this._context) return;
        const { runtime } = this._context;

        if (runtime.channels.length === 0) {
            this._tabsEl.innerHTML = '<div class="tab">Loading...</div>';
            this.renderAuthPill();
            return;
        }

        this._tabsEl.innerHTML = runtime.channels.map(ch => {
            const status = runtime.channelStatuses[ch];
            const isUnlinked = status && !status.authorized;
            const warnBadge = isUnlinked ? '<span class="tab-warn" title="Stream controls unlinked">⚠️</span>' : '';
            return `
                <div class="tab ${ch === runtime.activeChannel ? 'active' : ''} ${isUnlinked ? 'tab-unlinked' : ''}" data-channel="${escapeHtml(ch)}">
                    ${escapeHtml(ch)}${warnBadge}
                </div>
            `;
        }).join('');

        // Attach click listeners to tabs
        this._tabsEl.querySelectorAll('.tab').forEach(tabEl => {
            tabEl.addEventListener('click', () => {
                const channel = tabEl.dataset.channel;
                if (channel) {
                    runtime.switchChannel(channel);
                }
            });
        });

        this.renderAuthPill();
    }

    renderAuthPill() {
        if (!this._authPillEl || !this._context) return;
        const { runtime } = this._context;

        const ch = runtime.activeChannel;
        const status = ch ? runtime.channelStatuses[ch] : null;

        if (status && !status.authorized) {
            const safe = ch.replace('#', '');
            this._authPillEl.style.display = 'inline-flex';
            this._authPillEl.innerHTML = `
                <span class="unlinked-pill" title="Twitch broadcaster token required for stream category and title changes">
                    ⚠️ Stream controls unlinked
                    <button class="btn-link-broadcaster" data-channel="${escapeHtml(safe)}">Link Broadcaster</button>
                </span>
            `;

            const linkBtn = this._authPillEl.querySelector('.btn-link-broadcaster');
            if (linkBtn) {
                linkBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.linkBroadcaster(safe);
                });
            }
        } else {
            this._authPillEl.style.display = 'none';
            this._authPillEl.innerHTML = '';
        }
    }

    linkBroadcaster(channel) {
        const safe = String(channel || '').replace('#', '');
        const win = typeof window !== 'undefined' ? window : null;
        if (!win) return;

        const w = 600;
        const h = 700;
        const left = (win.screenX || 0) + ((win.outerWidth || 1024) - w) / 2;
        const top = (win.screenY || 0) + ((win.outerHeight || 768) - h) / 2;
        win.open(
            `/auth/broadcaster?channel=${encodeURIComponent(safe)}`,
            'twitch_broadcaster_auth',
            `width=${w},height=${h},left=${left},top=${top},status=no,menubar=no,toolbar=no`
        );
    }

    renderChat() {
        if (!this._chatLogEl || !this._context) return;
        const { runtime } = this._context;

        const msgs = (runtime.activeChannel && runtime.chatData[runtime.activeChannel]) || [];
        const visibleMsgs = msgs.slice(-200);

        this._chatLogEl.innerHTML = visibleMsgs.map(msg => this._formatMessageHtml(msg, runtime.activeChannel)).join('');
        this.scrollToBottom();
    }

    _onChatMessage(data) {
        if (!this._chatLogEl || !this._context) return;
        const { runtime } = this._context;

        if (data.channel === runtime.activeChannel) {
            const isScrolledBottom = this._chatLogEl.scrollHeight - this._chatLogEl.scrollTop <= this._chatLogEl.clientHeight + 10;
            const html = this._formatMessageHtml(data.entry, data.channel);
            this._chatLogEl.insertAdjacentHTML('beforeend', html);

            if (isScrolledBottom) {
                this.scrollToBottom();
            }
        }
    }

    _formatMessageHtml(msg, channel) {
        const date = new Date(msg.timestamp);
        const timeStr = isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const rendered = renderMessageHtml(msg.message, channel, msg.meta, this._context?.runtime?.emoteMapsByChannel || {});

        return `
            <div class="chat-msg">
                <span class="ts">[${timeStr}]</span>
                <span class="user" style="color: ${this.getUsernameColor(msg.username)}">${escapeHtml(msg.username)}:</span>
                <span class="text">${rendered}</span>
            </div>
        `;
    }

    scrollToBottom() {
        if (this._chatLogEl) {
            this._chatLogEl.scrollTop = this._chatLogEl.scrollHeight;
        }
    }

    getUsernameColor(username) {
        let hash = 0;
        const str = String(username || '');
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
        return '#' + '00000'.substring(0, 6 - c.length) + c;
    }

    _handleEmoteError(event) {
        const target = event.target;
        if (target && target.tagName === 'IMG' && target.classList.contains('emote-img')) {
            handleEmoteError(target);
        }
    }

    unmount() {
        if (this._chatLogEl) {
            this._chatLogEl.removeEventListener('error', this._handleEmoteError, true);
        }
        this._unsubscribers.forEach(unsub => unsub());
        this._unsubscribers = [];
        this._container = null;
        this._context = null;
        this._tabsEl = null;
        this._authPillEl = null;
        this._chatLogEl = null;
    }
}
