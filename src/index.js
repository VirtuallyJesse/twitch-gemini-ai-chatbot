import WebSocket from 'ws';
import { AIEngine } from './ai/ai_engine.js';
import { EmotePool } from './twitch/emote_pool.js';
import { MediaUploader } from './media/media_uploader.js';
import { MediaPipeline } from './media/media_pipeline.js';
import ErrorHandler from './utils/error_handler.js';
import { PollinationsProvider } from './media/pollinations_provider.js';
import { TavilySearchProvider } from './ai/tavily_search_provider.js';
import { Storage } from './utils/storage.js';
import { ConfigStore } from './utils/bot_config.js';
import { TwitchTransport } from './twitch/twitch_transport.js';
import { ChatRouter } from './twitch/chat_router.js';
import { createHelixTools } from './twitch/helix_actions.js';
import { WebServer } from './web/web_server.js';

const env = process.env;
const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : String(v) === 'true');
const csv = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const storage = new Storage({
    redisUrl: env.UPSTASH_REDIS_URL,
    restUrl: env.UPSTASH_REDIS_REST_URL,
    restToken: env.UPSTASH_REDIS_REST_TOKEN
});

const configStore = new ConfigStore({ storage });
const bootConfig = await configStore.getAll();

if (!env.GEMINI_API_KEY) {
    console.error('No GEMINI_API_KEY found. Please set it as an environment variable.');
}

const searchSlot = String(env.SEARCH_GROUNDING || '').toLowerCase();
const wantsTavily = searchSlot === 'tavily' || searchSlot === 'custom';

let searchProvider = null;
if (wantsTavily && env.TAVILY_API_KEY) {
    searchProvider = new TavilySearchProvider({
        apiKey: env.TAVILY_API_KEY,
        searchDepth: env.TAVILY_SEARCH_DEPTH || 'basic',
        storage
    });
    searchProvider.startBackgroundProbe().catch((err) => {
        console.warn('[Tavily] Startup probe failed:', err?.message || err);
    });
} else if (wantsTavily) {
    console.warn('[Search] SEARCH_GROUNDING is tavily/custom but TAVILY_API_KEY is empty. Web search disabled.');
}

const channels = String(env.JOIN_CHANNELS || '').split(',').map((c) => c.trim()).filter(Boolean);
const ignoredUsernames = csv(env.IGNORED_USERNAMES);

const emotes = new EmotePool({
    storage,
    fetchImpl: fetch,
    wsImpl: WebSocket,
    enable7tv: bool(env.ENABLE_7TV_EMOTES, true),
    enableBttv: bool(env.ENABLE_BTTV_EMOTES, true),
    enableFfz: bool(env.ENABLE_FFZ_EMOTES, false),
    include7tvGlobals: bool(env.INCLUDE_7TV_GLOBAL_EMOTES, false),
    includeBttvGlobals: bool(env.INCLUDE_BTTV_GLOBAL_EMOTES, false),
    includeFfzGlobals: bool(env.INCLUDE_FFZ_GLOBAL_EMOTES, false),
    timeoutMs: Number(env.EMOTE_FETCH_TIMEOUT_MS ?? 10_000),
    appendEnabled: bool(env.ENABLE_EMOTE_APPENDING, true),
    excludePrefixes: csv(env.EMOTE_APPEND_EXCLUDE_PREFIXES)
});

const mediaUploader = new MediaUploader();
const errorHandler = new ErrorHandler({ messages: bootConfig.error_messages });

function isUsableSecret(value) {
    const key = String(value || '').trim();
    return key.length > 0 && key !== 'your-pollinations-api-key';
}

const mediaProviders = [];
if (isUsableSecret(env.POLLINATIONS_API_KEY)) {
    mediaProviders.push(new PollinationsProvider({
        apiKey: env.POLLINATIONS_API_KEY,
        imageModel: env.POLLINATIONS_IMAGE_MODEL || 'gptimage',
        videoModel: env.POLLINATIONS_VIDEO_MODEL || 'seedance',
        ttsModel: env.POLLINATIONS_TTS_MODEL || 'elevenlabs',
        ttsVoice: env.POLLINATIONS_TTS_VOICE || 'charlotte',
        musicModel: env.POLLINATIONS_MUSIC_MODEL || 'elevenmusic'
    }));
} else {
    console.log('[Media] Pollinations disabled (missing or placeholder API key).');
}

