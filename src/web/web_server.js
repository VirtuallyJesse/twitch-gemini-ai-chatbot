// src/web/web_server.js
//
// Deep module owning the HTTP/WebSocket runtime: Express routes, Vite SPA static serving,
// Twitch OAuth callback pages, client fan-out with ping/pong sweep, and the
// Render keep-alive worker. All collaborators and config cross the constructor.

import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { renderAuthMismatchHtml, channelKey } from '../twitch/twitch_transport.js';
import { EVENT_REACTION_HARNESS } from '../twitch/event_reaction.js';
import {
    COOKIE_NAME,
    STATE_COOKIE,
    SESSION_TTL_MS,
    deriveSessionSecret,
    createSessionToken,
    verifySessionToken,
    parseCookies,
    serializeCookie,
    clearCookieHeader
} from './session.js';
import { CONFIG_TYPES, collectExactTriggers } from '../utils/bot_config.js';
import { MAX_CHAT_PAGE_SIZE } from '../utils/storage.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(moduleDir, '../../public');
const DEFAULT_DIST_DIR = path.resolve(DEFAULT_PUBLIC_DIR, 'dist');
const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 10_000;

const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

const SAMPLE_ALERT_VARS = {
    subscription: { username: 'CoolViewer', tier: 'Tier 1' },
    resub: { username: 'DriftKing', tier: 'Tier 1', months: 7, streak: 7, message: 'fox supremacy' },
    community_sub_gift: { username: 'QuantumQueen', count: 5, tier: 'Tier 1' },
    sub_gift: { username: 'GenerousGiver', recipient: 'LuckyViewer', tier: 'Tier 1' },
    cheer: { username: 'HypeMaster', bits: 500, message: 'Keep up the great work!' },
    raid: { username: 'StreamerFriend', viewers: 42 },
    follow: { username: 'NewFriend' },
    channel_points: { username: 'PointSpender', reward: 'Hydrate', user_input: 'Drink some water!' }
};

// Sanity caps unified with storage (10k): avatars are the one server-side
// structure without an eviction story; Helix /users accepts 100 logins per call.
const AVATAR_CACHE_MAX = 10_000;
const HELIX_LOOKUP_BATCH = 100;

export class WebServer {
    #transport;
    #storage;
    #aiEngine;
    #emotePool;
    #mediaPipeline;
    #errorHandler;
    #configStore;
    #chatRouter;
    #helixActions;
    #adminUsernames;
    #clientId;
    #clientSecret;
    #sessionSecret;
    #sessionTtlMs;
    #isAdminLogin;
    #botUsername;
    #externalUrl;
    #keepAliveIntervalMs;
    #heartbeatIntervalMs;
    #fetchImpl;
    #host;
    #preferredPort;
    #publicDir;
    #distDir;
    #isDevMock;

    #app;
    #wsInstance;
    #httpServer = null;
    #listening = false;
    #live = false;
    #clients = new Set();
    #keepAliveTimer = null;
    #heartbeatTimer = null;
    #transportLogUnsub = null;
    #transportStatusUnsub = null;
    #emotesHandler = null;
    #emotesUnsub = null;
    #badgesUnsub = null;
    #prevOnMediaSaved = undefined;
    #avatarCache = new Map();

