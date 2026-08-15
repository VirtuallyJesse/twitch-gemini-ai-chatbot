import express from 'express';
import expressWs from 'express-ws';
import fs from 'fs';
import { job } from './utils/keep_alive.js';
import { AIOperations } from './ai/operations.js';
import { TwitchBot } from './twitch/twitch_bot.js';
import { EmotePool } from './twitch/emote_pool.js';
import MediaProcessor from './media/media_processor.js';
import UrlHandler from './media/url_handler.js';
import ErrorHandler from './utils/error_handler.js';
import SystemInstructionBuilder from './ai/system_instruction_builder.js';
import { getHelixIds } from './twitch/apiClient.js';
import { PollinationsClient } from './media/media_providers.js';
import { Storage } from './utils/storage.js';
import {
    initTokenManager,
    loadTokens,
    exchangeCodeForTokens,
    isAuthorized
} from './twitch/tokenManager.js';

job.start();

const storage = new Storage();
initTokenManager(storage);

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

async function addMediaEntry(entry) {
    await storage.addMediaEntry(entry);
    broadcastWs({ type: 'media', entry });
}

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

function userHasCustomCommandRole(user, requiredRole) {
    if (!requiredRole || requiredRole === 'all') return true;

    const isBroadcaster = user && user.badges && user.badges.broadcaster;
    const isMod = (user && user.mod) || (user && user.badges && user.badges.moderator);

    switch (requiredRole) {
        case 'broadcaster':
            return !!isBroadcaster;
        case 'moderator':
            return !!isBroadcaster || !!isMod;
        default:
            return true;
    }
}

const customCommands = loadCustomCommands();

const emotes = new EmotePool();

async function sendReply(botInstance, channel, text) {
    if (!text) return;
    if (text.length <= maxLength) {
        await botInstance.say(channel, text);
        return;
    }
    const chunks = text.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
    chunks.forEach((chunk, i) => setTimeout(() => botInstance.say(channel, chunk), 1000 * i));
}

const mediaInstructionsTemplate = `ATTENTION: this is NOT a request to generate {media_type} — the {media_type} was already generated by the system.
User: {username}
User's original description: "{description}"
The {media_type} is available at this URL: {media_url}

DO NOT tell the user to use {command}.
You MUST include the exact URL {media_url} verbatim in your response. Do not alter, truncate, or omit it.
Always place the URL with spaces around it if mid-sentence, flowing directly into the punchline's first word without punctuation or backticks touching it.
Speak in first person, as if you're presenting your {media_type} to the user. Keep it shorter than usual (<=30 words), smoothly integrating the URL.
Avoid phrases like "I made this for you", rather focus on the description and subject matter of the {media_type} itself.
Vary your openers — you might hint at the process, drop a reaction, or throw shade before revealing the link.
End with a one-line punchline riffing on one detail from the user's description, ensuring each sign-off feels unique.
Double-check: The URL {media_url} must appear exactly as-is in your response, with no punctuation or backticks touching it.`;

function getMediaInstruction(username, description, mediaUrl, mediaType, command) {
    const sanitizedDescription = (description || '').replace(/https?:\/\/\S+/g, '[original-url]').replace(/\s+/g, ' ').trim();

    return mediaInstructionsTemplate
        .replace(/\{media_type\}/g, mediaType)
        .replace(/\{username\}/g, username)
        .replace(/\{description\}/g, sanitizedDescription)
        .replace(/\{media_url\}/g, mediaUrl)
        .replace(/\{command\}/g, command);
}

let bot = null;
let geminiOps = null;
let botId = null;
let channelIdMap = {};
let twitchRuntimeStarted = false;
let twitchRuntimePromise = null;

try {
    fileContext = fs.readFileSync('./system_instructions.txt', 'utf8');
} catch (error) {
    console.error('Error reading system_instructions.txt:', error);
}

const mediaProcessor = new MediaProcessor();
const urlHandler = new UrlHandler();
const errorHandler = new ErrorHandler();
const systemInstructionBuilder = new SystemInstructionBuilder(urlHandler);
const pollinationsClient = new PollinationsClient();



function getRequestOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function getTwitchRedirectUri(req) {
    return `${getRequestOrigin(req)}/auth/callback`;
}