const transport = new TwitchTransport({
    clientId: env.TWITCH_CLIENT_ID || '',
    clientSecret: env.TWITCH_CLIENT_SECRET || '',
    botUsername: env.TWITCH_USERNAME || '',
    channels,
    initialRefreshToken: env.TWITCH_REFRESH_TOKEN || '',
    storage,
    ignoredUsernames,
    wsImpl: WebSocket
});

let helixTools = [];
if (env.ENABLE_HELIX_ACTIONS !== 'false') {
    const helixActionSuite = createHelixTools({
        transport,
        clipCooldownSeconds: Number(env.HELIX_CLIP_COOLDOWN_SECONDS) || 30,
        defaultTimeoutSeconds: Number(env.HELIX_DEFAULT_TIMEOUT_SECONDS) || 600
    });
    helixTools = helixActionSuite.tools;
}

const aiEngine = new AIEngine({
    apiKeys: env.GEMINI_API_KEY || '',
    modelName: env.MODEL_NAME || 'gemini-3.7-flash',
    fileContext: bootConfig.system_instructions,
    historyLength: parseInt(env.AI_HISTORY_LENGTH, 10) || 5,
    searchGrounding: env.SEARCH_GROUNDING || '',
    searchProvider,
    thinkingLevel: env.THINKING_LEVEL || 'medium',
    youtubeApiKey: env.YOUTUBE_API_KEY || '',
    maxResponseLength: parseInt(env.GEMINI_MAX_RESPONSE_LENGTH, 10) || 450,
    errorHandler,
    tools: helixTools,
    verbose: env.AI_VERBOSE === 'true'
});

const mediaPipeline = new MediaPipeline({
    providers: mediaProviders,
    uploader: mediaUploader,
    storage,
    aiEngine,
    errorHandler,
    emotes
});

const chatRouter = new ChatRouter({
    aiEngine,
    mediaPipeline,
    emotePool: emotes,
    errorHandler,
    systemInstructions: bootConfig.system_instructions,
    customCommands: bootConfig.custom_commands,
    eventAlerts: bootConfig.event_alerts,
    cooldownDuration: env.COOLDOWN_DURATION !== undefined ? parseInt(env.COOLDOWN_DURATION, 10) : 1,
    chatContextLength: parseInt(env.CHAT_CONTEXT_LENGTH, 10) || 10,
    maxMessageLength: 499,
    prefixes: {
        ai: csv(env.BOT_COMMAND_NAME || '!gemini'),
        image: csv(env.IMAGE_COMMAND_NAME || '!image'),
        video: csv(env.VIDEO_COMMAND_NAME || '!video'),
        tts: csv(env.TTS_COMMAND_NAME || '!tts'),
        music: csv(env.MUSIC_COMMAND_NAME || '!song')
    }
});

chatRouter.attach(transport);

const server = new WebServer({
    transport,
    storage,
    aiEngine,
    emotePool: emotes,
    mediaPipeline,
    errorHandler,
    configStore,
    chatRouter,
    adminUsernames: csv(env.ADMIN_USERNAMES),
    clientId: env.TWITCH_CLIENT_ID || '',
    clientSecret: env.TWITCH_CLIENT_SECRET || '',
    botUsername: env.TWITCH_USERNAME || '',
    externalUrl: env.RENDER_EXTERNAL_URL || '',
    trustProxy: 1
});

const { port } = await server.start(Number(env.PORT) || 3000);
console.log(`Server running on port ${port}`);

transport.start().then((result) => {
    if (result.error) console.error('[Startup] Twitch runtime failed to start:', result.error);
    else if (!result.authorized) console.log('[Startup] No stored Twitch authorization found. Waiting for /auth/login.');
}).catch((error) => console.error('[Startup] Twitch bootstrap failed:', error));