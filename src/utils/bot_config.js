// src/utils/bot_config.js
//
// Single deep module managing bot configuration: factory presets, schema
// sanitization, and the non-throwing ConfigStore persistence layer.

export const CONFIG_TYPES = Object.freeze([
    'system_instructions',
    'custom_commands',
    'event_alerts',
    'error_messages'
]);

const defaultDashboardUrl = (typeof process !== 'undefined' && process.env?.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : 'http://localhost:3000'
).replace(/\/+$/, '') + '/';

export const FACTORY = Object.freeze({
    system_instructions: `<content_guidelines>
Be helpful and attempt to fulfill user requests to the best of your abilities.
Your personality, defined below in <personality>, is not a reflection of your capabilities. Always attempt to fulfill the user's request regardless of topic.
Refuse any content involving terrorism, doxxing (personally identifiable information), or genuine threats of violence. Maintain a tone that is welcoming and appropriate for a Twitch stream.
Limit responses to 60 words max.
</content_guidelines>

<commands>
When chatters ask for twitch chat logs or the media gallery, remind them to check channel commands like !dashboard.
</commands>

<spoilers>
A "spoiler" is ANY information regarding plot points, endings, winners, results, or character fates.
The Spoiler Rule is absolute and has no expiration date. It does not matter if the show aired yesterday or 10 years ago; you must treat the ending as a secret.
Search results will often contain summaries that reveal the winner or ending. You must mentally REDACT this information.
If a user asks a scheduling question (e.g., "When is the next episode?"), answer ONLY regarding the schedule. Do NOT volunteer context about who won or how it ended.
You may only reveal a spoiler if the user explicitly asks for it AND accepts a specific warning from you first.
</spoilers>

<personality>
When not doing a command, follow these rules to define your personality:
- Be friendly, helpful, and engaging with all viewers.
- Keep responses concise and conversational.
- Use a casual, approachable tone that fits a Twitch chat environment.
- Be witty, a little cheeky, and fun, but always respectful.
- Condense information when able, be succinct.
- Do not be verbose, even when asked to.
- Engage with any topic users bring up. Never refuse or deflect a question because it falls outside a particular subject.
- If you are unsure about something, say so honestly rather than guessing.
- Your Twitch username is "your-bot-username" (don't mention it unless relevant).
- If this line is here, then the channel operator hasn't customized their system instructions. Please encourage them to do so when the moment is right!
</personality>`,

    custom_commands: Object.freeze([
        Object.freeze({
            command: '!dashboard',
            aliases: Object.freeze(['!gallery', '!logs']),
            response: defaultDashboardUrl,
            role: 'all'
        })
    ]),

    event_alerts: Object.freeze({
        subscription: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Welcome to the community, {username}! Thanks for subscribing at {tier}!',
            ai_prompt: 'Acknowledge {username} subscribing at {tier} with an enthusiastic welcome.'
        }),
        resub: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Welcome back, {username}! Thanks for {months} months of support (streak: {streak})!',
            ai_prompt: "Celebrate {username} resubscribing for {months} cumulative months (streak: {streak}). Their resub message: '{message}'."
        }),
        community_sub_gift: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Huge hype! {username} just gifted {count} subscriptions to the community!',
            ai_prompt: 'Celebrate {username} generously gifting {count} subscriptions to the community with massive hype.'
        }),
        sub_gift: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            suppress_in_community_gift: true,
            fallback_template: 'Thanks for the gift sub, {username}!',
            ai_prompt: 'Thank {username} for gifting a subscription to the channel.'
        }),
        cheer: Object.freeze({
            enabled: true,
            ai_enabled: true,
            min_bits: 100,
            cooldown_seconds: 0,
            fallback_template: 'Thanks for cheering {bits} bits, {username}!',
            ai_prompt: "Thank {username} for cheering {bits} bits. Their cheer message: '{message}'."
        }),
        channel_points: Object.freeze({
            enabled: false,
            cooldown_seconds: 5,
            rewards: Object.freeze({
                Hydrate: Object.freeze({
                    ai_enabled: true,
                    fallback_template: 'Drink water, streamer! {username} redeemed Hydrate!',
                    ai_prompt: "Remind the streamer to hydrate in your cheeky persona, requested by {username}. Note: '{user_input}'."
                })
            })
        }),
        raid: Object.freeze({
            enabled: true,
            ai_enabled: true,
            min_viewers: 1,
            cooldown_seconds: 10,
            fallback_template: 'Welcome raiders! Thanks {username} for bringing {viewers} viewers over!',
            ai_prompt: 'Welcome {username} and their raid of {viewers} viewers with huge energy.'
        }),
        follow: Object.freeze({
            enabled: false,
            ai_enabled: true,
            cooldown_seconds: 5,
            fallback_template: 'Thanks for following the channel, {username}!',
            ai_prompt: 'Thank {username} for following the channel.'
        })
    }),

    error_messages: Object.freeze({
        RATE_LIMIT_EXHAUSTED: '⏰ All API keys rate limited. Try again tomorrow.',
        GEMINI_EMPTY_RESPONSE: "🔭 Empty Response. Google's servers are having issues. Try again in 30 seconds.",
        POLLINATIONS_NOT_CONFIGURED: '❌ Pollinations API key not configured.',
        POLLINATIONS_AUDIO_EMPTY_INPUT: '⚠️ Text Required. You need to add text for TTS, tags alone are not enough.',
        POLLINATIONS_BAD_PROMPT: '🚫 Content Blocked. That prompt violates the terms of service. Try something else.',
        POLLINATIONS_INSUFFICIENT_BALANCE: '📉 Insufficient Pollen. Pollen refills every hour. Try again later.',
        POLLINATIONS_CONTENT_BLOCKED: '🚫 Content Blocked. The request was deemed inappropriate. Try being more specific or use different words.',
        POLLINATIONS_SERVER_DOWN: '🔧 Server Down. Pollinations servers are offline. Try again later.',
        POLLINATIONS_BAD_GATEWAY: '🔧 Bad Gateway. Pollinations servers are having issues. Try again in 30 seconds.',
        POLLINATIONS_SERVER_ERROR: '🔧 Server Error. Pollinations servers are having issues. Try again in 30 seconds.',
        POLLINATIONS_GATEWAY_TIMEOUT: '⏱️ Gateway Timeout. Pollinations took too long. Try again in 30 seconds.',
        POLLINATIONS_BAD_REQUEST: '❌ Bad Request. Pollinations rejected that prompt. Try different words.',
        POLLINATIONS_RATE_LIMITED: '⏰ Rate Limited. Pollinations is busy. Try again in 30 seconds.',
        POLLINATIONS_GENERIC_ERROR: '🔧 Pollinations {modelType} Error. Something went wrong. Try again in 30 seconds.',
        MEDIA_PROMPT_REQUIRED: '@{username} Please provide a description for the {mediaType}.',
        MEDIA_NO_DATA: '🔧 {service} Error. No {mediaType} data returned. Try again.',
        MEDIA_FALLBACK_RESPONSE: "Here's your {mediaType} {username}: {url}",
        COOLDOWN_ACTIVE: 'Cooldown active. Please wait {remainingTime} seconds before sending another message.',
        VIDEO_UPLOAD_EMPTY: '❌ Video Upload Failed. Host returned empty response. Try again.',
        VIDEO_UPLOAD_TIMEOUT: '⏱️ Video Upload Timeout. Host took too long. Try again.',
        VIDEO_UPLOAD_FAILED: '❌ Video Upload Failed. Could not upload video. Try again in 30 seconds.',
        VIDEO_TOO_LARGE: '🎬 Video Too Large. The generated video was too big. Try a simpler prompt.',
        AUDIO_UPLOAD_EMPTY: '❌ Audio Upload Failed. Host returned empty response. Try again.',
        AUDIO_UPLOAD_BAD_GATEWAY: '🔧 Audio Upload Error. Audio host is having issues. Try again in 30 seconds.',
        AUDIO_UPLOAD_SERVICE_UNAVAILABLE: '🔧 Audio Upload Error. Audio host is overloaded. Try again in 30 seconds.',
        AUDIO_UPLOAD_TIMEOUT: '⏱️ Audio Upload Timeout. Audio host took too long. Try again.',
        AUDIO_UPLOAD_FAILED: '❌ Audio Upload Failed. Could not upload audio. Try again in 30 seconds.',
        FETCH_TIMEOUT: '⏱️ Connection Timeout. The server took too long to respond. Try again.',
        FETCH_REFUSED: '🌐 Connection Refused. Could not reach the server. Try again.',
        FETCH_NOT_FOUND: '🌐 Server Not Found. Could not reach the server. Try again.',
        FETCH_RESET: '🌐 Connection Reset. The server dropped the connection. Try again.',
        FETCH_NETWORK_ERROR: '🌐 Network Error. Connection failed. Try again.',
        REQUEST_TIMEOUT: '⏱️ Timeout Error. The request took too long. Try again.',
        REQUEST_ABORTED: '⏱️ Request Aborted. The request was cancelled. Try again.',
        IMAGE_UPLOAD_EMPTY: '❌ Upload Failed. Image host returned empty response. Try again.',
        IMAGE_UPLOAD_BAD_GATEWAY: '🔧 Upload Error. Image host is having issues. Try again in 30 seconds.',
        IMAGE_UPLOAD_SERVICE_UNAVAILABLE: '🔧 Upload Error. Image host is overloaded. Try again in 30 seconds.',
        IMAGE_UPLOAD_TIMEOUT: '⏱️ Upload Timeout. Image host took too long. Try again.',
        IMAGE_UPLOAD_FAILED: '❌ Upload Failed. Could not upload image. Try again in 30 seconds.',
        IMAGE_TOO_LARGE: '🖼️ Image Too Large. Try a smaller image.',
        IMAGE_LOAD_ERROR: '🖼️ Image Error. Could not load that image. Try a different URL.',
        CONTENT_BLOCKED: '🚫 Content Blocked. The request was deemed inappropriate. Try being more specific or use different words.',
        SAFETY_FILTER: '⚠️ Safety Filter Triggered. Flagged as {categories}. Try rephrasing your message.',
        HTTP_429: '⏰ Quota Exceeded. API rate limit reached. Try again in 30 seconds.',
        HTTP_401: '🔐 Authentication Error. Ask the bot owner to fix this.',
        HTTP_403: '🚫 Access Denied. Ask the bot owner to fix this.',
        YOUTUBE_RESTRICTED: '🚫 Access Denied. The video is likely copyrighted or geo-restricted.',
        BOT_NOT_MODERATOR: 'I need moderator status in this channel to do that! Please /mod the bot in chat.',
        BROADCASTER_AUTH_REQUIRED: 'I need broadcaster authorization to update the stream in this channel.',
        HELIX_ACTION_TIMEOUT: '⏱️ Twitch took too long to respond. Try again in a moment.',
        HELIX_ACTION_FAILED: '🔧 Twitch action failed. Try again in a moment.',
        HTTP_400: '❌ Bad Request. Ask the bot owner to fix this.',
        HTTP_404: '🔍 Not Found. Ask the bot owner to fix this.',
        HTTP_500: "🔧 Server Error. Google's servers are having issues. Try again in 30 seconds.",
        HTTP_521: '🔧 Server Down. Origin server is offline. Try again later.',
        HTTP_504: '⏱️ Gateway Timeout. Server took too long. Try again.',
        HTTP_UNKNOWN: '❌ HTTP Error {statusCode}: {message}.',
        RENDER_NETWORK_ERROR: '🌐 Network Error. Could not reach external services. Try again.',
        JSON_PARSE_ERROR: '📄 Parse Error. Ask the bot owner to fix this.',
        UNKNOWN_ERROR: '❌ Unknown Error. Ask the bot owner to fix this.'
    })
});