    constructor(options = {}) {
        const {
            transport,
            storage,
            aiEngine = null,
            emotePool = null,
            mediaPipeline = null,
            errorHandler = null,
            configStore = null,
            chatRouter = null,
            helixActions = null,
            adminUsernames = [],
            clientId = '',
            clientSecret = '',
            sessionSecret = null,
            sessionTtlMs = SESSION_TTL_MS,
            port = 3000,
            host,
            botUsername = '',
            externalUrl = '',
            keepAliveIntervalMs = DEFAULT_KEEP_ALIVE_MS,
            heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
            publicDir = DEFAULT_PUBLIC_DIR,
            distDir = DEFAULT_DIST_DIR,
            trustProxy = 1,
            fetchImpl = globalThis.fetch.bind(globalThis),
            isDevMock = false
        } = options;

        if (!transport) throw new Error('WebServer requires transport');
        if (!storage) throw new Error('WebServer requires storage');

        this.#transport = transport;
        this.#storage = storage;
        this.#aiEngine = aiEngine;
        this.#emotePool = emotePool;
        this.#mediaPipeline = mediaPipeline;
        this.#errorHandler = errorHandler;
        this.#configStore = configStore;
        this.#chatRouter = chatRouter;
        this.#helixActions = helixActions;
        this.#adminUsernames = (adminUsernames || []).map((s) => String(s).toLowerCase()).filter(Boolean);
        this.#clientId = String(clientId || '').trim();
        this.#clientSecret = String(clientSecret || '').trim();
        this.#sessionSecret = sessionSecret || deriveSessionSecret(this.#clientSecret);
        this.#sessionTtlMs = Number(sessionTtlMs) || SESSION_TTL_MS;
        this.#botUsername = String(botUsername || '');
        this.#externalUrl = String(externalUrl || '').trim();
        this.#keepAliveIntervalMs = Number(keepAliveIntervalMs) || DEFAULT_KEEP_ALIVE_MS;
        this.#heartbeatIntervalMs = Number(heartbeatIntervalMs) || DEFAULT_HEARTBEAT_MS;
        this.#fetchImpl = fetchImpl;
        this.#host = host;
        this.#preferredPort = port ?? 3000;
        this.#publicDir = publicDir;
        this.#distDir = distDir;
        this.#isDevMock = Boolean(isDevMock);

        this.#isAdminLogin = (login) => {
            const name = String(login || '').toLowerCase();
            if (!name) return false;
            return name === String(this.#botUsername).toLowerCase() || this.#adminUsernames.includes(name);
        };

        const app = express();
        this.#wsInstance = expressWs(app);
        this.#app = app;

        if (trustProxy !== false && trustProxy !== undefined) {
            app.set('trust proxy', trustProxy);
        }
        app.use(express.json({ limit: '1mb' }));
        // Hashed build output never changes content, so it caches immutably;
        // the HTML shell must revalidate every load or new deploys would not
        // propagate to returning visitors.
        app.use(express.static(this.#distDir, {
            setHeaders: (res, filePath) => {
                if (path.basename(filePath) === 'index.html') {
                    res.setHeader('Cache-Control', 'no-cache');
                } else if (/[/\\]assets[/\\]/.test(filePath)) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            }
        }));
        app.use('/public', express.static(this.#publicDir));
        app.use('/media', express.static(path.resolve(this.#publicDir, 'media')));

        this.#mountRoutes();
    }

    get isListening() {
        return this.#listening;
    }

    get port() {
        const addr = this.#httpServer?.address?.();
        if (addr && typeof addr === 'object') return addr.port;
        return Number(this.#preferredPort) || 0;
    }

    get url() {
        if (!this.#listening) return null;
        const addr = this.#httpServer?.address?.();
        let host = this.#host;
        if (!host && addr && typeof addr === 'object') host = addr.address;
        if (!host || host === '0.0.0.0' || host === '::' || host === '::1') host = '127.0.0.1';
        return `http://${host}:${this.port}`;
    }

    get connectedClientsCount() {
        let n = 0;
        for (const client of this.#clients) {
            if (client.readyState === 1) n++;
        }
        return n;
    }

    async start(port = this.#preferredPort) {
        if (this.#listening) return { port: this.port, url: this.url };

        this.#attachCollaborators();
        this.#live = true;

        const listenPort = port ?? 3000;
        await new Promise((resolve, reject) => {
            const onError = (err) => reject(err);
            const onListening = () => {
                this.#httpServer.off('error', onError);
                resolve();
            };
            this.#httpServer = this.#host
                ? this.#app.listen(listenPort, this.#host, onListening)
                : this.#app.listen(listenPort, onListening);
            this.#httpServer.once('error', onError);
        });

        this.#listening = true;
        this.#startHeartbeat();
        this.#startKeepAlive();
        return { port: this.port, url: this.url };
    }

    async stop() {
        this.#live = false;
        this.#detachCollaborators();
        this.#stopKeepAlive();
        this.#stopHeartbeat();

        for (const client of this.#clients) {
            try { client.terminate(); } catch { /* already dead */ }
        }
        this.#clients.clear();

        const server = this.#httpServer;
        this.#httpServer = null;
        this.#listening = false;
        if (!server) return;

        await new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    }

    broadcast(event) {
        const payload = JSON.stringify(event);
        let sent = 0;
        for (const client of [...this.#clients]) {
            try {
                if (client.readyState !== 1) {
                    this.#dropClient(client);
                    continue;
                }
                client.send(payload);
                sent++;
            } catch {
                this.#dropClient(client);
            }
        }
        return sent;
    }

    async #currentBotStatus() {
        const status = this.#transport.auth.getStatus();
        const channelStatuses = await this.#transport.getChannelAuthStatuses();
        return {
            ...status,
            channelStatuses,
            botUsername: this.#botUsername,
            authorized: this.#transport.auth.isAuthorized(),
            connected: Boolean(this.#transport.connected),
            storageConfigured: Boolean(this.#storage.configured)
        };
    }

    async #broadcastBotStatus() {
        if (!this.#live) return;
        try {
            this.broadcast({ type: 'bot:status', ...await this.#currentBotStatus() });
        } catch (error) {
            console.error('[WebServer] Failed to broadcast bot status:', error.message);
        }
    }

    #mountWebSocket() {
        this.#app.ws('/ws', (ws) => {
            ws.isAlive = true;
            this.#clients.add(ws);
            ws.on('pong', () => { ws.isAlive = true; });
            ws.on('close', () => this.#clients.delete(ws));
            ws.on('error', () => this.#dropClient(ws));
        });
    }

    #dropClient(client) {
        this.#clients.delete(client);
        try { client.terminate(); } catch { /* ignore */ }
    }

    #startHeartbeat() {
        this.#stopHeartbeat();
        this.#heartbeatTimer = setInterval(() => {
            for (const client of [...this.#clients]) {
                if (client.isAlive === false) {
                    this.#dropClient(client);
                    continue;
                }
                client.isAlive = false;
                try { client.ping(); } catch { this.#dropClient(client); }
            }
        }, this.#heartbeatIntervalMs);
    }

    #stopHeartbeat() {
        if (this.#heartbeatTimer) {
            clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
    }

    #healthUrl() {
        const base = this.#externalUrl;
        if (!base) return null;
        return base.endsWith('/') ? `${base}healthz` : `${base}/healthz`;
    }

    #startKeepAlive() {
        this.#stopKeepAlive();
        const url = this.#healthUrl();
        if (!url) return;
        this.#keepAliveTimer = setInterval(() => {
            this.#pingKeepAlive(url);
        }, this.#keepAliveIntervalMs);
    }

    #stopKeepAlive() {
        if (this.#keepAliveTimer) {
            clearInterval(this.#keepAliveTimer);
            this.#keepAliveTimer = null;
        }
    }

    async #pingKeepAlive(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
        try {
            const response = await this.#fetchImpl(url, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) {
                console.warn(`[WebServer] Keep-alive ping failed with status: ${response.status}`);
            }
        } catch (error) {
            console.warn(`[WebServer] Keep-alive ping error: ${error.message}`);
        } finally {
            clearTimeout(timer);
        }
    }

    #attachCollaborators() {
        if (this.#transport?.onLogEntry) {
            // Transport observations arrive complete: exact Twitch message ID
            // and positive local order assigned before emission. The web layer
            // broadcasts and persists them unchanged.
            const unsub = this.#transport.onLogEntry((channel, entry) => {
                if (!this.#live) return;
                this.broadcast({ type: 'chat', channel, entry });
                this.#storage.addChatMessage(channel, entry).catch((err) => {
                    console.error('Failed to save chat to storage:', err.message);
                });
            });
            this.#transportLogUnsub = typeof unsub === 'function' ? unsub : null;
        }

        if (this.#transport?.onStatus) {
            const unsub = this.#transport.onStatus(({ type, address, port, reason }) => {
                if (!this.#live) return;
                if (type === 'connected') {
                    console.log(`* Connected to ${address}:${port}`);
                    if (this.#emotePool?.sync) {
                        this.#emotePool.sync(this.#transport.channels, this.#transport.channelIdMap).then(
                            () => console.log('Emote initialization completed'),
                            (error) => console.error('Failed to initialize emotes:', error)
                        );
                    }
                } else if (type === 'disconnected') {
                    console.log(`Disconnected: ${reason}`);
                } else if (type === 'auth_required') {
                    console.log('[Twitch] Authorization required. Bot runtime is waiting.');
                }
                void this.#broadcastBotStatus();
            });
            this.#transportStatusUnsub = typeof unsub === 'function' ? unsub : null;
        }

        if (this.#emotePool?.on) {
            this.#emotesHandler = ({ channel, emotes }) => {
                if (!this.#live) return;
                this.broadcast({ type: 'emotes:update', channel, emotes });
            };
            const unsub = this.#emotePool.on('update', this.#emotesHandler);
            this.#emotesUnsub = typeof unsub === 'function' ? unsub : null;
        }

        if (this.#transport?.badges?.onUpdate) {
            this.#badgesUnsub = this.#transport.badges.onUpdate(({ channel, badges }) => {
                if (!this.#live) return;
                this.broadcast({ type: 'badges:update', channel, badges });
            });
        }

        if (this.#mediaPipeline) {
            this.#prevOnMediaSaved = this.#mediaPipeline.onMediaSaved;
            this.#mediaPipeline.onMediaSaved = (entry) => {
                if (!this.#live) return;
                this.broadcast({ type: 'media', entry });
            };
        }
    }

    #detachCollaborators() {
        if (this.#transportLogUnsub) {
            try { this.#transportLogUnsub(); } catch { /* ignore */ }
            this.#transportLogUnsub = null;
        }
        if (this.#transportStatusUnsub) {
            try { this.#transportStatusUnsub(); } catch { /* ignore */ }
            this.#transportStatusUnsub = null;
        }
        if (this.#emotesUnsub) {
            try { this.#emotesUnsub(); } catch { /* ignore */ }
            this.#emotesUnsub = null;
        }
        if (this.#emotePool && this.#emotesHandler) {
            this.#emotePool.off?.('update', this.#emotesHandler);
            this.#emotePool.removeListener?.('update', this.#emotesHandler);
            this.#emotesHandler = null;
        }
        if (this.#badgesUnsub) {
            try { this.#badgesUnsub(); } catch { /* ignore */ }
            this.#badgesUnsub = null;
        }
        if (this.#mediaPipeline) {
            this.#mediaPipeline.onMediaSaved = this.#prevOnMediaSaved ?? null;
            this.#prevOnMediaSaved = undefined;
        }
    }

    #requestOrigin(req) {
        return `${req.protocol}://${req.get('host')}`;
    }

    #redirectUri(req) {
        return `${this.#requestOrigin(req)}/auth/callback`;
    }

    #publicError(error) {
        if (this.#errorHandler && typeof this.#errorHandler.format === 'function') {
            const text = this.#errorHandler.format(error);
            if (text) return String(text);
        }
        return 'An error occurred while generating the response.';
    }

    #renderAuthSuccessHtml({ title, heading, bodyHtml, autoCloseScript = '', variant = 'success' }) {
        const safeTitle = escapeHtml(title);
        const safeHeading = escapeHtml(heading);
        const isError = variant === 'error';
        const iconColor = isError ? '#f87171' : '#34d399';
        const iconBg = isError ? 'rgba(248, 113, 113, 0.12)' : 'rgba(52, 211, 153, 0.12)';
        const iconBorder = isError ? 'rgba(248, 113, 113, 0.3)' : 'rgba(52, 211, 153, 0.3)';
        const iconPaths = isError
            ? '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
            : '<polyline points="20 6 9 17 4 12"></polyline>';
        return `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #101113;
            color: #9da2ab;
            line-height: 1.55;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            text-align: center;
        }
        .card {
            background: #18191c;
            border: 1px solid #2d3039;
            border-radius: 12px;
            padding: 32px 28px;
            max-width: 480px;
            width: 100%;
        }
        .icon-wrap {
            width: 44px;
            height: 44px;
            border-radius: 50%;
            background: ${iconBg};
            border: 1px solid ${iconBorder};
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: ${iconColor};
            margin-bottom: 16px;
        }
        h1 {
            color: #e8eaed;
            font-size: 17px;
            font-weight: 600;
            margin-bottom: 8px;
        }
        p {
            font-size: 13px;
            color: #9da2ab;
            margin-bottom: 8px;
        }
        strong {
            color: #a273ff;
            background: #222429;
            padding: 1px 5px;
            border-radius: 4px;
            border: 1px solid #2d3039;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            font-weight: 600;
        }
        a {
            color: #a273ff;
            text-decoration: none;
            font-size: 12.5px;
            font-weight: 500;
        }
        a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon-wrap">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                ${iconPaths}
            </svg>
        </div>
        <h1>${safeHeading}</h1>
        ${bodyHtml}
        <p style="margin-top: 16px;"><a href="/">Back to dashboard</a></p>
    </div>
    ${autoCloseScript}
</body>
</html>`;
    }

    #renderAuthErrorCard(heading, detail) {
        return this.#renderAuthSuccessHtml({
            title: heading,
            heading,
            bodyHtml: detail ? `<p>${escapeHtml(detail)}</p>` : '',
            variant: 'error'
        });
    }

    #viewerFrom(req) {
        const cookies = parseCookies(req.headers?.cookie);
        const token = cookies[COOKIE_NAME];
        const payload = verifySessionToken(token, this.#sessionSecret);
        if (!payload) {
            if (this.#isDevMock) {
                return {
                    login: 'jesse',
                    userId: 'dev_admin_1',
                    displayName: 'Jesse',
                    profileImageUrl: '/media/avatar.jpg',
                    isAdmin: true
                };
            }
            return null;
        }
        return { ...payload, isAdmin: this.#isAdminLogin(payload.login) };
    }

    #requireAdmin(req, res) {
        const viewer = this.#viewerFrom(req);
        if (!viewer) {
            res.status(401).json({ error: 'unauthorized' });
            return null;
        }
        if (!viewer.isAdmin) {
            res.status(403).json({ error: 'forbidden' });
            return null;
        }
        return viewer;
    }

    /**
     * Cross-type collision context for trigger validation: commands saves need
     * the live AI prefixes; bot_settings saves need every owned command trigger.
     */
    async #buildCollisionContext(type) {
        try {
            if (!this.#configStore) return {};
            if (type === 'commands') {
                const { value: botSettings } = await this.#configStore.get('bot_settings');
                return {
                    aiPrefixes: String(botSettings?.bot_command_name || '')
                        .split(',')
                        .map((s) => s.trim().toLowerCase().slice(0, 32))
                        .filter(Boolean)
                };
            }
            if (type === 'bot_settings') {
                const { value: commands } = await this.#configStore.get('commands');
                return { commandTriggers: collectExactTriggers(commands) };
            }
        } catch {
            // Collision checks are best-effort guards, never save blockers on lookup failure.
        }
        return {};
    }

    async #applyConfig(type, value) {
        if (type === 'bot_settings') {
            // Ticket-10 contract: a saved list — even empty — wins, so presence
            // of the key (not truthiness) gates the live sync below. Provider
            // traffic only happens when the effective channel set changed;
            // IRC reconciliation still runs because desired equality is not
            // proof that Twitch confirmed membership.
            if (Array.isArray(value?.channels) && typeof this.#transport?.syncChannels === 'function') {
                const desired = new Set(value.channels.map(channelKey).filter(k => k && k !== '#'));
                const current = new Set((this.#transport.channels || []).map(channelKey));
                const changed = desired.size !== current.size || [...desired].some(k => !current.has(k));
                await this.#transport.syncChannels(value.channels);
                if (changed && this.#emotePool?.sync && this.#transport?.channels) {
                    await this.#emotePool.sync(this.#transport.channels, this.#transport.channelIdMap);
                }
            }
            if (Array.isArray(value?.ignored_usernames) && typeof this.#transport?.setIgnoredUsernames === 'function') {
                this.#transport.setIgnoredUsernames(value.ignored_usernames);
            }
            if (this.#aiEngine?.reloadSettings) {
                this.#aiEngine.reloadSettings({
                    modelName: value?.model_name,
                    thinkingLevel: value?.thinking_level,
                    searchGrounding: value?.search_grounding,
                    tavilySearchDepth: value?.tavily_search_depth,
                    historyLength: value?.ai_history_length
                });
            }
            if (this.#emotePool?.reloadSettings) {
                this.#emotePool.reloadSettings({
                    appendEnabled: value?.enable_emote_appending
                });
            }
            if (value?.cooldown_duration !== undefined && this.#chatRouter) {
                this.#chatRouter.cooldownDuration = value.cooldown_duration;
            }
            if (value?.chat_context_length !== undefined && this.#chatRouter) {
                this.#chatRouter.chatContextLength = value.chat_context_length;
            }
            if (value?.bot_command_name !== undefined && this.#chatRouter?.reloadAiPrefixes) {
                this.#chatRouter.reloadAiPrefixes(value.bot_command_name);
            }
            if (value?.reply_mode !== undefined && this.#chatRouter?.reloadReplyMode) {
                this.#chatRouter.reloadReplyMode(value.reply_mode);
            }
            if (value?.ignore_emote_only_prompts !== undefined && this.#chatRouter?.reloadIgnoreEmoteOnlyPrompts) {
                this.#chatRouter.reloadIgnoreEmoteOnlyPrompts(value.ignore_emote_only_prompts);
            }
        } else if (type === 'stream_actions') {
            this.#aiEngine?.reloadStreamActions?.(value);
            this.#helixActions?.reloadSettings?.({ clipCooldownSeconds: value?.clip_cooldown_seconds });
        } else if (type === 'system_instructions') {
            this.#chatRouter?.reloadSystemInstructions?.(value);
            this.#aiEngine?.reloadFileContext?.(value);
        } else if (type === 'commands') {
            if (Array.isArray(value?.custom)) {
                this.#chatRouter?.reloadCustomCommands?.(value.custom);
            }
            if (value?.media) {
                this.#chatRouter?.reloadMediaCommands?.(value.media);
                this.#mediaPipeline?.reloadTargets?.(value.media);
            }
        } else if (type === 'event_alerts') {
            this.#chatRouter?.reloadEventAlerts?.(value);
        } else if (type === 'error_messages') {
            this.#errorHandler?.reload?.(value);
        }
        this.broadcast({ type: 'config:updated', key: type });
    }

    async #exchangeDashboardUser(code, redirectUri) {
        const tokenParams = new URLSearchParams({
            client_id: this.#clientId,
            client_secret: this.#clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
        });

        const tokenRes = await this.#fetchImpl('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString()
        });

        if (!tokenRes.ok) {
            const text = await tokenRes.text();
            throw new Error(`Twitch OAuth token exchange failed (${tokenRes.status}): ${text}`);
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;
        if (!accessToken) throw new Error('Missing access_token from Twitch OAuth response');

        const userRes = await this.#fetchImpl('https://api.twitch.tv/helix/users', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Client-Id': this.#clientId
            }
        });

        if (!userRes.ok) {
            const text = await userRes.text();
            throw new Error(`Twitch Helix /users failed (${userRes.status}): ${text}`);
        }

        const userData = await userRes.json();
        const user = userData.data?.[0];
        if (!user) throw new Error('No user data returned from Twitch Helix');

        return {
            id: user.id,
            login: user.login,
            display_name: user.display_name,
            profile_image_url: user.profile_image_url
        };
    }

    #mountRoutes() {
        this.#mountWebSocket();

        this.#app.head('/healthz', (_req, res) => {
            res.status(204).end();
        });

        this.#app.get('/healthz', (_req, res) => {
            res.type('text/plain').set('Cache-Control', 'no-store').send('OK');
        });

        this.#app.get('/auth/dashboard', (req, res) => {
            try {
                if (!this.#clientId) {
                    res.status(500).send('TWITCH_CLIENT_ID is not configured.');
                    return;
                }
                const nonce = crypto.randomBytes(16).toString('hex');
                res.append('Set-Cookie', serializeCookie(STATE_COOKIE, nonce, {
                    maxAge: 600,
                    httpOnly: true,
                    sameSite: 'Lax',
                    path: '/',
                    secure: req.secure
                }));
                const redirectUri = this.#redirectUri(req);
                const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(this.#clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=&state=dashboard:${nonce}`;
                res.redirect(authUrl);
            } catch (error) {
                console.error('[Auth] Failed to build dashboard auth URL:', error);
                res.status(500).send('Failed to start Twitch dashboard authorization.');
            }
        });

        this.#app.get('/auth/login', (req, res) => {
            try {
                if (!this.#botUsername) {
                    res.status(500).send('TWITCH_USERNAME is not configured.');
                    return;
                }
                res.redirect(this.#transport.auth.getLoginUrl(this.#redirectUri(req)));
            } catch (error) {
                console.error('[Auth] Failed to build Twitch auth URL:', error);
                res.status(500).send('Failed to start Twitch authorization.');
            }
        });

        this.#app.get('/auth/broadcaster', (req, res) => {
            try {
                const rawChannel = req.query.channel || this.#transport.channels[0] || '';
                const channel = String(rawChannel).replace(/^#/, '').trim();
                if (!channel) {
                    return res.status(400).send('Channel parameter is required (e.g. /auth/broadcaster?channel=mychannel)');
                }
                const redirectUri = this.#redirectUri(req);
                const url = this.#transport.auth.getBroadcasterLoginUrl(redirectUri, channel);
                res.redirect(url);
            } catch (error) {
                console.error('[Auth] Failed to build Broadcaster auth URL:', error);
                res.status(500).send('Failed to start Broadcaster authorization.');
            }
        });

        this.#app.get('/auth/callback', async (req, res) => {
            const { code, state, error, error_description: errorDescription } = req.query;
            if (error) {
                res.status(400).type('html').send(this.#renderAuthErrorCard(
                    'Twitch authorization failed',
                    errorDescription || error
                ));
                return;
            }
            if (!code) {
                res.status(400).type('html').send(this.#renderAuthErrorCard(
                    'Missing authorization code',
                    'Start the authorization again from the dashboard.'
                ));
                return;
            }
            const redirectUri = this.#redirectUri(req);

            if (state && String(state).startsWith('dashboard:')) {
                const nonce = String(state).slice('dashboard:'.length);
                const cookies = parseCookies(req.headers?.cookie);
                const got = cookies[STATE_COOKIE];
                res.append('Set-Cookie', clearCookieHeader(STATE_COOKIE, { secure: req.secure }));
                if (!got || got !== nonce) {
                    return res.status(400).type('html').send(this.#renderAuthErrorCard(
                        'Invalid login state',
                        'The request expired. Start the authorization again from the dashboard.'
                    ));
                }
                try {
                    const user = await this.#exchangeDashboardUser(String(code), redirectUri);
                    const token = createSessionToken({
                        login: user.login,
                        userId: user.id,
                        displayName: user.display_name,
                        profileImageUrl: user.profile_image_url
                    }, this.#sessionSecret, { ttlMs: this.#sessionTtlMs });
                    res.append('Set-Cookie', serializeCookie(COOKIE_NAME, token, {
                        httpOnly: true,
                        sameSite: 'Lax',
                        path: '/',
                        maxAge: this.#sessionTtlMs / 1000,
                        secure: req.secure
                    }));
                    return res.redirect(303, '/');
                } catch (authError) {
                    console.error('[Auth] Dashboard callback failed:', authError);
                    return res.status(500).type('html').send(this.#renderAuthErrorCard(
                        'Sign-in failed',
                        'Sign-in with Twitch failed. Try again.'
                    ));
                }
            }

            if (state && String(state).startsWith('broadcaster:')) {
                const channel = String(state).slice('broadcaster:'.length);
                try {
                    await this.#transport.auth.handleBroadcasterCallback(channel, String(code), redirectUri);
                    this.broadcast({ type: 'auth:broadcaster', channel, authorized: true });
                    const autoCloseScript = `
                    <script>
                        try {
                            if (window.opener) {
                                window.opener.postMessage({ type: 'twitch:broadcaster_authorized', channel: '${channel}' }, '*');
                                setTimeout(() => window.close(), 1200);
                            }
                        } catch (e) {}
                    </script>`;
                    const bodyHtml = `
                    <p>Alerts and stream actions are now live for <strong>#${escapeHtml(channel)}</strong>.</p>
                    <p id="closing-note" style="color: #62676e; font-size: 12px; margin-top: 4px;">Closing…</p>`;
                    res.type('html').send(this.#renderAuthSuccessHtml({
                        title: `#${channel} linked`,
                        heading: `#${channel} linked`,
                        bodyHtml,
                        autoCloseScript
                    }));
                    return;
                } catch (authError) {
                    console.error('[Auth] Broadcaster callback failed:', authError);
                    if (authError.name === 'AuthMismatchError') {
                        const retryUrl = `/auth/broadcaster?channel=${encodeURIComponent(authError.expected)}`;
                        res.status(400).type('html').send(renderAuthMismatchHtml({
                            expected: authError.expected,
                            actual: authError.actual,
                            retryUrl,
                            isBroadcaster: true
                        }));
                        return;
                    }
                    res.status(500).type('html').send(this.#renderAuthErrorCard(
                        'Broadcaster authorization failed',
                        this.#errorHandler?.format?.(authError) || 'Try linking the channel again from the dashboard.'
                    ));
                    return;
                }
            }

            try {
                await this.#transport.auth.handleCallback(String(code), redirectUri);
                await this.#broadcastBotStatus();
                const autoCloseScript = `
                <script>
                    try {
                        if (window.opener) {
                            window.opener.postMessage({ type: 'twitch:bot_authorized' }, '*');
                            setTimeout(() => window.close(), 1200);
                        }
                    } catch (e) {}
                </script>`;
                const cleanName = String(this.#botUsername || '').replace(/^@/, '');
                const bodyHtml = `
                <p id="closing-note" style="color: #62676e; font-size: 12px; margin-top: 4px;">Closing…</p>`;
                res.type('html').send(this.#renderAuthSuccessHtml({
                    title: `${cleanName} connected`,
                    heading: `${cleanName} connected`,
                    bodyHtml,
                    autoCloseScript
                }));
            } catch (authError) {
                console.error('[Auth] Callback failed:', authError);
                if (authError.name === 'AuthMismatchError') {
                    res.status(400).type('html').send(renderAuthMismatchHtml({
                        expected: authError.expected,
                        actual: authError.actual,
                        retryUrl: '/auth/login',
                        isBroadcaster: false
                    }));
                    return;
                }
                res.status(500).type('html').send(this.#renderAuthErrorCard(
                    'Twitch authorization failed',
                    this.#errorHandler?.format?.(authError) || 'Try connecting the bot account again from the dashboard.'
                ));
            }
        });

        this.#app.all(['/auth/logout', '/api/auth/logout'], (req, res) => {
            res.append('Set-Cookie', clearCookieHeader(COOKIE_NAME, { secure: req.secure }));
            if (req.method === 'GET') {
                return res.redirect(303, '/');
            }
            res.json({ ok: true });
        });

        this.#app.get('/api/me', (req, res) => {
            const viewer = this.#viewerFrom(req);
            if (!viewer) {
                return res.json({ authenticated: false });
            }
            res.json({
                authenticated: true,
                login: viewer.login,
                displayName: viewer.displayName,
                profileImageUrl: viewer.profileImageUrl,
                isAdmin: viewer.isAdmin
            });
        });

        this.#app.get('/api/media/catalog', async (req, res) => {
            if (!this.#requireAdmin(req, res)) return;
            const data = await this.#mediaPipeline?.catalog?.();
            res.json(data || { image: [], video: [], tts: [], music: [] });
        });

        this.#app.get('/api/config', async (req, res) => {
            if (!this.#requireAdmin(req, res)) return;
            if (!this.#configStore) {
                return res.status(503).json({ error: 'config_unavailable' });
            }
            const all = await this.#configStore.getAll();
            // Seed only legacy docs that predate the channels key; a saved
            // empty list means the streamer removed every channel on purpose.
            if (all?.bot_settings && !Array.isArray(all.bot_settings.channels) && this.#transport?.channels?.length) {
                all.bot_settings.channels = this.#transport.channels.map((c) => String(c).replace(/^#/, '').toLowerCase());
            }
            res.json(all);
        });

        this.#app.get('/api/config/defaults/:type', (req, res) => {
            if (!this.#requireAdmin(req, res)) return;
            const type = req.params.type;
            if (!CONFIG_TYPES.includes(type)) {
                return res.status(404).json({ error: 'unknown_type' });
            }
            if (!this.#configStore) {
                return res.status(503).json({ error: 'config_unavailable' });
            }
            const defaults = this.#configStore.defaults || {};
            res.json({ type, value: defaults[type] });
        });

        this.#app.post('/api/config/:type', async (req, res) => {
            if (!this.#requireAdmin(req, res)) return;
            const type = req.params.type;
            if (!CONFIG_TYPES.includes(type)) {
                return res.status(404).json({ error: 'unknown_type' });
            }
            if (!this.#configStore) {
                return res.status(503).json({ error: 'config_unavailable' });
            }
            try {
                const payload = req.body?.value !== undefined ? req.body.value : req.body;
                const saveContext = await this.#buildCollisionContext(type);
                const { value, override } = await this.#configStore.set(type, payload, saveContext);
                await this.#applyConfig(type, value);
                res.json({ type, value, override });
            } catch (err) {
                if (err.code === 'INVALID_CONFIG') {
                    return res.status(400).json({ error: 'invalid_config', message: err.message });
                }
                console.error(`[WebServer] Config save failed for ${type}:`, err);
                res.status(500).json({ error: 'internal_error' });
            }
        });

        this.#app.post('/api/config/:type/reset', async (req, res) => {
            if (!this.#requireAdmin(req, res)) return;
            const type = req.params.type;
            if (!CONFIG_TYPES.includes(type)) {
                return res.status(404).json({ error: 'unknown_type' });
            }
            if (!this.#configStore) {
                return res.status(503).json({ error: 'config_unavailable' });
            }
            try {
                const saveContext = await this.#buildCollisionContext(type);
                const { value, override } = await this.#configStore.reset(type, saveContext);
                await this.#applyConfig(type, value);
                res.json({ type, value, override });
            } catch (err) {
                if (err.code === 'INVALID_CONFIG') {
                    return res.status(400).json({ error: 'invalid_config', message: err.message });
                }
                console.error(`[WebServer] Config reset failed for ${type}:`, err);
                res.status(500).json({ error: 'internal_error' });
            }
        });

        this.#app.post('/api/alerts/test', async (req, res) => {
            if (!this.#requireAdmin(req, res)) return;
            if (!this.#aiEngine?.generate) {
                return res.status(503).json({ error: 'ai_unavailable', message: 'AI engine is not configured.' });
            }
            try {
                const { eventKind = 'subscription', prompt = '', personaOverride = '' } = req.body || {};
                const vars = SAMPLE_ALERT_VARS[eventKind] || { username: 'CoolViewer', tier: 'Tier 1' };
                const interpolated = String(prompt || '').replace(/\{(\w+)\}/g, (_, key) => {
                    const val = vars[key];
                    return val == null ? `{${key}}` : String(val);
                });
                const framed = `[Event Alert: ${eventKind}] ${interpolated}`;
                const harness = [
                    this.#emotePool?.getHarnessInstructions?.() || '',
                    EVENT_REACTION_HARNESS
                ];
                const testChan = `__test_alert_${Date.now()}__`;
                try {
                    const raw = await this.#aiEngine.generate(framed, {
                        channel: testChan,
                        harnessInstructions: harness,
                        overrideFileContext: personaOverride || this.#chatRouter?.systemInstructions || '',
                        disableTools: true,
                        caller: {
                            loginName: String(vars.username || 'tester'),
                            isBroadcaster: false,
                            isMod: false
                        }
                    });
                    const reply = this.#emotePool?.decorateReply
                        ? this.#emotePool.decorateReply(null, raw, { maxLength: 499 })
                        : raw;
                    res.json({ ok: true, reply });
                } finally {
                    this.#aiEngine.clearHistory?.(testChan);
                }
            } catch (err) {
                console.error('[WebServer] Alert test reply failed:', err);
                res.status(500).json({ error: 'generation_failed', message: this.#publicError(err) });
            }
        });

        this.#app.get(['/auth/status', '/api/status'], async (_req, res) => {
            res.json(await this.#currentBotStatus());
        });

        this.#app.get('/api/channels', (_req, res) => res.json(this.#transport.channels));

        this.#app.get('/api/channel-status', async (_req, res) => res.json(await this.#transport.getChannelAuthStatuses()));

        this.#app.get('/api/emotes/:channel', (req, res) => {
            res.set('Cache-Control', 'public, max-age=300');
            res.json(this.#emotePool?.getEmoteMap?.(req.params.channel) || {});
        });

        this.#app.get('/api/badges/:channel', async (req, res) => {
            res.set('Cache-Control', 'no-cache');
            const channel = String(req.params.channel || '').replace(/^#/, '').toLowerCase();
            await this.#transport?.badges?.refreshGlobal?.();
            res.json(this.#transport?.badges?.getForChannel?.(channel) || {
                channel,
                badges: { channel: {}, global: {} }
            });
        });

        this.#app.post('/api/users/avatars', async (req, res) => {
            const rawIdentities = req.body?.identities;
            if (!Array.isArray(rawIdentities)) {
                return res.status(400).json({ error: 'INVALID_AVATAR_LOOKUP' });
            }
            if (rawIdentities.length > HELIX_LOOKUP_BATCH) {
                return res.status(400).json({ error: 'AVATAR_LOOKUP_LIMIT_EXCEEDED' });
            }

            const valid = [];
            const results = [];
            const seen = new Set();
            for (const raw of rawIdentities) {
                const key = typeof raw?.key === 'string' ? raw.key : '';
                if (!key || seen.has(key)) continue;
                seen.add(key);

                const userId = String(raw?.userId || '').trim();
                const login = String(raw?.login || '').trim().toLowerCase();
                if (/^\d+$/.test(userId) && key === `id:${userId}`) {
                    valid.push({ key, userId });
                } else if (/^[a-z0-9_]{1,25}$/.test(login) && key === `login:${login}`) {
                    valid.push({ key, login });
                } else {
                    results.push({ key, status: 'invalid' });
                }
            }

            const toFetch = [];
            for (const identity of valid) {
                const avatarUrl = this.#avatarCache.get(identity.key);
                if (avatarUrl) {
                    results.push({ key: identity.key, status: 'resolved', avatarUrl });
                } else {
                    toFetch.push(identity);
                }
            }

            if (toFetch.length === 0) return res.json({ results });
            if (!this.#transport?.helix?.request) {
                if (this.#isDevMock) {
                    results.push(...toFetch.map(({ key }) => ({ key, status: 'unavailable' })));
                    return res.json({ results });
                }
                return res.status(503).json({ error: 'AVATAR_LOOKUP_UNAVAILABLE' });
            }

            try {
                const ids = toFetch.flatMap((identity) => identity.userId ? [identity.userId] : []);
                const logins = toFetch.flatMap((identity) => identity.login ? [identity.login] : []);
                const data = await this.#transport.helix.request('/users', {
                    query: { id: ids, login: logins },
                    useAppToken: true
                });
                const usersById = new Map();
                const usersByLogin = new Map();
                for (const user of data?.data || []) {
                    if (user.id) usersById.set(String(user.id), user);
                    if (user.login) usersByLogin.set(String(user.login).toLowerCase(), user);
                }
                const cacheAvatar = (key, avatarUrl) => {
                    if (!key) return;
                    while (this.#avatarCache.size >= AVATAR_CACHE_MAX) {
                        this.#avatarCache.delete(this.#avatarCache.keys().next().value);
                    }
                    this.#avatarCache.set(key, avatarUrl);
                };

                for (const identity of toFetch) {
                    const user = identity.userId
                        ? usersById.get(identity.userId)
                        : usersByLogin.get(identity.login);
                    const avatarUrl = user?.profile_image_url;
                    if (!avatarUrl) {
                        results.push({ key: identity.key, status: 'unavailable' });
                        continue;
                    }

                    cacheAvatar(identity.key, avatarUrl);
                    cacheAvatar(user.id ? `id:${user.id}` : '', avatarUrl);
                    cacheAvatar(user.login ? `login:${String(user.login).toLowerCase()}` : '', avatarUrl);
                    results.push({
                        key: identity.key,
                        status: 'resolved',
                        avatarUrl,
                        userId: String(user.id || ''),
                        login: String(user.login || '').toLowerCase()
                    });
                }
                return res.json({ results });
            } catch (err) {
                console.warn('[WebServer] Failed to fetch avatars from Helix:', err.message);
                return res.status(503).json({ error: 'AVATAR_LOOKUP_UNAVAILABLE' });
            }
        });

        this.#app.get('/api/chat/:channel', async (req, res) => {
            let channel = req.params.channel;
            if (!channel.startsWith('#')) channel = '#' + channel;
            const rawLimit = req.query.limit;
            const rawCursor = req.query.cursor;
            if (
                (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))) ||
                (rawCursor !== undefined && (typeof rawCursor !== 'string' || rawCursor.length === 0))
            ) {
                return res.status(400).json({ error: 'INVALID_PAGINATION' });
            }
            const requestedLimit = rawLimit === undefined ? MAX_CHAT_PAGE_SIZE : Number(rawLimit);
            if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
                return res.status(400).json({ error: 'INVALID_PAGINATION' });
            }

            const page = await this.#storage.getChatLogPage(channel, {
                limit: Math.min(requestedLimit, MAX_CHAT_PAGE_SIZE),
                cursor: rawCursor || null
            });
            if (!page?.ok) {
                if (page?.error === 'INVALID_CURSOR' || page?.error === 'INVALID_LIMIT') {
                    return res.status(400).json({ error: page.error });
                }
                if (page?.error === 'STALE_CURSOR') {
                    return res.status(409).json({ error: page.error });
                }
                return res.status(503).json({ error: 'CHAT_HISTORY_UNAVAILABLE' });
            }
            return res.json({
                entries: page.entries,
                nextCursor: page.nextCursor,
                hasMore: page.hasMore
            });
        });

        this.#app.get('/api/media', async (_req, res) => {
            const media = await this.#storage.getMediaLog();
            res.json(media);
        });

        this.#app.get('/gemini/:text', async (req, res) => {
            if (!this.#aiEngine?.generate) {
                res.status(503).send('AI engine is not configured.');
                return;
            }
            try {
                const harness = this.#emotePool?.getHarnessInstructions?.() || '';
                const answer = await this.#aiEngine.generate(req.params.text, {
                    harnessInstructions: harness
                });
                const body = this.#emotePool?.decorateReply
                    ? this.#emotePool.decorateReply(null, answer, { appendEmote: false })
                    : answer;
                res.send(body);
            } catch (error) {
                console.error('Error generating response:', error);
                res.status(500).send(this.#publicError(error));
            }
        });

        this.#app.get('/', (_req, res) => {
            const indexPath = path.resolve(this.#distDir, 'index.html');
            if (fs.existsSync(indexPath)) {
                return res.sendFile(indexPath);
            }
            res.type('html').send(`<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>Twitch Gemini AI Chatbot</title>
    <style>
        body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.5; text-align: center; background: #101113; color: #e8eaed; }
        .spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid rgba(162,115,255,0.3); border-radius: 50%; border-top-color: #a273ff; animation: spin 1s ease-in-out infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="spinner"></div>
    <h1>Twitch Gemini AI Chatbot</h1>
    <p>Dashboard build artifact not found. Please run <code>npm run build</code>.</p>
</body>
</html>`);
        });
    }
}

export default WebServer;
