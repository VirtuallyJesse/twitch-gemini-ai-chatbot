import express from 'express';
import expressWs from 'express-ws';
import WebSocket from 'ws';
import fs from 'fs';
import { job } from './utils/keep_alive.js';
import { AIEngine } from './ai/ai_engine.js';
import { EmotePool } from './twitch/emote_pool.js';
import { MediaUploader } from './media/media_uploader.js';
import { MediaPipeline } from './media/media_pipeline.js';
import ErrorHandler from './utils/error_handler.js';
import { PollinationsProvider } from './media/pollinations_provider.js';
import { TavilySearchProvider } from './ai/tavily_search_provider.js';
import { Storage } from './utils/storage.js';
import { TwitchTransport, renderAuthMismatchHtml } from './twitch/twitch_transport.js';
import { ChatRouter } from './twitch/chat_router.js';
import { createHelixTools } from './twitch/helix_actions.js';

job.start();

const storage = new Storage({
    redisUrl: process.env.UPSTASH_REDIS_URL,
    restUrl: process.env.UPSTASH_REDIS_REST_URL,
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN
});

const app = express();
const wsInstance = expressWs(app);
app.set('trust proxy', 1);

const broadcastWs = (data) => {
    wsInstance.getWss().clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(JSON.stringify(data));
        }
    });
};

app.head('/healthz', (_req, res) => {
    res.status(204).end();
});

app.get('/healthz', (_req, res) => {
    res.type('text/plain').set('Cache-Control', 'no-store').send('OK');
});

app.set('view engine', 'ejs');

const AI_HISTORY_LENGTH = process.env.AI_HISTORY_LENGTH || 5;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const MODEL_NAME = process.env.MODEL_NAME || 'gemini-3.7-flash';
const IMAGE_COMMAND_NAME = process.env.IMAGE_COMMAND_NAME || '!image';
const VIDEO_COMMAND_NAME = process.env.VIDEO_COMMAND_NAME || '!video';
const TTS_COMMAND_NAME = process.env.TTS_COMMAND_NAME || '!tts';
const MUSIC_COMMAND_NAME = process.env.MUSIC_COMMAND_NAME || '!song';
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || '';
const TWITCH_USERNAME = process.env.TWITCH_USERNAME || '';
const BOT_COMMAND_NAME = process.env.BOT_COMMAND_NAME || '!gemini';
const JOIN_CHANNELS = process.env.JOIN_CHANNELS || '';
const COOLDOWN_DURATION = process.env.COOLDOWN_DURATION !== undefined ? parseInt(process.env.COOLDOWN_DURATION, 10) : 1;
const SEARCH_GROUNDING = process.env.SEARCH_GROUNDING || '';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const TAVILY_SEARCH_DEPTH = process.env.TAVILY_SEARCH_DEPTH || 'basic';
const THINKING_LEVEL = process.env.THINKING_LEVEL || 'medium';
const IGNORED_USERNAMES = process.env.IGNORED_USERNAMES || '';
const ignoredUsernames = IGNORED_USERNAMES.split(',').map(user => user.trim().toLowerCase()).filter(Boolean);
const ENABLE_HELIX_ACTIONS = process.env.ENABLE_HELIX_ACTIONS !== 'false';
const HELIX_CLIP_COOLDOWN_SECONDS = Number(process.env.HELIX_CLIP_COOLDOWN_SECONDS) || 30;
const HELIX_DEFAULT_TIMEOUT_SECONDS = Number(process.env.HELIX_DEFAULT_TIMEOUT_SECONDS) || 600;

if (!GEMINI_API_KEY) {
    console.error('No GEMINI_API_KEY found. Please set it as an environment variable.');
}

const searchSlot = String(SEARCH_GROUNDING).toLowerCase();
const wantsTavily = searchSlot === 'tavily' || searchSlot === 'custom';

let searchProvider = null;
if (wantsTavily && TAVILY_API_KEY) {
    searchProvider = new TavilySearchProvider({
        apiKey: TAVILY_API_KEY,
        searchDepth: TAVILY_SEARCH_DEPTH,
        storage
    });
    searchProvider.startBackgroundProbe().catch(err => {
        console.warn('[Tavily] Startup probe failed:', err?.message || err);
    });
} else if (wantsTavily) {
    console.warn('[Search] SEARCH_GROUNDING is tavily/custom but TAVILY_API_KEY is empty. Web search disabled.');
}