const REDIS_KEY = (type) => `config:${type}`;
const ROLES = new Set(['all', 'moderator', 'broadcaster']);
const EVENT_KINDS = Object.keys(FACTORY.event_alerts);

function invalid(message) {
    const err = new Error(message);
    err.code = 'INVALID_CONFIG';
    return err;
}

function sanitizeEventKind(kind, factoryKind, rawKind) {
    if (!rawKind || typeof rawKind !== 'object' || Array.isArray(rawKind)) {
        throw invalid(`event_alerts.${kind} must be an object`);
    }
    const out = { ...factoryKind };

    if ('enabled' in rawKind) out.enabled = Boolean(rawKind.enabled);
    if ('ai_enabled' in rawKind) out.ai_enabled = Boolean(rawKind.ai_enabled);

    if ('cooldown_seconds' in rawKind) {
        const cd = Number(rawKind.cooldown_seconds);
        if (!Number.isFinite(cd) || cd < 0) {
            throw invalid(`event_alerts.${kind}.cooldown_seconds must be a non-negative number`);
        }
        out.cooldown_seconds = cd;
    }

    if ('fallback_template' in rawKind && rawKind.fallback_template != null) {
        const ft = String(rawKind.fallback_template);
        if (ft.length > 499) throw invalid(`event_alerts.${kind}.fallback_template exceeds 499 characters`);
        out.fallback_template = ft;
    }

    if ('ai_prompt' in rawKind && rawKind.ai_prompt != null) {
        const ap = String(rawKind.ai_prompt);
        if (ap.length > 1000) throw invalid(`event_alerts.${kind}.ai_prompt exceeds 1000 characters`);
        out.ai_prompt = ap;
    }

    if ('min_bits' in factoryKind && 'min_bits' in rawKind) {
        const mb = Number(rawKind.min_bits);
        if (!Number.isFinite(mb) || mb < 0) {
            throw invalid(`event_alerts.${kind}.min_bits must be a non-negative number`);
        }
        out.min_bits = mb;
    }

    if ('min_viewers' in factoryKind && 'min_viewers' in rawKind) {
        const mv = Number(rawKind.min_viewers);
        if (!Number.isFinite(mv) || mv < 0) {
            throw invalid(`event_alerts.${kind}.min_viewers must be a non-negative number`);
        }
        out.min_viewers = mv;
    }

    if ('suppress_in_community_gift' in factoryKind && 'suppress_in_community_gift' in rawKind) {
        out.suppress_in_community_gift = Boolean(rawKind.suppress_in_community_gift);
    }

    if (kind === 'channel_points' && 'rewards' in rawKind) {
        if (rawKind.rewards && typeof rawKind.rewards === 'object' && !Array.isArray(rawKind.rewards)) {
            const rewardsOut = {};
            for (const [rewardTitle, rewardCfg] of Object.entries(rawKind.rewards)) {
                if (!rewardCfg || typeof rewardCfg !== 'object') continue;
                const cleanTitle = String(rewardTitle).trim();
                if (!cleanTitle) continue;
                const rOut = {};
                rOut.ai_enabled = rewardCfg.ai_enabled !== undefined ? Boolean(rewardCfg.ai_enabled) : true;
                if (rewardCfg.fallback_template != null) {
                    const rft = String(rewardCfg.fallback_template);
                    if (rft.length > 499) throw invalid(`rewards[${cleanTitle}].fallback_template exceeds 499 characters`);
                    rOut.fallback_template = rft;
                }
                if (rewardCfg.ai_prompt != null) {
                    const rap = String(rewardCfg.ai_prompt);
                    if (rap.length > 1000) throw invalid(`rewards[${cleanTitle}].ai_prompt exceeds 1000 characters`);
                    rOut.ai_prompt = rap;
                }
                rewardsOut[cleanTitle] = rOut;
            }
            out.rewards = rewardsOut;
        }
    }

    return out;
}

