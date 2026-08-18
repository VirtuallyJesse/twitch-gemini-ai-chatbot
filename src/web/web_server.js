// src/web/web_server.js
//
// Deep module owning the HTTP/WebSocket runtime: Express routes, EJS dashboard,
// Twitch OAuth callback pages, client fan-out with ping/pong sweep, and the
// Render keep-alive worker. All collaborators and config cross the constructor.

import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderAuthMismatchHtml } from '../twitch/twitch_transport.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VIEWS_DIR = path.resolve(moduleDir, '../../views');
const DEFAULT_PUBLIC_DIR = path.resolve(moduleDir, '../../public');
const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 10_000;

export class WebServer {
    #transport;
    #storage;
    #aiEngine;
    #emotePool;
    #mediaPipeline;
    #errorHandler;
    #botUsername;
    #externalUrl;
    #keepAliveIntervalMs;
    #heartbeatIntervalMs;
    #fetchImpl;
    #host;
    #preferredPort;

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
    #prevOnMediaSaved = undefined;

    constructor(options = {}) {
        const {
            transport,
            storage,
            aiEngine = null,
            emotePool = null,
            mediaPipeline = null,
            errorHandler = null,
            port = 3000,
            host,
            botUsername = '',
            externalUrl = '',
            keepAliveIntervalMs = DEFAULT_KEEP_ALIVE_MS,
            heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
            viewsDir = DEFAULT_VIEWS_DIR,
            publicDir = DEFAULT_PUBLIC_DIR,
            trustProxy = 1,
            fetchImpl = globalThis.fetch.bind(globalThis)
        } = options;

        if (!transport) throw new Error('WebServer requires transport');
        if (!storage) throw new Error('WebServer requires storage');

        this.#transport = transport;
        this.#storage = storage;
        this.#aiEngine = aiEngine;
        this.#emotePool = emotePool;
        this.#mediaPipeline = mediaPipeline;
        this.#errorHandler = errorHandler;
        this.#botUsername = String(botUsername || '');
        this.#externalUrl = String(externalUrl || '').trim();
        this.#keepAliveIntervalMs = Number(keepAliveIntervalMs) || DEFAULT_KEEP_ALIVE_MS;
        this.#heartbeatIntervalMs = Number(heartbeatIntervalMs) || DEFAULT_HEARTBEAT_MS;
        this.#fetchImpl = fetchImpl;
        this.#host = host;
        this.#preferredPort = port ?? 3000;

        const app = express();
        this.#wsInstance = expressWs(app);
        this.#app = app;

        if (trustProxy !== false && trustProxy !== undefined) {
            app.set('trust proxy', trustProxy);
        }
        app.set('view engine', 'ejs');
        app.set('views', viewsDir);
        app.use(express.json({ limit: '1mb' }));
        app.use('/public', express.static(publicDir));

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

    #renderAuthSuccessHtml({ title, heading, bodyHtml, badgeBg = '#9147ff', autoCloseScript = '' }) {
        return `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
        body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.5; text-align: center; }
        .badge { display: inline-flex; align-items: center; justify-content: center; background: ${badgeBg}; color: white; border-radius: 50%; width: 48px; height: 48px; font-size: 24px; font-weight: bold; margin: 0 auto 16px; }
        a { color: #9147ff; }
    </style>
</head>
<body>
    <div class="badge">✓</div>
    <h1>${heading}</h1>
    ${bodyHtml}
    <p><a href="/">Return to the dashboard</a></p>
    ${autoCloseScript}
</body>
</html>`;
    }

    #mountRoutes() {
        this.#mountWebSocket();