const commandNames = BOT_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const imageCommandNames = IMAGE_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const videoCommandNames = VIDEO_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const ttsCommandNames = TTS_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const musicCommandNames = MUSIC_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const channels = JOIN_CHANNELS.split(',').map(channel => channel.trim()).filter(Boolean);
let fileContext = 'You are a helpful Twitch Chatbot.';

const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : String(v) === 'true');
const csv = (v) => String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const emotes = new EmotePool({
    storage,
    fetchImpl: fetch,
    wsImpl: WebSocket,
    enable7tv: bool(process.env.ENABLE_7TV_EMOTES, true),
    enableBttv: bool(process.env.ENABLE_BTTV_EMOTES, true),
    enableFfz: bool(process.env.ENABLE_FFZ_EMOTES, false),
    include7tvGlobals: bool(process.env.INCLUDE_7TV_GLOBAL_EMOTES, false),
    includeBttvGlobals: bool(process.env.INCLUDE_BTTV_GLOBAL_EMOTES, false),
    includeFfzGlobals: bool(process.env.INCLUDE_FFZ_GLOBAL_EMOTES, false),
    timeoutMs: Number(process.env.EMOTE_FETCH_TIMEOUT_MS ?? 10_000),
    appendEnabled: bool(process.env.ENABLE_EMOTE_APPENDING, true),
    excludePrefixes: csv(process.env.EMOTE_APPEND_EXCLUDE_PREFIXES)
});

emotes.on('update', ({ channel, emotes: map }) => {
    broadcastWs({ type: 'emotes:update', channel, emotes: map });
});

try {
    fileContext = fs.readFileSync('./system_instructions.txt', 'utf8');
} catch (error) {
    console.error('Error reading system_instructions.txt:', error);
}

const mediaUploader = new MediaUploader();
const errorHandler = new ErrorHandler();

function isUsableSecret(value) {
    const key = String(value || '').trim();
    return key.length > 0 && key !== 'your-pollinations-api-key';
}

const mediaProviders = [];
if (isUsableSecret(POLLINATIONS_API_KEY)) {
    mediaProviders.push(new PollinationsProvider({
        apiKey: POLLINATIONS_API_KEY,
        imageModel: process.env.POLLINATIONS_IMAGE_MODEL || 'gptimage',
        videoModel: process.env.POLLINATIONS_VIDEO_MODEL || 'seedance',
        ttsModel: process.env.POLLINATIONS_TTS_MODEL || 'elevenlabs',
        ttsVoice: process.env.POLLINATIONS_TTS_VOICE || 'charlotte',
        musicModel: process.env.POLLINATIONS_MUSIC_MODEL || 'elevenmusic'
    }));
} else {
    console.log('[Media] Pollinations disabled (missing or placeholder API key).');
}

const CHAT_CONTEXT_LENGTH = parseInt(process.env.CHAT_CONTEXT_LENGTH, 10) || 10;

const transport = new TwitchTransport({
    clientId: process.env.TWITCH_CLIENT_ID || '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
    botUsername: TWITCH_USERNAME,
    channels,
    initialRefreshToken: process.env.TWITCH_REFRESH_TOKEN || '',
    storage,
    ignoredUsernames
});

let helixTools = [];
if (ENABLE_HELIX_ACTIONS) {
    const helixActionSuite = createHelixTools({
        transport,
        clipCooldownSeconds: HELIX_CLIP_COOLDOWN_SECONDS,
        defaultTimeoutSeconds: HELIX_DEFAULT_TIMEOUT_SECONDS
    });
    helixTools = helixActionSuite.tools;
}

const aiEngine = new AIEngine({
    apiKeys: GEMINI_API_KEY,
    modelName: MODEL_NAME,
    fileContext,
    historyLength: AI_HISTORY_LENGTH,
    searchGrounding: SEARCH_GROUNDING,
    searchProvider,
    thinkingLevel: THINKING_LEVEL,
    youtubeApiKey: YOUTUBE_API_KEY,
    maxResponseLength: parseInt(process.env.GEMINI_MAX_RESPONSE_LENGTH, 10) || 450,
    errorHandler,
    tools: helixTools,
    verbose: process.env.AI_VERBOSE === 'true'
});