export function sanitizeConfig(type, raw) {
    switch (type) {
        case 'system_instructions': {
            if (typeof raw !== 'string') throw invalid('system_instructions must be a string');
            if (raw.length > 16_000) throw invalid('system_instructions exceeds 16000 characters');
            return raw;
        }
        case 'custom_commands': {
            if (!Array.isArray(raw)) throw invalid('custom_commands must be an array');
            const seen = new Set();
            return raw.map((row, i) => {
                let command = String(row?.command || '').trim().toLowerCase();
                if (!command) throw invalid(`custom_commands[${i}].command is required`);
                if (!command.startsWith('!')) command = `!${command}`;
                if (command.length > 32) throw invalid(`custom_commands[${i}].command is too long`);
                if (seen.has(command)) throw invalid(`duplicate command ${command}`);
                seen.add(command);

                const aliases = [];
                const rawAliases = Array.isArray(row?.aliases)
                    ? row.aliases
                    : String(row?.aliases || '').split(',');
                for (const a of rawAliases) {
                    let alias = String(a || '').trim().toLowerCase();
                    if (!alias) continue;
                    if (!alias.startsWith('!')) alias = `!${alias}`;
                    if (alias.length > 32) throw invalid(`custom_commands[${i}].aliases is too long`);
                    if (seen.has(alias)) throw invalid(`duplicate command or alias ${alias}`);
                    seen.add(alias);
                    aliases.push(alias);
                }

                const response = String(row?.response || '').trim();
                if (!response) throw invalid(`custom_commands[${i}].response is required`);
                if (response.length > 499) throw invalid(`custom_commands[${i}].response exceeds 499 characters`);
                const role = ROLES.has(row?.role) ? row.role : 'all';
                return { command, aliases, response, role };
            });
        }
        case 'event_alerts': {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw invalid('event_alerts must be an object');
            }
            const out = structuredClone(FACTORY.event_alerts);
            for (const kind of EVENT_KINDS) {
                if (raw[kind] == null) continue;
                out[kind] = sanitizeEventKind(kind, out[kind], raw[kind]);
            }
            return out;
        }
        case 'error_messages': {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw invalid('error_messages must be an object');
            }
            const out = { ...FACTORY.error_messages };
            for (const key of Object.keys(out)) {
                if (raw[key] == null) continue;
                const text = String(raw[key]);
                if (text.length > 499) throw invalid(`${key} exceeds 499 characters`);
                out[key] = text;
            }
            return out;
        }
        default:
            throw invalid(`unknown type ${type}`);
    }
}

