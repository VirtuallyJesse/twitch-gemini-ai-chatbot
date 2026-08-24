// src/twitch/helix_actions.js
// Phase 1 Twitch Helix Action Tool Suite: role-gated tools, multi-channel broadcaster tokens,
// single-turn entity resolution, clip dedup, and chatter-safe error envelopes.

const SHOUTOUT_COOLDOWN_MS = 120_000;
const TITLE_MAX = 140;
const TIMEOUT_MAX = 1_209_600;

const cleanTarget = (value) =>
    String(value || '').replace(/^@+/, '').replace('#', '').trim().toLowerCase();

const isPrivilegedCaller = (caller) =>
    !!(caller?.isBroadcaster || caller?.isMod);

export const HELIX_TOOL_DECLARATIONS = [
    {
        name: 'set_channel_category',
        description: 'Update the stream game or category on Twitch. Call this when the broadcaster or moderator wants to change what game is being played.',
        tokenTier: 'broadcaster',
        parameters: {
            type: 'object',
            properties: {
                category: { type: 'string', description: 'The name of the game or category (e.g. "VALORANT", "Just Chatting", "Elden Ring")' }
            },
            required: ['category']
        }
    },
    {
        name: 'set_channel_title',
        description: 'Update the stream title on Twitch. Call this when the broadcaster or moderator wants to set a new stream title.',
        tokenTier: 'broadcaster',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'The new title for the stream' }
            },
            required: ['title']
        }
    },
    {
        name: 'timeout_user',
        description: 'Temporarily timeout a disruptive chatter from Twitch chat. Requires moderator permission.',
        tokenTier: 'moderator',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'The Twitch username of the chatter to timeout' },
                duration: { type: 'integer', description: 'Duration of the timeout in seconds (default: 600)' },
                reason: { type: 'string', description: 'Reason for the timeout' }
            },
            required: ['username']
        }
    },
    {
        name: 'send_chat_announcement',
        description: 'Send a highlighted colored announcement banner to the Twitch chat room.',
        tokenTier: 'moderator',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The announcement message text' },
                color: { type: 'string', enum: ['primary', 'blue', 'green', 'orange', 'purple'], description: 'Highlight banner color' }
            },
            required: ['message']
        }
    },
    {
        name: 'send_shoutout',
        description: 'Send an official Twitch shoutout to another streamer channel.',
        tokenTier: 'moderator',
        parameters: {
            type: 'object',
            properties: {
                target_channel: { type: 'string', description: 'The username of the channel to shout out' }
            },
            required: ['target_channel']
        }
    },
    {
        name: 'create_clip',
        description: 'Capture a video clip of the current live stream on Twitch.',
        tokenTier: 'user',
        parameters: {
            type: 'object',
            properties: {}
        }
    }
];

function fatal(errorKey) {
    return { error: errorKey, errorKey, fatal: true };
}

function mapHelixFailure(err, kind) {
    const status = err?.status;
    if (err?.name === 'AbortError' || /timed out/i.test(err?.message || '')) {
        return fatal('HELIX_ACTION_TIMEOUT');
    }
    if ((status === 401 || status === 403) && (kind === 'category' || kind === 'title')) {
        return fatal('BROADCASTER_AUTH_REQUIRED');
    }
    if (status === 403 && (kind === 'timeout' || kind === 'announce' || kind === 'shoutout')) {
        return fatal('BOT_NOT_MODERATOR');
    }
    if (status === 429 && kind === 'shoutout') {
        return { error: 'Shoutouts are on cooldown right now.' };
    }
    if (status === 429) {
        return { error: 'Twitch is rate-limiting that action. Try again shortly.' };
    }
    if (status === 400 && kind === 'timeout') {
        return { error: 'Cannot timeout that user. They may be a moderator, the broadcaster, or an invalid target.' };
    }
    if (status === 400 && kind === 'shoutout') {
        return { error: 'Cannot send that shoutout. The stream may be offline, or the target is invalid.' };
    }
    if (status === 400 && kind === 'clip') {
        return { error: 'Cannot create a clip. The stream may be offline.' };
    }
    if (status === 400) {
        return { error: 'Twitch rejected that channel update.' };
    }
    if (status === 403 && kind === 'clip') {
        return { error: 'Clip creation is not authorized for this bot.' };
    }
    return fatal('HELIX_ACTION_FAILED');
}

