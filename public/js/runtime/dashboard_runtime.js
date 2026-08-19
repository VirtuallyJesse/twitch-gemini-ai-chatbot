// public/js/runtime/dashboard_runtime.js
// Deep runtime coordinator managing state, WebSocket connectivity, typed event bus, and emote caching.

export class DashboardRuntime {
    /**
     * @param {Object} options
     * @param {import('./api_client.js').ApiClient} options.apiClient
     * @param {Object} [options.viewer] - Current user info { login, displayName, isAdmin, profileImageUrl }
     * @param {typeof WebSocket} [options.WebSocketClass] - Custom WebSocket constructor for testing
     * @param {Location} [options.location] - Custom location for testing
     * @param {Window} [options.window] - Custom window for event listeners
     */
    constructor(options = {}) {
        this.apiClient = options.apiClient;
        this.viewer = options.viewer || (typeof window !== 'undefined' ? window.__VIEWER__ : null);
        this._WebSocket = options.WebSocketClass || (typeof WebSocket !== 'undefined' ? WebSocket : null);
        this._location = options.location || (typeof window !== 'undefined' ? window.location : { protocol: 'http:', host: 'localhost' });
        this._window = options.window || (typeof window !== 'undefined' ? window : null);

        // State
        this.channels = [];
        this.channelStatuses = {};
        this.activeChannel = null;
        this.chatData = {};
        this.mediaData = [];
        this.emoteMapsByChannel = {};
        this.config = null;

        // Internal WebSocket & Reconnection State
        this._socket = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._isDestroyed = false;

        // Event Bus
        this._listeners = new Map();

        // Bindings
        this._handleWindowMessage = this._handleWindowMessage.bind(this);
    }

    /**
     * Connection status of the runtime.
     * @returns {'idle' | 'connected' | 'disconnected'}
     */
    get status() {
        if (this._isDestroyed) return 'idle';
        if (this._socket && this._socket.readyState === 1) {
            return 'connected';
        }
        return 'disconnected';
    }