const mediaPipeline = new MediaPipeline({
    providers: mediaProviders,
    uploader: mediaUploader,
    storage,
    aiEngine,
    errorHandler,
    emotes,
    onMediaSaved: entry => broadcastWs({ type: 'media', entry })
});

const chatRouter = new ChatRouter({
    aiEngine,
    mediaPipeline,
    emotePool: emotes,
    errorHandler,
    cooldownDuration: COOLDOWN_DURATION,
    chatContextLength: CHAT_CONTEXT_LENGTH,
    maxMessageLength: 499,
    prefixes: {
        ai: commandNames,
        image: imageCommandNames,
        video: videoCommandNames,
        tts: ttsCommandNames,
        music: musicCommandNames
    }
});

chatRouter.attach(transport);

transport.onLogEntry((channel, entry) => {
    broadcastWs({ type: 'chat', channel, entry });
    storage.addChatMessage(channel, entry).catch(err => {
        console.error('Failed to save chat to storage:', err.message);
    });
});

transport.onStatus(({ type, address, port, reason }) => {
    if (type === 'connected') {
        console.log(`* Connected to ${address}:${port}`);
        emotes.sync(transport.channels, transport.channelIdMap).then(
            () => console.log('Emote initialization completed'),
            error => console.error('Failed to initialize emotes:', error)
        );
    } else if (type === 'disconnected') {
        console.log(`Disconnected: ${reason}`);
    } else if (type === 'auth_required') {
        console.log('[Twitch] Authorization required. Bot runtime is waiting.');
    }
});

function getRequestOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function getTwitchRedirectUri(req) {
    return `${getRequestOrigin(req)}/auth/callback`;
}

app.use(express.json({ limit: '1mb' }));
app.use('/public', express.static('public'));

app.ws('/ws', () => {});

app.get('/auth/login', (req, res) => {
    try {
        if (!TWITCH_USERNAME) {
            res.status(500).send('TWITCH_USERNAME is not configured.');
            return;
        }
        res.redirect(transport.auth.getLoginUrl(getTwitchRedirectUri(req)));
    } catch (error) {
        console.error('[Auth] Failed to build Twitch auth URL:', error);
        res.status(500).send('Failed to start Twitch authorization.');
    }
});

