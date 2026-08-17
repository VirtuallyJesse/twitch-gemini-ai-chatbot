import express from 'express';
import expressWs from 'express-ws';
import fs from 'fs';
import { job } from './utils/keep_alive.js';
import { AIEngine } from './ai/ai_engine.js';
import { EmotePool } from './twitch/emote_pool.js';
import { MediaUploader } from './media/media_uploader.js';
import { MediaPipeline } from './media/media_pipeline.js';
import ErrorHandler from './utils/error_handler.js';
import { PollinationsClient } from './media/media_providers.js';
import { TavilySearchProvider } from './ai/tavily_search_provider.js';
import { Storage } from './utils/storage.js';
import { TwitchTransport } from './twitch/twitch_transport.js';
import { ChatRouter } from './twitch/chat_router.js';

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

const emotes = new EmotePool();

try {
    fileContext = fs.readFileSync('./system_instructions.txt', 'utf8');
} catch (error) {
    console.error('Error reading system_instructions.txt:', error);
}

const mediaUploader = new MediaUploader();
const errorHandler = new ErrorHandler();
const pollinationsClient = new PollinationsClient();
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
    verbose: process.env.AI_VERBOSE === 'true'
});

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

const mediaPipeline = new MediaPipeline({
    provider: pollinationsClient,
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
        emotes.seed(transport.channels, transport.channelIdMap).then(
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

app.get('/auth/callback', async (req, res) => {
    const { code, error, error_description: errorDescription } = req.query;
    if (error) { res.status(400).send(`Twitch authorization failed: ${errorDescription || error}`); return; }
    if (!code) { res.status(400).send('Missing authorization code.'); return; }
    try {
        await transport.auth.handleCallback(String(code), getTwitchRedirectUri(req));
        res.type('html').send(`
            <!doctype html>
            <html>
            <head>
                <meta charset="utf-8" />
                <title>Twitch Authorized</title>
                <style>
                    body { font-family: sans-serif; max-width: 720px; margin: 60px auto; padding: 0 20px; line-height: 1.5; }
                    a { color: #9147ff; }
                </style>
            </head>
            <body>
                <h1>Twitch authorization complete</h1>
                <p>The bot account is now connected to this app.</p>
                <p><a href="/">Return to the dashboard</a></p>
            </body>
            </html>
        `);
    } catch (authError) {
        console.error('[Auth] Callback failed:', authError);
        res.status(500).send(`Authorization failed: ${authError.message}`);
    }
});

app.get('/auth/status', (_req, res) => res.json(transport.auth.getStatus()));
app.get('/api/channels', (_req, res) => res.json(transport.channels));
app.get('/api/channel-ids', (_req, res) => res.json(transport.channelIds));

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
                    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
                </style>
            </head>
            <body>
                <h1>Twitch authorization required</h1>
                <p>This bot is deployed, but the Twitch bot account has not been connected yet.</p>
                <p>Make sure your Twitch application redirect URL is set to:</p>
                <p><code>${getRequestOrigin(req)}/auth/callback</code></p>
                <p>Then log into the Twitch bot account and authorize this app:</p>
                <p><a class="button" href="${authUrl}">Authorize Twitch Bot Account</a></p>
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
        const answer = await aiEngine.generate(text);
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