// src/twitch/helix_actions.js
// Phase 1 Twitch Helix Action Tool Suite: role-gated tools, multi-channel broadcaster tokens,
// single-turn entity resolution, clip dedup, and chatter-safe error envelopes.

const SHOUTOUT_COOLDOWN_MS = 120_000;
const TITLE_MAX = 140;
const TIMEOUT_MAX = 1_209_600;
const DEFAULT_TIMEOUT_SECONDS = 600;

const cleanTarget = (value) =>
    String(value || '').replace(/^@+/, '').replace('#', '').trim().toLowerCase();

const isPrivilegedCaller = (caller) =>
    !!(caller?.isBroadcaster || caller?.isMod);

export const HELIX_TOOL_DECLARATIONS = [
    {
        name: 'set_channel_category',
        streamActionFamily: 'stream_setup',
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
        streamActionFamily: 'stream_setup',
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
        name: 'create_stream_marker',
        description: 'Add a marker to the current live Twitch stream, optionally with a short description supplied by the caller.',
        tokenTier: 'broadcaster',
        streamActionFamily: 'stream_setup',
        requiresLive: true,
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string', maxLength: 140, description: 'Optional marker description based on the caller\'s stated intent' }
            }
        }
    },
    {
        name: 'timeout_user',
        streamActionFamily: 'moderation',
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
        name: 'ban_user',
        description: 'Permanently ban a chatter from Twitch chat.',
        tokenTier: 'moderator',
        streamActionFamily: 'moderation',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'The Twitch username to ban' },
                reason: { type: 'string', maxLength: 500, description: 'Optional reason for the ban' }
            },
            required: ['username']
        }
    },
    {
        name: 'unban_user',
        description: 'Restore Twitch chat access by removing either a ban or an active timeout.',
        tokenTier: 'moderator',
        streamActionFamily: 'moderation',
        parameters: {
            type: 'object',
            properties: { username: { type: 'string', description: 'The Twitch username whose chat access should be restored' } },
            required: ['username']
        }
    },
    {
        name: 'set_emote_only',
        description: 'Turn emote-only Twitch chat mode on or off.',
        tokenTier: 'moderator',
        streamActionFamily: 'chat_access',
        parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }
    },
    {
        name: 'set_subscriber_only',
        description: 'Turn subscriber-only Twitch chat mode on or off.',
        tokenTier: 'moderator',
        streamActionFamily: 'chat_access',
        parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }
    },
    {
        name: 'set_followers_only',
        description: 'Turn followers-only Twitch chat mode on or off, optionally requiring a minimum follow age.',
        tokenTier: 'moderator',
        streamActionFamily: 'chat_access',
        parameters: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                minimum_follow_minutes: { type: 'integer', minimum: 0, maximum: 129600 }
            },
            required: ['enabled']
        }
    },
    {
        name: 'send_chat_announcement',
        streamActionFamily: 'community',
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
        streamActionFamily: 'community',
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
        name: 'start_raid',
        description: 'Start a Twitch raid to another channel.',
        tokenTier: 'moderator',
        streamActionFamily: 'community',
        parameters: {
            type: 'object',
            properties: { target_channel: { type: 'string', description: 'The Twitch username of the channel to raid' } },
            required: ['target_channel']
        }
    },
    {
        name: 'cancel_raid',
        description: 'Cancel this channel\'s pending Twitch raid.',
        tokenTier: 'moderator',
        streamActionFamily: 'community',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'create_poll',
        description: 'Create a Twitch poll.',
        tokenTier: 'broadcaster',
        streamActionFamily: 'polls_predictions',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: 60 },
                choices: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string', maxLength: 25 } },
                duration: { type: 'integer', minimum: 15, maximum: 1800 }
            },
            required: ['title', 'choices']
        }
    },
    {
        name: 'create_prediction',
        description: 'Create a Twitch Channel Points prediction.',
        tokenTier: 'broadcaster',
        streamActionFamily: 'polls_predictions',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: 45 },
                outcomes: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string', maxLength: 25 } },
                duration: { type: 'integer', minimum: 30, maximum: 1800 }
            },
            required: ['title', 'outcomes']
        }
    },
    {
        name: 'resolve_prediction',
        description: 'Resolve the current Twitch prediction using one authoritative outcome title.',
        tokenTier: 'broadcaster',
        streamActionFamily: 'polls_predictions',
        parameters: {
            type: 'object',
            properties: { winning_outcome: { type: 'string', description: 'The winning outcome title' } },
            required: ['winning_outcome']
        }
    },
    {
        name: 'cancel_prediction',
        description: 'Cancel and refund the current unresolved Twitch prediction.',
        tokenTier: 'broadcaster',
        streamActionFamily: 'polls_predictions',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'create_clip',
        streamActionFamily: 'viewer_clips',
        requiresLive: true,
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

function recoverable(state, details = {}) {
    return { success: false, recoverable: true, state, ...details };
}

function failureMessage(err) {
    return String(err?.data?.message || err?.message || '');
}

function mapHelixFailure(err, kind) {
    const status = err?.status;
    const message = failureMessage(err);
    if (err?.name === 'AbortError' || /timed out/i.test(err?.message || '')) {
        return fatal('HELIX_ACTION_TIMEOUT');
    }
    if ((status === 401 || status === 403) && ['category', 'title', 'marker', 'raid', 'poll', 'prediction'].includes(kind)) {
        return fatal('BROADCASTER_AUTH_REQUIRED');
    }
    if ((status === 401 || status === 403) && ['timeout', 'ban', 'unban', 'chat-settings', 'announce', 'shoutout'].includes(kind)) {
        return fatal('BOT_NOT_MODERATOR');
    }
    if (kind === 'poll' && status === 400 && /partner|affiliate|not available|not eligible/i.test(message)) {
        return fatal('POLL_UNAVAILABLE');
    }
    if (kind === 'prediction' && status === 400 && /channel points|partner|affiliate|not available|not eligible/i.test(message)) {
        return fatal('PREDICTION_UNAVAILABLE');
    }
    if (kind === 'poll' && (status === 400 || status === 409) && /active|already|conflict/i.test(message)) {
        return recoverable('poll_already_active', { message: 'A poll is already active.' });
    }
    if (kind === 'prediction' && (status === 400 || status === 409) && /active|already|conflict/i.test(message)) {
        return recoverable('prediction_already_active', { message: 'A prediction is already active.' });
    }
    if (kind === 'raid-cancel' && status === 400 && /no .*raid|not .*raid|pending/i.test(message)) {
        return recoverable('no_pending_raid', { message: 'There is no pending raid to cancel.' });
    }
    if (status === 429 && kind === 'shoutout') {
        return { error: 'Shoutouts are on cooldown right now.' };
    }
    if (status === 429) {
        return fatal('HELIX_ACTION_FAILED');
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

function validateTextList({ title, values, titleMax, min, max, itemMax, kind }) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return recoverable('validation_error', { message: `A ${kind} title is required.` });
    if (cleanTitle.length > titleMax) return recoverable('validation_error', { message: `${kind} title exceeds Twitch's ${titleMax} character limit.` });
    if (!Array.isArray(values) || values.length < min || values.length > max) {
        return recoverable('validation_error', { message: `${kind} requires between ${min} and ${max} choices.` });
    }
    const cleaned = values.map((value) => String(value || '').trim());
    if (cleaned.some((value) => !value)) return recoverable('validation_error', { message: `${kind} choices cannot be empty.` });
    if (cleaned.some((value) => value.length > itemMax)) {
        return recoverable('validation_error', { message: `${kind} choices may contain at most ${itemMax} characters.` });
    }
    return { title: cleanTitle, values: cleaned };
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
    clipTracker = new Map(),
    shoutoutTracker = new Map()
} = {}) {
    if (!transport) throw new Error('createHelixTools requires transport');

    // Mutable runtime knobs so dashboard saves hot-apply without a restart.
    const initialClip = Number(clipCooldownSeconds);
    const knobs = {
        clipCooldownSeconds: Number.isFinite(initialClip) ? Math.max(0, initialClip) : 30
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

    const updateChatMode = async ({ enabled, followerModeDuration }, context, field) => {
        const ctx = resolveContext(context, { requireMod: true });
        if (ctx.error) return ctx;
        if (typeof enabled !== 'boolean') {
            return recoverable('validation_error', { message: 'An explicit enabled state is required.' });
        }
        const settings = { [field]: enabled };
        if (field === 'followerMode' && enabled) settings.followerModeDuration = followerModeDuration ?? 0;
        try {
            await helix.updateChatSettings(ctx.broadcasterId, ctx.botId, settings, { signal: context.signal });
            return { success: true, enabled };
        } catch (err) {
            return mapHelixFailure(err, 'chat-settings');
        }
    };

    const closePrediction = async ({ winningOutcome, cancel = false }, context) => {
        const ctx = resolveContext(context, { requireBroadcaster: true });
        if (ctx.error) return ctx;
        if (!cancel && !String(winningOutcome || '').trim()) {
            return recoverable('validation_error', { message: 'A winning outcome is required.' });
        }
        try {
            const auth = await getBroadcasterAccessToken(context.channel);
            if (auth.fatal) return auth;
            const options = { accessToken: auth.accessToken, channel: context.channel, signal: context.signal };
            const predictions = await helix.getPredictions(ctx.broadcasterId, options);
            const current = predictions.find((prediction) => prediction?.status === 'ACTIVE' || prediction?.status === 'LOCKED');
            if (!current) return recoverable('no_active_prediction', { message: 'There is no active prediction.' });

            if (cancel) {
                await helix.endPrediction(ctx.broadcasterId, { id: current.id, status: 'CANCELED' }, options);
                return { success: true, prediction: current.title, status: 'CANCELED' };
            }

            const normalized = String(winningOutcome).trim().toLowerCase();
            const matches = (current.outcomes || []).filter((outcome) =>
                String(outcome?.title || '').trim().toLowerCase() === normalized
            );
            if (matches.length !== 1) {
                return recoverable('outcome_not_unique', {
                    prediction: current.title,
                    outcomes: (current.outcomes || []).map((outcome) => outcome.title)
                });
            }
            await helix.endPrediction(
                ctx.broadcasterId,
                { id: current.id, status: 'RESOLVED', winningOutcomeId: matches[0].id },
                options
            );
            return { success: true, prediction: current.title, winning_outcome: matches[0].title };
        } catch (err) {
            return mapHelixFailure(err, 'prediction');
        }
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

        async create_stream_marker({ description } = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;
            const markerDescription = description == null ? undefined : String(description).trim();
            if (markerDescription && markerDescription.length > 140) {
                return recoverable('validation_error', { message: "Marker description exceeds Twitch's 140 character limit." });
            }
            try {
                const auth = await getBroadcasterAccessToken(context.channel);
                if (auth.fatal) return auth;
                const marker = await helix.createStreamMarker(
                    ctx.broadcasterId,
                    markerDescription || undefined,
                    { accessToken: auth.accessToken, channel: context.channel, signal: context.signal }
                );
                return { success: true, marker };
            } catch (err) {
                return mapHelixFailure(err, 'marker');
            }
        },

        async timeout_user({ username, duration, reason } = {}, context = {}) {
            const ctx = resolveContext(context, { requireMod: true });
            if (ctx.error) return ctx;

            const login = cleanTarget(username);
            if (!login) return { error: 'A username is required.' };
            const seconds = resolveTimeoutDuration(duration, DEFAULT_TIMEOUT_SECONDS);

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

        async ban_user({ username, reason } = {}, context = {}) {
            const ctx = resolveContext(context, { requireMod: true });
            if (ctx.error) return ctx;
            const login = cleanTarget(username);
            if (!login) return recoverable('validation_error', { message: 'A username is required.' });
            const banReason = reason == null ? undefined : String(reason).trim();
            if (banReason && banReason.length > 500) {
                return recoverable('validation_error', { message: "Ban reason exceeds Twitch's 500 character limit." });
            }
            try {
                const ids = await helix.resolveUserIds([login]);
                const targetUserId = ids[login];
                if (!targetUserId) return recoverable('user_not_found', { username: login });
                await helix.banUser(
                    ctx.broadcasterId,
                    ctx.botId,
                    { targetUserId, ...(banReason ? { reason: banReason } : {}) },
                    { signal: context.signal }
                );
                return { success: true, username: login };
            } catch (err) {
                return mapHelixFailure(err, 'ban');
            }
        },

        async unban_user({ username } = {}, context = {}) {
            const ctx = resolveContext(context, { requireMod: true });
            if (ctx.error) return ctx;
            const login = cleanTarget(username);
            if (!login) return recoverable('validation_error', { message: 'A username is required.' });
            try {
                const ids = await helix.resolveUserIds([login]);
                const targetUserId = ids[login];
                if (!targetUserId) return recoverable('user_not_found', { username: login });
                await helix.unbanUser(ctx.broadcasterId, ctx.botId, targetUserId, { signal: context.signal });
                return { success: true, username: login };
            } catch (err) {
                return mapHelixFailure(err, 'unban');
            }
        },

        async set_emote_only({ enabled } = {}, context = {}) {
            return updateChatMode({ enabled }, context, 'emoteMode');
        },

        async set_subscriber_only({ enabled } = {}, context = {}) {
            return updateChatMode({ enabled }, context, 'subscriberMode');
        },

        async set_followers_only({ enabled, minimum_follow_minutes } = {}, context = {}) {
            if (typeof enabled !== 'boolean') {
                return recoverable('validation_error', { message: 'An explicit enabled state is required.' });
            }
            const minutes = minimum_follow_minutes == null ? 0 : Number(minimum_follow_minutes);
            if (enabled && (!Number.isInteger(minutes) || minutes < 0 || minutes > 129_600)) {
                return recoverable('validation_error', { message: 'Minimum follow age must be between 0 and 129600 minutes.' });
            }
            return updateChatMode(
                { enabled, ...(enabled ? { followerModeDuration: minutes } : {}) },
                context,
                'followerMode'
            );
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

        async start_raid({ target_channel } = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;
            const target = cleanTarget(target_channel);
            if (!target) return recoverable('validation_error', { message: 'A target channel is required.' });
            try {
                const ids = await helix.resolveUserIds([target]);
                const targetId = ids[target];
                if (!targetId) return recoverable('user_not_found', { username: target });
                if (targetId === ctx.broadcasterId) {
                    return recoverable('invalid_target', { message: 'A channel cannot raid itself.' });
                }
                const auth = await getBroadcasterAccessToken(context.channel);
                if (auth.fatal) return auth;
                await helix.startRaid(ctx.broadcasterId, targetId, {
                    accessToken: auth.accessToken,
                    channel: context.channel,
                    signal: context.signal
                });
                return { success: true, target_channel: target };
            } catch (err) {
                return mapHelixFailure(err, 'raid');
            }
        },

        async cancel_raid(_args = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;
            try {
                const auth = await getBroadcasterAccessToken(context.channel);
                if (auth.fatal) return auth;
                await helix.cancelRaid(ctx.broadcasterId, {
                    accessToken: auth.accessToken,
                    channel: context.channel,
                    signal: context.signal
                });
                return { success: true };
            } catch (err) {
                return mapHelixFailure(err, 'raid-cancel');
            }
        },

        async create_poll({ title, choices, duration = 120 } = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;
            const validated = validateTextList({ title, values: choices, titleMax: 60, min: 2, max: 5, itemMax: 25, kind: 'Poll' });
            if (validated.recoverable) return validated;
            const seconds = Number(duration);
            if (!Number.isInteger(seconds) || seconds < 15 || seconds > 1800) {
                return recoverable('validation_error', { message: 'Poll duration must be between 15 and 1800 seconds.' });
            }
            try {
                const auth = await getBroadcasterAccessToken(context.channel);
                if (auth.fatal) return auth;
                const poll = await helix.createPoll(
                    ctx.broadcasterId,
                    { title: validated.title, choices: validated.values, duration: seconds },
                    { accessToken: auth.accessToken, channel: context.channel, signal: context.signal }
                );
                return { success: true, poll };
            } catch (err) {
                return mapHelixFailure(err, 'poll');
            }
        },

        async create_prediction({ title, outcomes, duration = 120 } = {}, context = {}) {
            const ctx = resolveContext(context, { requireBroadcaster: true });
            if (ctx.error) return ctx;
            const validated = validateTextList({ title, values: outcomes, titleMax: 45, min: 2, max: 10, itemMax: 25, kind: 'Prediction' });
            if (validated.recoverable) return validated;
            const seconds = Number(duration);
            if (!Number.isInteger(seconds) || seconds < 30 || seconds > 1800) {
                return recoverable('validation_error', { message: 'Prediction duration must be between 30 and 1800 seconds.' });
            }
            try {
                const auth = await getBroadcasterAccessToken(context.channel);
                if (auth.fatal) return auth;
                const prediction = await helix.createPrediction(
                    ctx.broadcasterId,
                    { title: validated.title, outcomes: validated.values, duration: seconds },
                    { accessToken: auth.accessToken, channel: context.channel, signal: context.signal }
                );
                return { success: true, prediction };
            } catch (err) {
                return mapHelixFailure(err, 'prediction');
            }
        },

        async resolve_prediction({ winning_outcome } = {}, context = {}) {
            return closePrediction({ winningOutcome: winning_outcome }, context);
        },

        async cancel_prediction(_args = {}, context = {}) {
            return closePrediction({ cancel: true }, context);
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

    /** Hot-reloads the clip dedup window from committed Stream Actions settings. */
    function reloadSettings({ clipCooldownSeconds: nextClipCooldown } = {}) {
        if (nextClipCooldown !== undefined && nextClipCooldown !== null) {
            knobs.clipCooldownSeconds = Number(nextClipCooldown) || 0;
        }
    }

    return { tools, clipTracker, shoutoutTracker, reloadSettings };
}

export default createHelixTools;
