import WebSocket from 'ws';
import { AIEngine } from './ai/ai_engine.js';
import { EmotePool } from './twitch/emote_pool.js';
import { MediaUploader } from './media/media_uploader.js';
import { MediaPipeline } from './media/media_pipeline.js';
import ErrorHandler from './utils/error_handler.js';
import { PollinationsProvider } from './media/pollinations_provider.js';
import { TavilySearchProvider } from './ai/tavily_search_provider.js';
import { Storage } from './utils/storage.js';
import { ConfigStore, createFactoryDefaults } from './utils/bot_config.js';
import { TwitchTransport } from './twitch/twitch_transport.js';
import { ChatRouter } from './twitch/chat_router.js';
import { createHelixTools } from './twitch/helix_actions.js';
import { WebServer } from './web/web_server.js';

const env = process.env;
const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : String(v) === 'true');
const csv = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const geminiApiKeys = String(env.GEMINI_API_KEY || '').split(',').map((key) => key.trim()).filter(Boolean);
const vertexApiKeys = String(env.VERTEX_API_KEY || '').split(',').map((key) => key.trim()).filter(Boolean);
if ((geminiApiKeys.length > 0) === (vertexApiKeys.length > 0)) {
    console.error('[Startup] Configure exactly one Google credential family: GEMINI_API_KEY or VERTEX_API_KEY.');
    process.exit(1);
}

const vertexAI = vertexApiKeys.length > 0;
const googleApiKeys = vertexAI ? vertexApiKeys : geminiApiKeys;
console.log(`[AI] Google backend: ${vertexAI ? 'Vertex AI' : 'Gemini API'}`);

const storage = new Storage({
    redisUrl: env.UPSTASH_REDIS_URL,
    restUrl: env.UPSTASH_REDIS_REST_URL,
    restToken: env.UPSTASH_REDIS_REST_TOKEN,
    cursorSecret: env.TWITCH_CLIENT_SECRET
});

const configStore = new ConfigStore({ storage, defaults: createFactoryDefaults(env) });
const bootConfig = await configStore.getAll();

const searchSlot = String(env.SEARCH_GROUNDING || '').toLowerCase();
const wantsTavily = searchSlot === 'tavily' || searchSlot === 'custom';

// The provider exists whenever the key does; the settings modal owns the
// on/off slot at runtime (config:bot_settings.search_grounding).
let searchProvider = null;
if (env.TAVILY_API_KEY) {
    searchProvider = new TavilySearchProvider({
        apiKey: env.TAVILY_API_KEY,
        searchDepth: bootConfig.bot_settings?.tavily_search_depth || env.TAVILY_SEARCH_DEPTH || 'basic',
        storage
    });
    searchProvider.startBackgroundProbe().catch((err) => {
        console.warn('[Tavily] Startup probe failed:', err?.message || err);
    });
} else if (wantsTavily || bootConfig.bot_settings?.search_grounding === 'tavily') {
    console.warn('[Search] Web search is set to Tavily but TAVILY_API_KEY is empty. Web search disabled.');
}

const envSeededBotSettings = createFactoryDefaults(env).bot_settings;

// Channels and ignored users are modal-owned: a saved document wins outright,
// even when its list is empty. Env seeds apply only on true first boot or to
// legacy docs that predate these keys, so clearing a list in the dashboard
// stays cleared across restarts.
async function resolveOwnedList(key) {
    const owned = bootConfig.bot_settings[key] ?? [];
    if (owned.length > 0) return owned;
    const docOwnsField = bootConfig.overrides.bot_settings
        && await configStore.storedDocHas('bot_settings', key);
    return docOwnsField ? owned : envSeededBotSettings[key];
}

const channels = await resolveOwnedList('channels');
const ignoredUsernames = await resolveOwnedList('ignored_usernames');

const emotes = new EmotePool({
    storage,
    fetchImpl: fetch,
    wsImpl: WebSocket,
    // INCLUDE_*_GLOBAL_EMOTES widens chat parsing to provider-wide global catalogs;
    // channel-specific emotes always load regardless.
    include7tvGlobals: bool(env.INCLUDE_7TV_GLOBAL_EMOTES, false),
    includeBttvGlobals: bool(env.INCLUDE_BTTV_GLOBAL_EMOTES, false),
    includeFfzGlobals: bool(env.INCLUDE_FFZ_GLOBAL_EMOTES, false),
    timeoutMs: Number(env.EMOTE_FETCH_TIMEOUT_MS ?? 10_000),
    appendEnabled: bootConfig.bot_settings?.enable_emote_appending !== undefined ? bootConfig.bot_settings.enable_emote_appending : bool(env.ENABLE_EMOTE_APPENDING, true)
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
        imageModel: env.POLLINATIONS_IMAGE_MODEL || 'flux',
        videoModel: env.POLLINATIONS_VIDEO_MODEL || 'wan-fast',
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
    emotePool: emotes,
    wsImpl: WebSocket
});