    /**
     * Subscribes to an event on the runtime event bus.
     * @param {string} event
     * @param {Function} handler
     * @returns {() => void} Unsubscribe function
     */
    on(event, handler) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(handler);
        return () => this.off(event, handler);
    }

    /**
     * Unsubscribes a handler from an event.
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        const set = this._listeners.get(event);
        if (set) {
            set.delete(handler);
            if (set.size === 0) {
                this._listeners.delete(event);
            }
        }
    }

    /**
     * Emits an event to all subscribed listeners.
     * @param {string} event
     * @param {any} [data]
     */
    emit(event, data) {
        const set = this._listeners.get(event);
        if (set) {
            for (const handler of set) {
                try {
                    handler(data);
                } catch (err) {
                    console.error(`[DashboardRuntime] Error in '${event}' event listener:`, err);
                }
            }
        }
    }

    /**
     * Initializes and starts the runtime coordinator.
     */
    async start() {
        this._isDestroyed = false;

        if (this._window) {
            this._window.addEventListener('message', this._handleWindowMessage);
        }

        try {
            // 1. Fetch Channels and Channel Statuses
            const [channels, statuses] = await Promise.all([
                this.apiClient.fetchChannels().catch(() => []),
                this.apiClient.fetchChannelStatuses().catch(() => ({}))
            ]);
            this.channels = channels || [];
            this.channelStatuses = statuses || {};

            if (this.channels.length > 0) {
                this.activeChannel = this.channels[0];
            }
            this.emit('channels:updated', {
                channels: this.channels,
                channelStatuses: this.channelStatuses,
                activeChannel: this.activeChannel
            });

            // 2. Pre-warm emotes and fetch chat for active channel
            if (this.channels.length > 0) {
                await Promise.all([
                    this.activeChannel ? this.fetchChat(this.activeChannel) : Promise.resolve(),
                    ...this.channels.map(ch => this.ensureEmotesLoaded(ch))
                ]);
            }

            // 3. Fetch Initial Media
            const media = await this.apiClient.fetchMedia().catch(() => []);
            this.mediaData = media || [];
            this.emit('media:loaded', this.mediaData);

            // 4. Load config if admin
            if (this.viewer && this.viewer.isAdmin) {
                await this.loadConfig();
            }

            // 5. Connect WebSocket
            this._connectWebSocket();

        } catch (err) {
            console.error('[DashboardRuntime] Initialization failed:', err);
            this.emit('error', err);
        }
    }

    /**
     * Ensures third-party emote maps are fetched and cached for a channel.
     * @param {string} channel
     * @returns {Promise<Record<string, { url: string, provider: string }>>}
     */
    async ensureEmotesLoaded(channel) {
        if (!channel) return {};
        if (this.emoteMapsByChannel[channel]) {
            return this.emoteMapsByChannel[channel];
        }
        try {
            const map = await this.apiClient.fetchEmotes(channel);
            this.emoteMapsByChannel[channel] = map || {};
            this.emit('emotes:loaded', { channel, emotes: this.emoteMapsByChannel[channel] });
            return this.emoteMapsByChannel[channel];
        } catch (err) {
            console.warn(`[DashboardRuntime] Failed to load emotes for ${channel}:`, err.message);
            this.emoteMapsByChannel[channel] = {};
            return {};
        }
    }

    /**
     * Fetches chat messages for a channel.
     * @param {string} channel
     * @returns {Promise<Array<any>>}
     */
    async fetchChat(channel) {
        if (!channel) return [];
        try {
            const data = await this.apiClient.fetchChat(channel);
            this.chatData[channel] = data || [];
            this.emit('chat:loaded', { channel, messages: this.chatData[channel] });
            return this.chatData[channel];
        } catch (err) {
            console.warn(`[DashboardRuntime] Failed to fetch chat for ${channel}:`, err.message);
            this.chatData[channel] = [];
            return [];
        }
    }

    /**
     * Switches the active channel.
     * @param {string} channel
     */
    async switchChannel(channel) {
        if (!channel || this.activeChannel === channel) return;
        this.activeChannel = channel;
        this.emit('channel:changed', { channel, activeChannel: this.activeChannel });

        // Ensure emotes are loaded in background
        this.ensureEmotesLoaded(channel).then(() => {
            if (this.activeChannel === channel) {
                this.emit('chat:updated', { channel, messages: this.chatData[channel] || [] });
            }
        }).catch(() => {});

        if (!this.chatData[channel]) {
            await this.fetchChat(channel);
        } else {
            this.emit('chat:updated', { channel, messages: this.chatData[channel] || [] });
        }
    }

    /**
     * Updates authorization status for a channel.
     * @param {string} channel
     * @param {boolean} authorized
     */
    updateChannelAuthStatus(channel, authorized) {
        if (!channel) return;
        const raw = String(channel);
        const ch = raw.startsWith('#') ? raw : '#' + raw;
        if (!this.channelStatuses[ch]) {
            this.channelStatuses[ch] = { channel: ch, isBot: false };
        }
        this.channelStatuses[ch].authorized = Boolean(authorized);
        this.emit('auth:status', { channel: ch, authorized: Boolean(authorized), channelStatuses: this.channelStatuses });
    }

    /**
     * Appends a message to a channel's chat log and emits chat event.
     * @param {string} channel
     * @param {Object} msg
     */
    appendMessage(channel, msg) {
        if (!this.chatData[channel]) this.chatData[channel] = [];
        this.chatData[channel].push(msg);

        // Rolling buffer ceiling of 1000 items
        if (this.chatData[channel].length > 1000) {
            this.chatData[channel].shift();
        }

        this.emit('chat:message', { channel, entry: msg, isCurrentChannel: this.activeChannel === channel });
    }

    /**
     * Prepends new media item to media log and emits media event.
     * @param {Object} item
     */
    prependMedia(item) {
        this.mediaData.unshift(item);
        this.emit('media:new', item);
    }

    /**
     * Loads full bot configuration.
     * @returns {Promise<Object>}
     */
    async loadConfig() {
        try {
            const config = await this.apiClient.fetchConfig();
            this.config = config;
            this.emit('config:loaded', this.config);
            return config;
        } catch (err) {
            console.error('[DashboardRuntime] Failed to load config:', err.message);
            throw err;
        }
    }

    /**
     * Handles window message events (e.g. broadcaster OAuth popups).
     * @private
     */
    _handleWindowMessage(event) {
        if (event.data?.type === 'twitch:broadcaster_authorized' && event.data.channel) {
            this.updateChannelAuthStatus(event.data.channel, true);
        }
    }

    /**
     * Connects to WebSocket with exponential backoff reconnection.
     * @private
     */
    _connectWebSocket() {
        if (this._isDestroyed || !this._WebSocket) return;

        try {
            const protocol = this._location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl = `${protocol}://${this._location.host}/ws`;
            this._socket = new this._WebSocket(wsUrl);

            this._socket.onopen = () => {
                this._reconnectAttempts = 0;
                this.emit('ws:connected');
            };

            this._socket.onclose = () => {
                if (this._isDestroyed) return;
                this.emit('ws:disconnected');
                this._scheduleReconnect();
            };

            this._socket.onerror = (err) => {
                this.emit('ws:error', err);
            };

            this._socket.onmessage = (event) => {
                try {
                    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                    this._handleWsMessage(data);
                } catch (err) {
                    console.error('[DashboardRuntime] WS JSON parse error:', err);
                }
            };
        } catch (err) {
            console.error('[DashboardRuntime] WS connection error:', err);
            this._scheduleReconnect();
        }
    }

    /**
     * Dispatches parsed WebSocket messages.
     * @private
     */
    _handleWsMessage(data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'chat':
                if (data.channel && data.entry) {
                    this.appendMessage(data.channel, data.entry);
                }
                break;
            case 'media':
                if (data.entry) {
                    this.prependMedia(data.entry);
                }
                break;
            case 'emotes:update':
                if (data.channel) {
                    this.emoteMapsByChannel[data.channel] = data.emotes || {};
                    this.emit('emotes:updated', { channel: data.channel, emotes: this.emoteMapsByChannel[data.channel] });
                }
                break;
            case 'auth:broadcaster':
                if (data.channel) {
                    this.updateChannelAuthStatus(data.channel, data.authorized);
                }
                break;
            case 'config:updated':
                this.emit('config:updated', data);
                if (this.viewer && this.viewer.isAdmin) {
                    this.loadConfig().catch(() => {});
                }
                break;
            default:
                this.emit(`ws:${data.type}`, data);
                break;
        }
    }

    /**
     * Schedules a WebSocket reconnection attempt with exponential backoff and jitter.
     * @private
     */
    _scheduleReconnect() {
        if (this._isDestroyed || this._reconnectTimer) return;

        this._reconnectAttempts++;
        const baseDelay = 1000;
        const maxDelay = 15000;
        const expDelay = Math.min(maxDelay, baseDelay * Math.pow(1.5, this._reconnectAttempts - 1));
        const jitter = Math.random() * 500;
        const delay = Math.round(expDelay + jitter);

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connectWebSocket();
        }, delay);
    }

    /**
     * Synchronizes state.
     * @param {'all' | 'config' | 'media' | 'emotes'} [scope='all']
     */
    async sync(scope = 'all') {
        if (scope === 'all' || scope === 'media') {
            const media = await this.apiClient.fetchMedia().catch(() => []);
            this.mediaData = media || [];
            this.emit('media:loaded', this.mediaData);
        }
        if ((scope === 'all' || scope === 'config') && this.viewer?.isAdmin) {
            await this.loadConfig().catch(() => {});
        }
        if (scope === 'all' || scope === 'emotes') {
            if (this.activeChannel) {
                await this.ensureEmotesLoaded(this.activeChannel);
                await this.fetchChat(this.activeChannel);
            }
        }
    }

    /**
     * Destroys runtime and releases all resources, timers, and listeners.
     */
    async destroy() {
        this._isDestroyed = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._socket) {
            try {
                this._socket.onclose = null;
                this._socket.close();
            } catch {
                // ignore
            }
            this._socket = null;
        }
        if (this._window) {
            this._window.removeEventListener('message', this._handleWindowMessage);
        }
        this._listeners.clear();
    }
}