function resolveTimeoutDuration(duration, fallback) {
    const n = Number(duration);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.floor(n), 1), TIMEOUT_MAX);
}

function pickCategory(results, query) {
    const q = String(query || '').trim().toLowerCase();
    return results.find((r) => r.name.toLowerCase() === q) || results[0];
}

/**
 * @returns {{ tools: object[], clipTracker: Map, shoutoutTracker: Map }}
 */
export function createHelixTools({
    transport,
    clock = Date.now,
    clipCooldownSeconds = 30,
    defaultTimeoutSeconds = 600,
    clipTracker = new Map(),
    shoutoutTracker = new Map()
} = {}) {
    if (!transport) throw new Error('createHelixTools requires transport');

    // Mutable runtime knobs so dashboard saves hot-apply without a restart.
    const initialClip = Number(clipCooldownSeconds);
    const initialTimeout = Number(defaultTimeoutSeconds);
    const knobs = {
        clipCooldownSeconds: Number.isFinite(initialClip) ? Math.max(0, initialClip) : 30,
        defaultTimeoutSeconds: Number.isFinite(initialTimeout) ? Math.max(0, initialTimeout) : 600
    };

    const helix = transport.helix;
    const resolveContext = (context, { requireMod = false, requireBroadcaster = false } = {}) => {
        if ((requireMod || requireBroadcaster) && context?.caller && !isPrivilegedCaller(context.caller)) {
            return { error: 'Permission denied. Broadcaster or moderator status is required.' };
        }
        const channel = cleanTarget(context?.channel);
        const broadcasterId = transport.channelIdMap[channel];
        if (!broadcasterId) {
            return { error: 'Channel ID is not resolved for this channel.' };
        }
        if (requireMod && !transport.botId) {
            return { error: 'Bot user ID is not resolved.' };
        }
        return { channel, broadcasterId, botId: transport.botId };
    };

    const getBroadcasterAccessToken = async (channel) => {
        const token = await transport.getBroadcasterToken(channel);
        if (!token) return fatal('BROADCASTER_AUTH_REQUIRED');
        return { accessToken: token };
    };

    const handlers = {
        async set_channel_category({ category } = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;

            const query = String(category || '').trim();
            if (!query) return { error: 'A category name is required.' };

            try {
                const results = await helix.searchCategories(query, { signal: context.signal });
                if (!results.length) {
                    return { error: `No Twitch category matching "${query}" was found.` };
                }
                const match = pickCategory(results, query);
                const auth = await getBroadcasterAccessToken(context?.channel);
                if (auth.fatal) return auth;

                await helix.updateChannelInfo(
                    ctx.broadcasterId,
                    { gameId: match.id },
                    { accessToken: auth.accessToken, signal: context.signal, channel: context.channel }
                );
                return { success: true, category: match.name, gameId: match.id };
            } catch (err) {
                return mapHelixFailure(err, 'category');
            }
        },

        async set_channel_title({ title } = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;

            const next = String(title || '').trim();
            if (!next) return { error: 'A stream title is required.' };
            if (next.length > TITLE_MAX) {
                return { error: `Title exceeds Twitch's ${TITLE_MAX} character limit.` };
            }

            try {
                const auth = await getBroadcasterAccessToken(context?.channel);
                if (auth.fatal) return auth;

                await helix.updateChannelInfo(
                    ctx.broadcasterId,
                    { title: next },
                    { accessToken: auth.accessToken, signal: context.signal, channel: context.channel }
                );
                return { success: true, title: next };
            } catch (err) {
                return mapHelixFailure(err, 'title');
            }
        },

        async timeout_user({ username, duration, reason } = {}, context = {}) {
            const ctx = resolveContext(context, { requireMod: true });
            if (ctx.error) return ctx;

            const login = cleanTarget(username);
            if (!login) return { error: 'A username is required.' };
            const seconds = resolveTimeoutDuration(duration, knobs.defaultTimeoutSeconds);

            try {
                const ids = await helix.resolveUserIds([login]);
                const targetUserId = ids[login];
                if (!targetUserId) return { error: `Twitch user '@${login}' was not found` };
                await helix.timeoutUser(
                    ctx.broadcasterId,
                    ctx.botId,
                    { targetUserId, duration: seconds, reason },
                    { signal: context.signal }
                );
                return { success: true, username: login, duration: seconds };
            } catch (err) {
                return mapHelixFailure(err, 'timeout');
            }
        },

        async send_chat_announcement({ message, color } = {}, context = {}) {
            const ctx = resolveContext(context, { requireMod: true });
            if (ctx.error) return ctx;

            const text = String(message || '').trim();
            if (!text) return { error: 'An announcement message is required.' };

            try {
                await helix.sendAnnouncement(
                    ctx.broadcasterId,
                    ctx.botId,
                    { message: text, color },
                    { signal: context.signal }
                );
                return { success: true };
            } catch (err) {
                return mapHelixFailure(err, 'announce');
            }
        },

        async send_shoutout({ target_channel } = {}, context = {}) {
            const ctx = resolveContext(context, { requireMod: true });
            if (ctx.error) return ctx;

            const target = cleanTarget(target_channel);
            if (!target) return { error: 'A target channel is required.' };

            const key = cleanTarget(context.channel);
            const now = clock();
            const last = shoutoutTracker.get(key) || 0;
            if (now - last < SHOUTOUT_COOLDOWN_MS) {
                return { error: 'Shoutouts are on cooldown right now.' };
            }

            try {
                const ids = await helix.resolveUserIds([target]);
                const targetId = ids[target];
                if (!targetId) return { error: `Twitch user '@${target}' was not found` };
                if (targetId === ctx.broadcasterId) {
                    return { error: 'Cannot shout out this channel.' };
                }
                await helix.sendShoutout(
                    ctx.broadcasterId,
                    ctx.botId,
                    targetId,
                    { signal: context.signal }
                );
                shoutoutTracker.set(key, now);
                return { success: true, target_channel: target };
            } catch (err) {
                return mapHelixFailure(err, 'shoutout');
            }
        },

        async create_clip(_args = {}, context = {}) {
            const ctx = resolveContext(context);
            if (ctx.error) return ctx;

            const key = cleanTarget(context.channel);
            const now = clock();
            const cached = clipTracker.get(key);
            if (cached && (now - cached.timestamp) / 1000 < knobs.clipCooldownSeconds) {
                return { success: true, url: cached.url, cached: true };
            }

            try {
                const clip = await helix.createClip(ctx.broadcasterId, { signal: context.signal });
                const url = clip.url || `https://clips.twitch.tv/${clip.id}`;
                clipTracker.set(key, { timestamp: now, url });
                return { success: true, url, cached: false };
            } catch (err) {
                return mapHelixFailure(err, 'clip');
            }
        }
    };

    const tools = HELIX_TOOL_DECLARATIONS.map((decl) => ({
        ...decl,
        timeoutMs: 3500,
        execute: (args, context) => handlers[decl.name](args, context)
    }));

    /**
     * Hot-reloads runtime knobs (clip dedup window, default timeout duration)
     * from config:bot_settings saves.
     * @param {{ clipCooldownSeconds?: number, defaultTimeoutSeconds?: number }} [settings]
     */
    function reloadSettings({ clipCooldownSeconds: nextClipCooldown, defaultTimeoutSeconds: nextTimeout } = {}) {
        if (nextClipCooldown !== undefined && nextClipCooldown !== null) {
            knobs.clipCooldownSeconds = Number(nextClipCooldown) || 0;
        }
        if (nextTimeout !== undefined && nextTimeout !== null) {
            knobs.defaultTimeoutSeconds = Number(nextTimeout) || 0;
        }
    }

    return { tools, clipTracker, shoutoutTracker, reloadSettings };
}

export default createHelixTools;