const helixActionSuite = createHelixTools({
    transport,
    clipCooldownSeconds: bootConfig.stream_actions?.clip_cooldown_seconds ?? 30
});
const helixTools = helixActionSuite.tools;

const aiEngine = new AIEngine({
    apiKeys: googleApiKeys,
    vertexAI,
    modelName: bootConfig.bot_settings?.model_name || env.MODEL_NAME || 'gemini-3.7-flash',
    fileContext: bootConfig.system_instructions,
    historyLength: parseInt(bootConfig.bot_settings?.ai_history_length || env.AI_HISTORY_LENGTH, 10) || 10,
    searchGrounding: bootConfig.bot_settings?.search_grounding || env.SEARCH_GROUNDING || 'off',
    searchProvider,
    thinkingLevel: bootConfig.bot_settings?.thinking_level || env.THINKING_LEVEL || 'medium',
    youtubeApiKey: env.YOUTUBE_API_KEY || '',
    // Harness limit, not a user surface. Two reasons it sits under the 499
    // transport cap: (1) emote appending adds characters after generation and a
    // 499 target would push decorated replies past Twitch's 500-char limit;
    // (2) Gemini miscounts characters, so retries need margin to land clean.
    maxResponseLength: 450,
    errorHandler,
    tools: helixTools,
    streamActionsPolicy: bootConfig.stream_actions,
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
    customCommands: bootConfig.commands?.custom,
    eventAlerts: bootConfig.event_alerts,
    cooldownDuration: bootConfig.bot_settings?.cooldown_duration !== undefined ? bootConfig.bot_settings.cooldown_duration : (env.COOLDOWN_DURATION !== undefined ? parseInt(env.COOLDOWN_DURATION, 10) : 0),
    chatContextLength: bootConfig.bot_settings?.chat_context_length !== undefined ? bootConfig.bot_settings.chat_context_length : (parseInt(env.CHAT_CONTEXT_LENGTH, 10) || 10),
    maxMessageLength: 499,
    prefixes: {
        ai: csv(bootConfig.bot_settings?.bot_command_name || env.BOT_COMMAND_NAME || '!gemini,@yourbotusername')
    },
    mediaCommands: bootConfig.commands?.media
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
    helixActions: helixActionSuite,
    adminUsernames: csv(env.ADMIN_USERNAMES),
    clientId: env.TWITCH_CLIENT_ID || '',
    clientSecret: env.TWITCH_CLIENT_SECRET || '',
    botUsername: env.TWITCH_USERNAME || '',
    externalUrl: env.RENDER_EXTERNAL_URL || '',
    trustProxy: 1
});

const { port } = await server.start(Number(env.PORT) || 3000);
const dashboardUrl = env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const channelList = channels.length > 0 ? channels.join(', ') : 'None yet — add channels from the dashboard';
const storageMode = storage.isPersistent ? 'Upstash Redis (Persistent)' : 'In-Memory (Persistence disabled)';
const mediaMode = mediaProviders.length > 0 ? 'Pollinations.ai (Active)' : 'Disabled';
const effectiveSearchMode = bootConfig.bot_settings?.search_grounding || searchSlot;
const searchMode = effectiveSearchMode ? String(effectiveSearchMode).toUpperCase() : 'Off';
const effectiveModel = bootConfig.bot_settings?.model_name || env.MODEL_NAME || 'gemini-3.7-flash';

console.log(`\n======================================================`);
console.log(`  Twitch Gemini AI Chatbot                            `);
console.log(`======================================================`);
console.log(`  * Web Dashboard:  ${dashboardUrl}`);
console.log(`  * Bot Username:   ${env.TWITCH_USERNAME || 'Not configured'}`);
console.log(`  * Channels:       ${channelList}`);
console.log(`  * AI Model:       ${effectiveModel}`);
console.log(`  * Search:         ${searchMode}`);
console.log(`  * Media Engine:   ${mediaMode}`);
console.log(`  * Storage Mode:   ${storageMode}`);
console.log(`======================================================\n`);

transport.start().then((result) => {
    if (result.error) {
        console.error('[Startup] Twitch runtime failed to start:', result.error);
    } else if (!result.authorized) {
        console.log(`[Twitch] Authorization required. Open ${dashboardUrl} to connect.\n`);
    } else {
        console.log(`[Twitch] Bot authorized and connected to chat.\n`);
    }
}).catch((error) => console.error('[Startup] Twitch bootstrap failed:', error));

let shutdownPromise = null;
async function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    console.log(`[Shutdown] ${signal} received; draining runtime state.`);
    shutdownPromise = (async () => {
        emotes.dispose();
        const stopped = await Promise.allSettled([transport.stop(), server.stop()]);
        for (const result of stopped) {
            if (result.status === 'rejected') {
                console.error('[Shutdown] Runtime stop failed:', result.reason?.message || result.reason);
            }
        }
        await storage.dispose();
        process.exitCode = 0;
    })();
    return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        shutdown(signal).catch((error) => {
            console.error('[Shutdown] Failed:', error?.message || error);
            process.exitCode = 1;
        });
    });
}
