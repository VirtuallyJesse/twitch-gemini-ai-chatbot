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
import { Storage } from './utils/storage.js';
import { TwitchTransport } from './twitch/twitch_transport.js';

job.start();

const storage = new Storage();

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
const MODEL_NAME = process.env.MODEL_NAME || 'gemini-2.5-flash';
const IMAGE_COMMAND_NAME = process.env.IMAGE_COMMAND_NAME || '!image';
const VIDEO_COMMAND_NAME = process.env.VIDEO_COMMAND_NAME || '!video';
const TTS_COMMAND_NAME = process.env.TTS_COMMAND_NAME || '!tts';
const MUSIC_COMMAND_NAME = process.env.MUSIC_COMMAND_NAME || '!song';
const TWITCH_USERNAME = process.env.TWITCH_USERNAME || '';
const BOT_COMMAND_NAME = process.env.BOT_COMMAND_NAME || '!gemini';
const JOIN_CHANNELS = process.env.JOIN_CHANNELS || '';
const COOLDOWN_DURATION = process.env.COOLDOWN_DURATION !== undefined ? parseInt(process.env.COOLDOWN_DURATION, 10) : 1;
const ENABLE_SEARCH_GROUNDING = process.env.ENABLE_SEARCH_GROUNDING || 'true';
const IGNORED_USERNAMES = process.env.IGNORED_USERNAMES || '';
const ignoredUsernames = IGNORED_USERNAMES.split(',').map(user => user.trim().toLowerCase()).filter(Boolean);

if (!GEMINI_API_KEY) {
    console.error('No GEMINI_API_KEY found. Please set it as an environment variable.');
}

const commandNames = BOT_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const imageCommandNames = IMAGE_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const videoCommandNames = VIDEO_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const ttsCommandNames = TTS_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const musicCommandNames = MUSIC_COMMAND_NAME.split(',').map(cmd => cmd.trim().toLowerCase());
const channels = JOIN_CHANNELS.split(',').map(channel => channel.trim()).filter(Boolean);
const maxLength = 499;
let fileContext = 'You are a helpful Twitch Chatbot.';
let lastResponseTime = 0;

function checkAndConsumeCooldown() {
    if (COOLDOWN_DURATION <= 0) return { onCooldown: false };
    const now = Date.now();
    const elapsed = (now - lastResponseTime) / 1000;
    if (elapsed < COOLDOWN_DURATION) {
        return { onCooldown: true, remaining: (COOLDOWN_DURATION - elapsed).toFixed(1) };
    }
    lastResponseTime = now;
    return { onCooldown: false };
}

function loadCustomCommands() {
    const commands = new Map();
    try {
        const data = fs.readFileSync('./custom_commands.txt', 'utf8');
        const lines = data.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;
            const left = trimmed.substring(0, eqIndex).trim();
            const response = trimmed.substring(eqIndex + 1).trim();

            let cmd;
            let role;
            const pipeIndex = left.indexOf('|');
            if (pipeIndex !== -1) {
                cmd = left.substring(0, pipeIndex).trim().toLowerCase();
                role = left.substring(pipeIndex + 1).trim().toLowerCase();
            } else {
                cmd = left.toLowerCase();
                role = 'all';
            }

            if (!['broadcaster', 'moderator', 'all'].includes(role)) {
                console.warn(`[Custom Commands] Invalid role "${role}" for command "${cmd}", defaulting to "all"`);
                role = 'all';
            }

            if (cmd && response) {
                commands.set(cmd, { response, role });
            }
        }
        console.log(`[Custom Commands] Loaded ${commands.size} command(s) from custom_commands.txt`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[Custom Commands] No custom_commands.txt found, skipping.');
        } else {
            console.error('[Custom Commands] Error loading custom_commands.txt:', error);
        }
    }
    return commands;
}

function userHasRole({ isBroadcaster, isMod }, requiredRole) {
    if (!requiredRole || requiredRole === 'all') return true;
    if (requiredRole === 'broadcaster') return !!isBroadcaster;
    return !!isBroadcaster || !!isMod; // 'moderator'
}