function buildTwitchAuthUrl(req) {
    if (!process.env.TWITCH_CLIENT_ID) {
        throw new Error('TWITCH_CLIENT_ID is required.');
    }

    const scopes = [
        'chat:read',
        'chat:edit',
        'user:bot',
        'user:read:chat',
        'user:write:chat'
    ];

    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.TWITCH_CLIENT_ID);
    url.searchParams.set('redirect_uri', getTwitchRedirectUri(req));
    url.searchParams.set('scope', scopes.join(' '));
    return url.toString();
}

async function resolveTwitchIds() {
    if (!TWITCH_USERNAME) {
        throw new Error('TWITCH_USERNAME environment variable is required.');
    }

    const allUsernames = [TWITCH_USERNAME, ...channels];
    const uniqueUsernames = [...new Set(allUsernames.map(u => u.replace('#', '').toLowerCase()).filter(Boolean))];

    console.log(`Resolving IDs for ${uniqueUsernames.length} users...`);
    const idMap = await getHelixIds(uniqueUsernames);

    const resolvedBotId = idMap[TWITCH_USERNAME.toLowerCase()];
    if (!resolvedBotId) {
        throw new Error(`Could not resolve ID for bot user: ${TWITCH_USERNAME}`);
    }

    const resolvedChannelIdMap = {};
    for (const channel of channels) {
        const cleanName = channel.replace('#', '').toLowerCase();
        if (idMap[cleanName]) {
            resolvedChannelIdMap[cleanName] = idMap[cleanName];
        } else {
            console.error(`Could not resolve ID for channel: ${channel}`);
        }
    }

    botId = resolvedBotId;
    channelIdMap = resolvedChannelIdMap;
    console.log('Channel ID Map resolved:', Object.keys(channelIdMap).length, 'channels ready.');
}

async function executeMediaPipeline({
    channel,
    user,
    message,
    command,
    service,
    mediaType,
    providerCall
}) {
    if (!bot || !geminiOps) {
        console.error('[Media] Bot runtime is not ready.');
        return;
    }

    const username = (user && (user['display-name'] || user.username || user.name)) || 'someone';
    const prompt = message.slice(command.length).replace(/^,\s*/, '').trim();

    if (!prompt) {
        await bot.say(channel, errorHandler.getMessage('MEDIA_PROMPT_REQUIRED', { username, mediaType }));
        return;
    }

    const currentTime = Date.now();
    const generalElapsed = (currentTime - lastResponseTime) / 1000;
    if (COOLDOWN_DURATION > 0 && generalElapsed < COOLDOWN_DURATION) {
        const remainingTime = (COOLDOWN_DURATION - generalElapsed).toFixed(1);
        await bot.say(channel, errorHandler.getMessage('COOLDOWN_ACTIVE', { remainingTime }));
        return;
    }
    lastResponseTime = currentTime;

    try {
        const result = await providerCall(prompt);

        let finalMediaUrl;

        if (result.buffer) {
            console.log(`Uploading ${service} ${mediaType} to storage (${result.buffer.length} bytes)...`);
            if (mediaType === 'image') {
                finalMediaUrl = await mediaProcessor.uploadImage(result.buffer, result.mimeType || 'image/png');
            } else if (mediaType === 'video') {
                finalMediaUrl = await mediaProcessor.uploadVideo(result.buffer, result.mimeType || 'video/mp4');
            } else {
                finalMediaUrl = await mediaProcessor.uploadAudio(result.buffer, result.mimeType || 'audio/mpeg');
            }
            console.log(`${service} ${mediaType} uploaded: ${finalMediaUrl}`);
        } else {
            await bot.say(channel, errorHandler.getMessage('MEDIA_NO_DATA', { service, mediaType }));
            return;
        }

        await addMediaEntry({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            channel,
            username,
            command,
            prompt,
            mediaUrl: finalMediaUrl,
            mediaType
        });

        const displayType = mediaType === 'tts' ? 'TTS audio' : mediaType;
        const ephemeralContext = getMediaInstruction(username, prompt, finalMediaUrl, displayType, command);

        const userPrompt = `User requested: ${prompt}`;
        const rawResponse = await geminiOps.make_gemini_call(userPrompt, {
            disableMultimedia: true,
            channel,
            ephemeralContext
        });

        let finalResponse = rawResponse || '';

        if (!finalResponse.includes(finalMediaUrl)) {
            finalResponse = finalResponse.trim().length > 0
                ? `${finalResponse.trim()} ${finalMediaUrl}`
                : `${finalMediaUrl}`;
        }

        if (!finalResponse || !finalResponse.trim()) {
            finalResponse = errorHandler.getMessage('MEDIA_FALLBACK_RESPONSE', { mediaType, username, url: finalMediaUrl });
        }

        await sendReply(bot, channel, emotes.decorateReply(channel, finalResponse, { maxLength }));
    } catch (error) {
        console.error(`${service} ${mediaType} generation error:`, error);
        await bot.say(channel, errorHandler.createErrorResponse(error));
    }
}