app.get('/auth/broadcaster', (req, res) => {
    try {
        const channel = req.query.channel || (transport.channels[0] || '').replace('#', '');
        if (!channel) {
            return res.status(400).send('Channel parameter is required (e.g. /auth/broadcaster?channel=mychannel)');
        }
        const redirectUri = getTwitchRedirectUri(req);
        const url = transport.auth.getBroadcasterLoginUrl(redirectUri, channel);
        res.redirect(url);
    } catch (error) {
        console.error('[Auth] Failed to build Broadcaster auth URL:', error);
        res.status(500).send('Failed to start Broadcaster authorization.');
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) { res.status(400).send(`Twitch authorization failed: ${errorDescription || error}`); return; }
    if (!code) { res.status(400).send('Missing authorization code.'); return; }
    const redirectUri = getTwitchRedirectUri(req);

    if (state && String(state).startsWith('broadcaster:')) {
        const channel = String(state).slice('broadcaster:'.length);
        try {
            await transport.auth.handleBroadcasterCallback(channel, String(code), redirectUri);
            broadcastWs({ type: 'auth:broadcaster', channel, authorized: true });
            res.type('html').send(`
                <!doctype html>
                <html>
                <head>
                    <meta charset="utf-8" />
                    <title>Broadcaster Authorized</title>
                    <style>
                        body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.5; text-align: center; }
                        .badge { display: inline-flex; align-items: center; justify-content: center; background: #22c55e; color: white; border-radius: 50%; width: 48px; height: 48px; font-size: 24px; font-weight: bold; margin: 0 auto 16px; }
                        a { color: #9147ff; }
                    </style>
                </head>
                <body>
                    <div class="badge">✓</div>
                    <h1>Broadcaster authorization complete</h1>
                    <p>Channel <strong>${channel}</strong> has authorized stream management actions.</p>
                    <p id="closing-note" style="color: #666; font-size: 14px;">This window will close automatically...</p>
                    <p><a href="/">Return to the dashboard</a></p>
                    <script>
                        try {
                            if (window.opener) {
                                window.opener.postMessage({ type: 'twitch:broadcaster_authorized', channel: '${channel}' }, '*');
                                setTimeout(() => window.close(), 1200);
                            }
                        } catch (e) {}
                    </script>
                </body>
                </html>
            `);
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
            res.status(500).send(`Broadcaster authorization failed: ${authError.message}`);
            return;
        }
    }

    try {
        await transport.auth.handleCallback(String(code), redirectUri);
        res.type('html').send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8" />
                <title>Twitch Authorized</title>
                <style>
                    body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.5; text-align: center; }
                    .badge { display: inline-flex; align-items: center; justify-content: center; background: #9147ff; color: white; border-radius: 50%; width: 48px; height: 48px; font-size: 24px; font-weight: bold; margin: 0 auto 16px; }
                    a { color: #9147ff; }
                </style>
            </head>
            <body>
                <div class="badge">✓</div>
                <h1>Twitch authorization complete</h1>
                <p>The bot account (<strong>@${TWITCH_USERNAME}</strong>) is now connected.</p>
                <p><a href="/">Return to the dashboard</a></p>
            </body>
            </html>
        `);
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
        res.status(500).send(`Authorization failed: ${authError.message}`);
    }
});

app.get('/auth/status', async (_req, res) => {
    const status = transport.auth.getStatus();
    const channelStatuses = await transport.getChannelAuthStatuses();
    res.json({ ...status, channelStatuses });
});
app.get('/api/channels', (_req, res) => res.json(transport.channels));
app.get('/api/channel-status', async (_req, res) => res.json(await transport.getChannelAuthStatuses()));
app.get('/api/emotes/:channel', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(emotes.getEmoteMap(req.params.channel));
});

app.get('/api/chat/:channel', async (req, res) => {
    let channel = req.params.channel;
    if (!channel.startsWith('#')) channel = '#' + channel;

    const buffer = await storage.getChatLog(channel);
    res.json(buffer);
});

app.get('/api/media', async (_req, res) => {
    const media = await storage.getMediaLog();
    res.json(media);
});

app.all('/', (req, res) => {
    if (!transport.auth.isAuthorized()) {
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
                <p>This bot is configured for Twitch account: <strong>@${TWITCH_USERNAME}</strong></p>
                <div class="info-box">
                    💡 <strong>Important:</strong> Make sure you are logged into Twitch as <strong>@${TWITCH_USERNAME}</strong> in this browser (or open this page in an <strong>Incognito / Private window</strong>) before clicking authorize.
                </div>
                <p>Make sure your Twitch application redirect URL is set to:</p>
                <p><code>${getRequestOrigin(req)}/auth/callback</code></p>
                <p style="margin-top: 24px;"><a class="button" href="${authUrl}">Authorize @${TWITCH_USERNAME}</a></p>
            </body>
            </html>
        `);
        return;
    }

    res.render('pages/index', {
        storageConfigured: storage.configured,
        twitchAuthorized: true,
        twitchConnected: transport.connected,
        twitchAuthUrl: '/auth/login'
    });
});

app.get('/gemini/:text', async (req, res) => {
    const text = req.params.text;

    try {
        const answer = await aiEngine.generate(text, {
            harnessInstructions: emotes.getHarnessInstructions()
        });
        res.send(emotes.decorateReply(null, answer, { appendEmote: false }));
    } catch (error) {
        console.error('Error generating response:', error);
        res.status(500).send('An error occurred while generating the response.');
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});

transport.start().then(result => {
    if (result.error) console.error('[Startup] Twitch runtime failed to start:', result.error);
    else if (!result.authorized) console.log('[Startup] No stored Twitch authorization found. Waiting for /auth/login.');
}).catch(error => console.error('[Startup] Twitch bootstrap failed:', error));