export class ConfigStore {
    constructor({ storage, defaults = FACTORY } = {}) {
        this.storage = storage || null;
        this.defaults = defaults;
    }

    async get(type) {
        const fallback = structuredClone(this.defaults[type]);
        const raw = await this.#read(REDIS_KEY(type));
        if (raw == null || raw === '') return { value: fallback, override: false };
        try {
            const parsed = type === 'system_instructions' ? String(raw) : JSON.parse(raw);
            return { value: sanitizeConfig(type, parsed), override: true };
        } catch {
            return { value: fallback, override: false }; // corrupt override -> factory fallback, never crash boot
        }
    }

    async getAll() {
        const overrides = {};
        const out = {};
        for (const type of CONFIG_TYPES) {
            const { value, override } = await this.get(type);
            out[type] = value;
            overrides[type] = override;
        }
        return { ...out, overrides };
    }

    async set(type, raw) {
        const value = sanitizeConfig(type, raw);
        const stored = type === 'system_instructions' ? value : JSON.stringify(value);
        await this.#write(REDIS_KEY(type), stored);
        return { value, override: true };
    }

    async reset(type) {
        await this.#del(REDIS_KEY(type));
        return { value: structuredClone(this.defaults[type]), override: false };
    }

    async #read(key) {
        try {
            return await this.storage?.getValue?.(key) ?? null;
        } catch {
            return null;
        }
    }

    async #write(key, value) {
        if (!this.storage?.setValue) return;
        await this.storage.setValue(key, value);
    }

    async #del(key) {
        if (!this.storage?.deleteValue) return;
        await this.storage.deleteValue(key);
    }
}

export function commandsToMap(list) {
    const map = new Map();
    for (const row of list || []) {
        if (!row || typeof row !== 'object') continue;
        const spec = { response: row.response, role: row.role };
        if (row.command) {
            const cmd = String(row.command).trim().toLowerCase();
            const normCmd = cmd.startsWith('!') ? cmd : `!${cmd}`;
            map.set(normCmd, spec);
        }
        if (row.aliases) {
            const aliasList = Array.isArray(row.aliases)
                ? row.aliases
                : String(row.aliases).split(',');
            for (const a of aliasList) {
                const clean = String(a || '').trim().toLowerCase();
                if (!clean) continue;
                const normAlias = clean.startsWith('!') ? clean : `!${clean}`;
                map.set(normAlias, spec);
            }
        }
    }
    return map;
}