async function initializeTwitchRuntime() {
    if (!isAuthorized()) {
        console.log('[Twitch] Authorization required. Bot runtime is waiting.');
        return false;
    }

    if (twitchRuntimeStarted) {
        return true;
    }

    if (twitchRuntimePromise) {
        return twitchRuntimePromise;
    }

    twitchRuntimePromise = (async () => {
        await resolveTwitchIds();

        const twitchBot = new TwitchBot(TWITCH_USERNAME, channels, botId, channelIdMap);

        twitchBot.onLogEntry = (channel, entry) => {
            broadcastWs({ type: 'chat', channel, entry });
            storage.addChatMessage(channel, entry).catch(err => {
                console.error('Failed to save chat to storage:', err.message);
            });
        };

        twitchBot.onMessage(async (channel, user, message, self) => {
            if (self || (user && user.username && user.username.toLowerCase() === TWITCH_USERNAME.toLowerCase())) return;

            const username = (user && (user['display-name'] || user.username || user.name)) || '';
            const loginName = (user && user.username) ? user.username.toLowerCase() : '';
            if (ignoredUsernames.includes(loginName)) {
                console.log(`Ignoring message from user: ${username}`);
                return;
            }

            const lower = message.toLowerCase();
            const imageCommand = imageCommandNames.find(cmd => lower.startsWith(cmd));
            const videoCommand = videoCommandNames.find(cmd => lower.startsWith(cmd));
            const ttsCommand = ttsCommandNames.find(cmd => lower.startsWith(cmd));
            const musicCommand = musicCommandNames.find(cmd => lower.startsWith(cmd));
            const command = commandNames.find(cmd => lower.startsWith(cmd));

            // One pass: log text, AI text, web emote metadata, emote-only verdict.
            const { textForAi, textForLogs, emoteIdMap, isEmoteOnly } = emotes.ingestMessage({
                channel, text: message, tags: user, prefix: command || ''
            });

            twitchBot.addMessageToBuffer(channel, username, textForLogs, { twitchEmotesByName: emoteIdMap });

            const messageLower = message.trim().toLowerCase();
            const customCommandKey = [...customCommands.keys()].find(cmd =>
                messageLower === cmd || messageLower.startsWith(cmd + ' ')
            );

            if (customCommandKey) {
                const customCmd = customCommands.get(customCommandKey);
                if (!userHasCustomCommandRole(user, customCmd.role)) {
                    return;
                }
                const now = Date.now();
                const elapsed = (now - lastResponseTime) / 1000;
                if (COOLDOWN_DURATION > 0 && elapsed < COOLDOWN_DURATION) {
                    return;
                }
                lastResponseTime = now;
                await twitchBot.say(channel, customCmd.response);
                return;
            }

            const currentTime = Date.now();
            const elapsedTime = (currentTime - lastResponseTime) / 1000;

            if (musicCommand) {
                await executeMediaPipeline({
                    channel, user, message, command: musicCommand,
                    service: 'pollinations', mediaType: 'music',
                    providerCall: (prompt) => pollinationsClient.generateMusic(prompt)
                });
            } else if (ttsCommand) {
                await executeMediaPipeline({
                    channel, user, message, command: ttsCommand,
                    service: 'pollinations', mediaType: 'tts',
                    providerCall: (prompt) => pollinationsClient.generateAudio(prompt)
                });
            } else if (videoCommand) {
                await executeMediaPipeline({
                    channel, user, message, command: videoCommand,
                    service: 'pollinations', mediaType: 'video',
                    providerCall: (prompt) => pollinationsClient.generateVideo(prompt)
                });
            } else if (imageCommand) {
                await executeMediaPipeline({
                    channel, user, message, command: imageCommand,
                    service: 'pollinations', mediaType: 'image',
                    providerCall: (prompt) => pollinationsClient.generateImage(prompt)
                });
            } else if (command) {
                if (isEmoteOnly) {
                    console.log(`Command ${command} ignored: emote-only message`);
                    return;
                }

                if (COOLDOWN_DURATION > 0) {
                    if (elapsedTime < COOLDOWN_DURATION) {
                        const remainingTime = (COOLDOWN_DURATION - elapsedTime).toFixed(1);
                        await twitchBot.say(channel, errorHandler.getMessage('COOLDOWN_ACTIVE', { remainingTime }));
                        return;
                    }
                    lastResponseTime = currentTime;
                }

                const prompt = `Message from user ${user.username}: ${textForAi}`;
                const rawResponse = await geminiOps.make_gemini_call(prompt, { channel });
                await sendReply(twitchBot, channel, emotes.decorateReply(channel, rawResponse, { maxLength }));
            }
        });

        twitchBot.onConnected((addr, port) => {
            console.log(`* Connected to ${addr}:${port}`);
        });

        twitchBot.onDisconnected(reason => {
            console.log(`Disconnected: ${reason}`);
        });

        bot = twitchBot;
        geminiOps = new AIOperations(
            fileContext,
            GEMINI_API_KEY,
            MODEL_NAME,
            AI_HISTORY_LENGTH,
            ENABLE_SEARCH_GROUNDING,
            YOUTUBE_API_KEY,
            mediaProcessor,
            urlHandler,
            errorHandler,
            systemInstructionBuilder,
            bot
        );

        try {
            await emotes.seed(channels, channelIdMap);
            console.log('Emote initialization completed');
        } catch (error) {
            console.error('Failed to initialize emotes:', error);
        }

        await bot.connect(
            () => {
                console.log('Bot connected!');
            },
            error => {
                console.error('Bot couldn\'t connect!', error);
            }
        );

        twitchRuntimeStarted = true;
        return true;
    })().catch(error => {
        bot = null;
        geminiOps = null;
        twitchRuntimeStarted = false;
        console.error('[Twitch] Runtime initialization failed:', error);
        throw error;
    }).finally(() => {
        twitchRuntimePromise = null;
    });

    return twitchRuntimePromise;
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

        const authUrl = buildTwitchAuthUrl(req);
        res.redirect(authUrl);
    } catch (error) {
        console.error('[Auth] Failed to build Twitch auth URL:', error);
        res.status(500).send('Failed to start Twitch authorization.');
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, error, error_description: errorDescription } = req.query;

    if (error) {
        res.status(400).send(`Twitch authorization failed: ${errorDescription || error}`);
        return;
    }

    if (!code) {
        res.status(400).send('Missing authorization code.');
        return;
    }

    try {
        await exchangeCodeForTokens(String(code), getTwitchRedirectUri(req), TWITCH_USERNAME);
        await initializeTwitchRuntime();

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

app.get('/auth/status', (_req, res) => {
    res.json({
        authorized: isAuthorized(),
        connected: !!bot
    });
});

app.get('/api/channels', (_req, res) => {
    res.json(bot ? bot.channels : channels);
});

app.get('/api/channel-ids', (_req, res) => {
    const out = {};
    for (const ch of channels) {
        const clean = ch.replace('#', '').toLowerCase();
        out[ch] = channelIdMap[clean] || null;
    }
    res.json(out);
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
    if (!isAuthorized()) {
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
        twitchConnected: !!bot,
        twitchAuthUrl: '/auth/login'
    });
});

app.get('/gemini/:text', async (req, res) => {
    if (!geminiOps) {
        res.status(503).send('Bot is not ready yet. Complete Twitch authorization first.');
        return;
    }

    const text = req.params.text;

    try {
        const answer = await geminiOps.make_gemini_call(text);
        res.send(emotes.decorateReply(null, answer, { appendEmote: false }));
    } catch (error) {
        console.error('Error generating response:', error);
        res.status(500).send('An error occurred while generating the response.');
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});

(async () => {
    try {
        const ready = await loadTokens();
        if (ready) {
            await initializeTwitchRuntime();
        } else {
            console.log('[Startup] No stored Twitch authorization found. Waiting for /auth/login.');
        }
    } catch (error) {
        console.error('[Startup] Twitch bootstrap failed:', error);
    }
})();