const customCommands = loadCustomCommands();

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
    enableSearchGrounding: ENABLE_SEARCH_GROUNDING,
    youtubeApiKey: YOUTUBE_API_KEY,
    maxResponseLength: parseInt(process.env.GEMINI_MAX_RESPONSE_LENGTH, 10) || 450,
    errorHandler,
    verbose: process.env.AI_VERBOSE === 'true'
});

const CHAT_CONTEXT_LENGTH = parseInt(process.env.CHAT_CONTEXT_LENGTH, 10) || 10;
const allCommandNames = [
    ...commandNames, ...imageCommandNames, ...videoCommandNames,
    ...ttsCommandNames, ...musicCommandNames
];

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

transport.onMessage(handleChatMessage);

async function handleChatMessage({ channel, username, loginName, tags, text, isMod, isBroadcaster }) {
    const lower = text.toLowerCase();
    const imageCommand = imageCommandNames.find(cmd => lower.startsWith(cmd));
    const videoCommand = videoCommandNames.find(cmd => lower.startsWith(cmd));
    const ttsCommand = ttsCommandNames.find(cmd => lower.startsWith(cmd));
    const musicCommand = musicCommandNames.find(cmd => lower.startsWith(cmd));
    const command = commandNames.find(cmd => lower.startsWith(cmd));

    // One pass: log text, AI text, web emote metadata, emote-only verdict.
    const { textForAi, textForLogs, emoteIdMap, isEmoteOnly } =
        emotes.ingestMessage({ channel, text, tags, prefix: command || '' });

    transport.logMessage(channel, username, textForLogs, { twitchEmotesByName: emoteIdMap });

    // ── custom_commands.txt (unchanged policy; roles read normalized flags) ──
    const messageLower = text.trim().toLowerCase();
    const customCommandKey = [...customCommands.keys()].find(cmd =>
        messageLower === cmd || messageLower.startsWith(cmd + ' ')
    );
    if (customCommandKey) {
        const customCmd = customCommands.get(customCommandKey);
        if (!userHasRole({ isBroadcaster, isMod }, customCmd.role)) return;
        const cooldown = checkAndConsumeCooldown();
        if (cooldown.onCooldown) return;
        await transport.send(channel, customCmd.response);
        return;
    }

    const mediaRequest =
        musicCommand ? { command: musicCommand, mediaType: 'music' } :
        ttsCommand ? { command: ttsCommand, mediaType: 'tts' } :
        videoCommand ? { command: videoCommand, mediaType: 'video' } :
        imageCommand ? { command: imageCommand, mediaType: 'image' } :
        null;

    if (mediaRequest) {
        await dispatchMediaCommand({ channel, user: tags, text, ...mediaRequest });
        return;
    }

    if (command) {
        if (isEmoteOnly) {
            console.log(`Command ${command} ignored: emote-only message`);
            return;
        }
        const cooldown = checkAndConsumeCooldown();
        if (cooldown.onCooldown) {
            await transport.send(channel, errorHandler.getMessage('COOLDOWN_ACTIVE', {
                remainingTime: cooldown.remaining
            }));
            return;
        }

        const prompt = `Message from user ${loginName}: ${textForAi}`;
        const { channelContext, recentLogs } = await transport.getContext(channel, {
            logCount: CHAT_CONTEXT_LENGTH,
            commandPrefixes: allCommandNames
        });
        const rawResponse = await aiEngine.generate(prompt, { channel, channelContext, recentLogs });
        await transport.send(channel, emotes.decorateReply(channel, rawResponse, { maxLength }));
    }
}

async function dispatchMediaCommand({ channel, user, text, command, mediaType }) {
    const prompt = text.slice(command.length).replace(/^,\s*/, '').trim();

    if (prompt) { // empty prompts never consume cooldown (unchanged)
        const cooldown = checkAndConsumeCooldown();
        if (cooldown.onCooldown) {
            await transport.send(channel, errorHandler.getMessage('COOLDOWN_ACTIVE', {
                remainingTime: cooldown.remaining
            }));
            return;
        }
    }

    const result = await mediaPipeline.synthesize({ channel, user, prompt, mediaType, command });
    await transport.send(channel, result.replyText); // send() chunks + paces internally
}

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