        this.#app.head('/healthz', (_req, res) => {
            res.status(204).end();
        });

        this.#app.get('/healthz', (_req, res) => {
            res.type('text/plain').set('Cache-Control', 'no-store').send('OK');
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
                res.status(400).send(`Twitch authorization failed: ${errorDescription || error}`);
                return;
            }
            if (!code) {
                res.status(400).send('Missing authorization code.');
                return;
            }
            const redirectUri = this.#redirectUri(req);

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
                    <p>Channel <strong>${channel}</strong> has authorized stream management actions.</p>
                    <p id="closing-note" style="color: #666; font-size: 14px;">This window will close automatically...</p>`;
                    res.type('html').send(this.#renderAuthSuccessHtml({
                        title: 'Broadcaster Authorized',
                        heading: 'Broadcaster authorization complete',
                        bodyHtml,
                        badgeBg: '#22c55e',
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
                    res.status(500).send(
                        this.#errorHandler?.format?.(authError) || 'Broadcaster authorization failed. Please try again.'
                    );
                    return;
                }
            }

            try {
                await this.#transport.auth.handleCallback(String(code), redirectUri);
                const bodyHtml = `<p>The bot account (<strong>@${this.#botUsername}</strong>) is now connected.</p>`;
                res.type('html').send(this.#renderAuthSuccessHtml({
                    title: 'Twitch Authorized',
                    heading: 'Twitch authorization complete',
                    bodyHtml,
                    badgeBg: '#9147ff'
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
                res.status(500).send(
                    this.#errorHandler?.format?.(authError) || 'Twitch authorization failed. Please try again.'
                );
            }
        });

        this.#app.get('/auth/status', async (_req, res) => {
            const status = this.#transport.auth.getStatus();
            const channelStatuses = await this.#transport.getChannelAuthStatuses();
            res.json({ ...status, channelStatuses });
        });

        this.#app.get('/api/channels', (_req, res) => res.json(this.#transport.channels));

        this.#app.get('/api/channel-status', async (_req, res) => res.json(await this.#transport.getChannelAuthStatuses()));

        this.#app.get('/api/emotes/:channel', (req, res) => {
            res.set('Cache-Control', 'public, max-age=300');
            res.json(this.#emotePool?.getEmoteMap?.(req.params.channel) || {});
        });

        this.#app.get('/api/chat/:channel', async (req, res) => {
            let channel = req.params.channel;
            if (!channel.startsWith('#')) channel = '#' + channel;

            const buffer = await this.#storage.getChatLog(channel);
            res.json(buffer);
        });

        this.#app.get('/api/media', async (_req, res) => {
            const media = await this.#storage.getMediaLog();
            res.json(media);
        });

        this.#app.get('/', (req, res) => {
            if (!this.#transport.auth.isAuthorized()) {
                const authUrl = '/auth/login';
                res.type('html').send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8" />
                <title>Twitch Bot Setup</title>
                <style>
                    body { font-family: sans-serif; max-width: 760px; margin: 60px auto; padding: 0 20px; line-height: 1.6; }
                    a.button {
                        display: inline-block;
                        background: #9147ff;
                        color: white;
                        text-decoration: none;
                        padding: 12px 18px;
                        border-radius: 8px;
                        font-weight: 600;
                    }
                    a.button:hover { background: #772ce8; }
                    .info-box { background: #f3e8ff; border: 1px solid #d8b4fe; border-radius: 8px; padding: 14px 18px; margin: 20px 0; color: #581c87; }
                    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
                </style>
            </head>
            <body>
                <h1>Twitch authorization required</h1>
                <p>This bot is configured for Twitch account: <strong>@${this.#botUsername}</strong></p>
                <div class="info-box">
                    💡 <strong>Important:</strong> Make sure you are logged into Twitch as <strong>@${this.#botUsername}</strong> in this browser (or open this page in an <strong>Incognito / Private window</strong>) before clicking authorize.
                </div>
                <p>Make sure your Twitch application redirect URL is set to:</p>
                <p><code>${this.#requestOrigin(req)}/auth/callback</code></p>
                <p style="margin-top: 24px;"><a class="button" href="${authUrl}">Authorize @${this.#botUsername}</a></p>
            </body>
            </html>
        `);
                return;
            }

            res.render('pages/index', {
                storageConfigured: Boolean(this.#storage.configured),
                twitchAuthorized: true,
                twitchConnected: Boolean(this.#transport.connected),
                twitchAuthUrl: '/auth/login'
            });
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
    }
}

export default WebServer;
