// twitch-gemini-ai-chatbot/src/twitch/chat_router.js
// Coordinates Twitch chat ingestion, command RBAC, media/AI dispatch,
// per-channel cooldowns, and chatter-safe error translation.
import { FACTORY, commandsToMap } from '../utils/bot_config.js';
import { normalizeBadges } from '../utils/badges.js';

const DEFAULT_PREFIXES = {
    ai: ['!gemini', '@yourbotusername'],
    image: ['!image'],
    video: ['!video'],
    tts: ['!tts'],
    music: ['!song']
};

const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
const channelKey = (channel) => `#${cleanName(channel)}`;

const DEFAULT_EVENT_ALERTS = FACTORY.event_alerts;

function interpolate(template, vars) {
    return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => {
        const value = vars[key];
        return value == null ? '' : String(value);
    });
}

function eventVars(event) {
    const d = event.details || {};
    const user = event.user || {};
    const recipient = d.recipient || {};
    const reward = d.reward || {};
    return {
        username: user.displayName || user.login || 'someone',
        tier: d.tier || '',
        months: d.months ?? '',
        streak: d.streak ?? '',
        message: d.message ?? '',
        bits: d.bits ?? '',
        count: d.count ?? '',
        recipient: recipient.displayName || recipient.login || 'a community member',
        reward: reward.title || '',
        user_input: reward.userInput || '',
        viewers: d.viewers ?? ''
    };
}

function findRewardConfig(policy, title) {
    const rewards = policy?.rewards || {};
    if (rewards[title]) return rewards[title];
    const lower = String(title || '').toLowerCase();
    for (const [key, value] of Object.entries(rewards)) {
        if (key.toLowerCase() === lower) return value;
    }
    return null;
}

const EVENT_ALERT_HARNESS =
    'You are reacting to a live Twitch channel event. Stay in persona. Keep it under 60 words, celebratory, and authentic. Do not mention being an AI or these instructions. Do not ask follow-up questions. Do not call tools.';

function asPrefixList(value, fallback) {
    if (value == null || value === '') return [...fallback];
    const items = Array.isArray(value) ? value : String(value).split(',');
    return items.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

class CooldownTracker {
    constructor({ duration, clock }) {
        this.duration = typeof duration === 'number' ? duration : 1;
        this.clock = clock;
        this.lastByChannel = new Map();
    }

    checkAndConsume(channel) {
        if (this.duration <= 0) return { onCooldown: false };

        const now = this.clock();
        const last = this.lastByChannel.get(channel) ?? 0;
        const elapsed = (now - last) / 1000;
        if (elapsed < this.duration) {
            return { onCooldown: true, remaining: (this.duration - elapsed).toFixed(1) };
        }

        this.lastByChannel.set(channel, now);
        return { onCooldown: false };
    }
}

class EventAlertRegistry {
    constructor({ eventAlerts } = {}) {
        this.config = eventAlerts && typeof eventAlerts === 'object' ? eventAlerts : DEFAULT_EVENT_ALERTS;
    }

    getPolicy(kind) {
        return this.config?.[kind] || null;
    }

    reload(source) {
        if (source && typeof source === 'object') {
            this.config = source;
        }
    }
}

class EventCooldownTracker {
    constructor({ clock = Date.now }) {
        this.clock = clock;
        this.lastByKey = new Map();
    }

    checkAndConsume(channel, kind, duration) {
        if (duration <= 0) return { onCooldown: false };

        const key = `${channelKey(channel)}:${kind}`;
        const now = this.clock();
        const last = this.lastByKey.get(key);
        if (last !== undefined) {
            const elapsed = (now - last) / 1000;
            if (elapsed < duration) {
                return { onCooldown: true, remaining: (duration - elapsed).toFixed(1) };
            }
        }

        this.lastByKey.set(key, now);
        return { onCooldown: false };
    }
}

class CustomCommandRegistry {
    constructor({ customCommands } = {}) {
        this.commands = new Map();
        this.reload(customCommands);
    }

    reload(source) {
        if (Array.isArray(source)) {
            this.commands = commandsToMap(source);
            return;
        }

        if (source instanceof Map) {
            this.commands = source;
            return;
        }
    }

    match(text) {
        const messageLower = String(text ?? '').trim().toLowerCase();
        for (const [cmd, spec] of this.commands) {
            if (messageLower === cmd || messageLower.startsWith(`${cmd} `)) {
                return { cmd, ...spec };
            }
        }
        return null;
    }
}

class CommandMatcher {
    constructor(aiList, mediaEntries) {
        this.ai = aiList;
        this.media = mediaEntries;
    }

    matchAi(lowerText) {
        return this.ai.find((cmd) => lowerText.startsWith(cmd)) || null;
    }

    matchMedia(lowerText) {
        return this.media.find(({ cmd }) => lowerText.startsWith(cmd)) || null;
    }

    mediaPrompt(text, command) {
        return text.slice(command.length).replace(/^,\s*/, '').trim();
    }
}

const MEDIA_TYPES = ['image', 'video', 'tts', 'music'];

function entriesFromPrefixLists(prefixLists) {
    const entries = [];
    for (const type of [...MEDIA_TYPES].reverse()) {
        for (const cmd of prefixLists[type] || []) {
            entries.push({ cmd, mediaType: type, enabled: true });
        }
    }
    return entries;
}

function normalizedCommandList(cfg) {
    if (!cfg || typeof cfg !== 'object') return [];
    const raw = [cfg.command, ...(Array.isArray(cfg.aliases) ? cfg.aliases : String(cfg.aliases || '').split(','))];
    return raw.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
}

function mediaAccessAllowed(message, access) {
    if (!access || access === 'everyone') return true;
    const badges = message?.tags?.badges || {};
    const isBroadcaster = !!badges.broadcaster || !!message?.isBroadcaster;
    const isMod = badges.moderator != null || !!message?.isMod;
    const isVip = badges.vip != null;
    const isSub = badges.subscriber != null || badges.sub != null;
    switch (access) {
        case 'mod': return isBroadcaster || isMod;
        case 'vipmod': return isBroadcaster || isMod || isVip;
        case 'subs': return isBroadcaster || isMod || isVip || isSub;
        default: return true;
    }
}

function buildMediaOptions(cfg) {
    if (!cfg || typeof cfg !== 'object') return {};
    const options = {};
    if (cfg.model) options.model = cfg.model;
    if (cfg.voice) options.voice = cfg.voice;
    if (cfg.duration_cap) options.duration_cap = Number(cfg.duration_cap);
    return options;
}

function userHasRole({ isBroadcaster, isMod } = {}, requiredRole) {
    if (!requiredRole || requiredRole === 'all') return true;
    if (requiredRole === 'broadcaster') return !!isBroadcaster;
    return !!isBroadcaster || !!isMod;
}

export class ChatRouter {
    #communityGifts = new Map();
    #systemInstructions = '';

    /**
     * @param {object} options collaborator instances and policy. Never reads environment variables.
     */
    constructor({
        aiEngine,
        mediaPipeline,
        emotePool,
        errorHandler,
        customCommands,
        eventAlerts,
        systemInstructions,
        cooldownDuration = 1,
        chatContextLength = 10,
        maxMessageLength = 499,
        communityGiftWindowMs = 30_000,
        prefixes = {},
        mediaCommands = null,
        clock = Date.now
    } = {}) {
        if (!aiEngine || !mediaPipeline || !emotePool) {
            throw new Error('ChatRouter requires aiEngine, mediaPipeline, and emotePool');
        }

        this.aiEngine = aiEngine;
        this.mediaPipeline = mediaPipeline;
        this.emotePool = emotePool;
        this.errorHandler = errorHandler;
        if (!errorHandler) {
            console.warn('[ChatRouter] No errorHandler provided; error immunity is degraded.');
        }

        this.clock = clock;
        this.chatContextLength = chatContextLength;
        this.maxMessageLength = maxMessageLength;
        this.communityGiftWindowMs = communityGiftWindowMs;
        this.transport = null;

        this.#systemInstructions = typeof systemInstructions === 'string' ? systemInstructions : FACTORY.system_instructions;

        this.prefixLists = {
            ai: asPrefixList(prefixes.ai, DEFAULT_PREFIXES.ai),
            image: asPrefixList(prefixes.image, DEFAULT_PREFIXES.image),
            video: asPrefixList(prefixes.video, DEFAULT_PREFIXES.video),
            tts: asPrefixList(prefixes.tts, DEFAULT_PREFIXES.tts),
            music: asPrefixList(prefixes.music, DEFAULT_PREFIXES.music)
        };
        this.allPrefixes = [
            ...this.prefixLists.ai,
            ...this.prefixLists.image,
            ...this.prefixLists.video,
            ...this.prefixLists.tts,
            ...this.prefixLists.music
        ];

        this.cooldowns = new CooldownTracker({ duration: cooldownDuration, clock });
        this.customCommands = new CustomCommandRegistry({ customCommands });
        this.eventAlerts = new EventAlertRegistry({ eventAlerts });
        this.eventCooldowns = new EventCooldownTracker({ clock });

        // Media command settings from config:commands.media are the live source of
        // truth; the prefix lists above remain as boot fallback when no config exists.
        this.mediaCommands = mediaCommands && typeof mediaCommands === 'object'
            ? { ...structuredClone(FACTORY.commands.media), ...mediaCommands }
            : null;
        if (this.mediaCommands) {
            this.#rebuildMediaRouting();
        } else {
            this.matcher = new CommandMatcher(this.prefixLists.ai, entriesFromPrefixLists(this.prefixLists));
        }
        this.#communityGifts = new Map();
    }

    /**
     * Live view of the response cooldown seconds. WebServer assigns this on
     * dashboard saves so config:bot_settings.cooldown_duration hot-applies.
     */
    get cooldownDuration() {
        return this.cooldowns.duration;
    }

    set cooldownDuration(seconds) {
        this.cooldowns.duration = typeof seconds === 'number' ? seconds : 1;
    }

    #rebuildMediaRouting() {
        const entries = [];
        for (const type of MEDIA_TYPES) {
            const cfg = this.mediaCommands?.[type];
            const all = normalizedCommandList(cfg);
            const enabled = cfg && cfg.enabled === false ? [] : all;
            for (const cmd of all) {
                entries.push({ cmd, mediaType: type, enabled: enabled.includes(cmd) });
            }
            this.prefixLists[type] = enabled;
        }
        this.allPrefixes = [
            ...this.prefixLists.ai,
            ...this.prefixLists.image,
            ...this.prefixLists.video,
            ...this.prefixLists.tts,
            ...this.prefixLists.music
        ];
        this.matcher = new CommandMatcher(this.prefixLists.ai, entries);
    }

    /**
     * Hot-reloads generative media command settings (names, aliases, enabled flags,
     * models, voices, duration caps, access) from config:commands.media.
     * @param {object} media sanitized commands.media object
     */
    reloadMediaCommands(media) {
        if (!media || typeof media !== 'object') return;
        this.mediaCommands = { ...structuredClone(FACTORY.commands.media), ...media };
        this.#rebuildMediaRouting();
    }

    /**
     * Hot-reloads AI command prefixes from config:bot_settings.bot_command_name,
     * keeping media routing untouched.
     * @param {string} nameCsv comma-separated trigger list
     */
    reloadAiPrefixes(nameCsv) {
        const next = asPrefixList(nameCsv, []);
        if (next.length === 0) return;
        this.prefixLists.ai = next;
        this.allPrefixes = [
            ...next,
            ...this.prefixLists.image,
            ...this.prefixLists.video,
            ...this.prefixLists.tts,
            ...this.prefixLists.music
        ];
        this.matcher = new CommandMatcher(next, this.matcher.media);
    }

    #buildHarnessInstructions() {
        const parts = [this.emotePool.getHarnessInstructions()];
        const mediaHarness = this.mediaPipeline.getHarnessInstructions?.(this.prefixLists);
        if (mediaHarness) parts.push(mediaHarness);
        return parts;
    }

    /**
     * Binds inbound IRC messages and EventSub events. Returns an unsubscribe function.
     * @param {object} transport TwitchTransport-like collaborator
     * @returns {() => void}
     */
    attach(transport) {
        if (!transport) {
            throw new Error('attach(transport) requires a transport instance');
        }
        this.transport = transport;
        let listening = true;

        const onMessage = (message) => {
            if (!listening) return undefined;
            return Promise.resolve(this.handle(message)).catch((error) => {
                console.error('[ChatRouter] Routing failed:', error);
                return { kind: 'error', channel: message?.channel, sent: false };
            });
        };

        const onEvent = (event) => {
            if (!listening) return undefined;
            return Promise.resolve(this.handleEvent(event)).catch((error) => {
                console.error('[ChatRouter] Event routing failed:', error);
                return { kind: 'error', channel: event?.channel, sent: false };
            });
        };

        const transportUnsub = transport.onMessage(onMessage);
        const eventUnsub = typeof transport.onEvent === 'function' ? transport.onEvent(onEvent) : null;

        return () => {
            listening = false;
            if (typeof transportUnsub === 'function') transportUnsub();
            if (typeof eventUnsub === 'function') eventUnsub();
        };
    }

    /**
     * Re-reads custom commands from configured source or supplied override.
     * @param {Array|Map} [source] Optional new Array or Map
     */
    reloadCustomCommands(source) {
        this.customCommands.reload(source);
    }

    /**
     * Re-reads event alerts from configured source or supplied override.
     * @param {object} [source] Optional new object
     */
    reloadEventAlerts(source) {
        this.eventAlerts.reload(source);
    }

    /**
     * Current system instructions persona.
     */
    get systemInstructions() {
        return this.#systemInstructions;
    }

    /**
     * Re-reads system instructions persona from supplied string.
     * @param {string} [source] Optional string override
     */
    reloadSystemInstructions(source) {
        if (typeof source === 'string') {
            this.#systemInstructions = source;
        }
    }

    #flaggedPersona(channel) {
        if (typeof this.emotePool.flagText === 'function') {
            return this.emotePool.flagText(channel, this.systemInstructions);
        }
        return this.systemInstructions || '';
    }

    /**
     * Route one inbound chat message. Safe for hermetic tests via transportOverride.
     * Throws synchronously if no transport is available.
     * @param {object} message Inbound message payload
     * @param {object} [transportOverride] Optional transport for testing
     * @returns {Promise<object>} RouteResult
     */
    async handle(message = {}, transportOverride) {
        const transport = transportOverride || this.transport;
        if (!transport) {
            throw new Error('ChatRouter.handle() requires an attached transport or transportOverride');
        }

        const channel = message.channel;
        const text = message.text ?? '';

        try {
            const lower = text.toLowerCase();
            const aiCommand = this.matcher.matchAi(lower);

            // 1. Single-pass emote ingestion + logging (always occurs, even for emote-only messages)
            const { textForAi, textForLogs, emoteIdMap, isEmoteOnly } =
                this.emotePool.ingestMessage({
                    channel,
                    text,
                    tags: message.tags,
                    prefix: aiCommand || ''
                });

            if (transport.logMessage) {
                const color = typeof message.tags?.color === 'string' && message.tags.color.trim()
                    ? message.tags.color.trim()
                    : undefined;
                transport.logMessage(channel, message.username, textForLogs, {
                    twitchEmotesByName: emoteIdMap
                }, {
                    badges: normalizeBadges(message),
                    color
                });
            }

            // 2. Custom command matching & RBAC
            const custom = this.customCommands.match(text);
            if (custom) {
                if (!userHasRole(message, custom.role)) {
                    return { kind: 'unauthorized', channel, command: custom.cmd, sent: false };
                }

                const cooldown = this.cooldowns.checkAndConsume(channel);
                if (cooldown.onCooldown) {
                    return {
                        kind: 'cooldown',
                        channel,
                        command: custom.cmd,
                        sent: false,
                        remaining: cooldown.remaining
                    };
                }

                await transport.send(channel, custom.response);
                return {
                    kind: 'custom',
                    channel,
                    command: custom.cmd,
                    sent: true,
                    reply: custom.response
                };
            }

            // 3. Media command matching
            const media = this.matcher.matchMedia(lower);
            if (media) {
                if (media.enabled === false) {
                    const reply = this.#safeErrorReply('MEDIA_COMMAND_DISABLED');
                    if (transport && reply) await transport.send(channel, reply);
                    return { kind: 'media_disabled', channel, command: media.cmd, mediaType: media.mediaType, sent: Boolean(reply && transport) };
                }

                const access = this.mediaCommands?.[media.mediaType]?.access
                    || this.mediaCommands?.access
                    || 'everyone';
                if (!mediaAccessAllowed(message, access)) {
                    const reply = this.#safeErrorReply('MEDIA_ACCESS_DENIED');
                    if (transport && reply) await transport.send(channel, reply);
                    return { kind: 'media_denied', channel, command: media.cmd, mediaType: media.mediaType, sent: Boolean(reply && transport) };
                }

                const prompt = this.matcher.mediaPrompt(text, media.cmd);
                if (prompt) {
                    const cooldown = this.cooldowns.checkAndConsume(channel);
                    if (cooldown.onCooldown) {
                        return this.#sendCooldown(transport, channel, cooldown, {
                            command: media.cmd,
                            mediaType: media.mediaType
                        });
                    }
                }

                const result = await this.mediaPipeline.synthesize({
                    channel,
                    user: message.tags,
                    prompt,
                    mediaType: media.mediaType,
                    command: media.cmd,
                    options: buildMediaOptions(this.mediaCommands?.[media.mediaType])
                });
                await transport.send(channel, result.replyText);
                return {
                    kind: 'media',
                    channel,
                    command: media.cmd,
                    mediaType: media.mediaType,
                    sent: true,
                    reply: result.replyText
                };
            }

            // 4. AI conversational command matching
            if (aiCommand) {
                if (isEmoteOnly) {
                    console.log(`Command ${aiCommand} ignored: emote-only message`);
                    return { kind: 'emote_only', channel, command: aiCommand, sent: false };
                }

                const cooldown = this.cooldowns.checkAndConsume(channel);
                if (cooldown.onCooldown) {
                    return this.#sendCooldown(transport, channel, cooldown, { command: aiCommand });
                }

                const { channelContext, recentLogs } = await transport.getContext(channel, {
                    logCount: this.chatContextLength,
                    commandPrefixes: this.allPrefixes
                });
                const role = message.isBroadcaster ? 'broadcaster' : message.isMod ? 'moderator' : 'viewer';
                const prompt = `Message from (role:${role}) ${message.loginName}: ${textForAi}`;
                const rawResponse = await this.aiEngine.generate(prompt, {
                    channel,
                    channelContext,
                    recentLogs,
                    harnessInstructions: this.#buildHarnessInstructions(),
                    overrideFileContext: this.#flaggedPersona(channel),
                    caller: {
                        loginName: message.loginName,
                        isBroadcaster: !!message.isBroadcaster,
                        isMod: !!message.isMod
                    }
                });
                const reply = this.emotePool.decorateReply(channel, rawResponse, {
                    maxLength: this.maxMessageLength
                });
                await transport.send(channel, reply);
                return { kind: 'ai', channel, command: aiCommand, sent: true, reply };
            }

            return { kind: 'none', channel, sent: false };
        } catch (error) {
            console.error('[ChatRouter] Failed to handle chat message:', error);
            return this.#sendSafeError(transport, channel, error);
        }
    }

    async #sendCooldown(transport, channel, cooldown, extra = {}) {
        const reply = this.errorHandler?.format?.('COOLDOWN_ACTIVE', {
            remainingTime: cooldown.remaining
        });

        if (transport && reply) {
            await transport.send(channel, reply);
            return {
                kind: 'cooldown',
                channel,
                sent: true,
                remaining: cooldown.remaining,
                reply,
                ...extra
            };
        }

        return {
            kind: 'cooldown',
            channel,
            sent: false,
            remaining: cooldown.remaining,
            ...extra
        };
    }

    async #sendSafeError(transport, channel, error) {
        try {
            const reply = this.#safeErrorReply(error);
            if (transport && reply) {
                await transport.send(channel, reply);
                return { kind: 'error', channel, sent: true, reply, error: error?.message };
            }
            return { kind: 'error', channel, sent: false, reply: reply || undefined, error: error?.message };
        } catch (sendError) {
            console.error('[ChatRouter] Failed to send error response:', sendError);
            return { kind: 'error', channel, sent: false, error: error?.message };
        }
    }

    #safeErrorReply(error) {
        if (typeof this.errorHandler?.format === 'function') {
            return this.errorHandler.format(error);
        }
        return null;
    }

    /**
     * Route one inbound Twitch EventSub event.
     * @param {object} event BotTriggerEvent payload
     * @param {object} [transportOverride] Optional transport for testing
     * @returns {Promise<object>} EventRouteResult
     */
    async handleEvent(event = {}, transportOverride) {
        const transport = transportOverride || this.transport;
        if (!transport) {
            throw new Error('ChatRouter.handleEvent() requires an attached transport or transportOverride');
        }

        const channel = event.channel;
        const eventKind = event.kind;

        try {
            const policy = this.eventAlerts.getPolicy(eventKind);
            if (!policy || policy.enabled === false) {
                return { kind: 'disabled', channel, eventKind, sent: false };
            }

            if (eventKind === 'cheer' && typeof policy.min_bits === 'number'
                && (Number(event.details?.bits) || 0) < policy.min_bits) {
                return { kind: 'threshold', channel, eventKind, sent: false };
            }
            if (eventKind === 'raid' && typeof policy.min_viewers === 'number'
                && (Number(event.details?.viewers) || 0) < policy.min_viewers) {
                return { kind: 'threshold', channel, eventKind, sent: false };
            }

            if (eventKind === 'sub_gift' && this.#consumeCommunityGift(channel, event.user)) {
                return { kind: 'suppressed', channel, eventKind, sent: false, reason: 'community_gift' };
            }

            const cooldown = this.eventCooldowns.checkAndConsume(
                channel, eventKind, Number(policy.cooldown_seconds) || 0
            );
            if (cooldown.onCooldown) {
                return { kind: 'cooldown', channel, eventKind, sent: false, remaining: cooldown.remaining };
            }

            if (eventKind === 'community_sub_gift') {
                const key = this.#giftBombKey(channel, event.user);
                const count = Number(event.details?.count) || 1;
                this.#communityGifts.set(key, {
                    count,
                    expiresAt: this.clock() + this.communityGiftWindowMs
                });
            }

            const vars = eventVars(event);
            let reply = '';
            let source = 'fallback';

            if (eventKind === 'channel_points') {
                const rewardCfg = findRewardConfig(policy, event.details?.reward?.title);
                if (!rewardCfg) {
                    return { kind: 'unconfigured_reward', channel, eventKind, sent: false };
                }
                const aiEnabled = rewardCfg.ai_enabled !== false;
                const fallbackTemplate = rewardCfg.fallback_template || '';
                const promptTemplate = rewardCfg.ai_prompt || '';

                if (aiEnabled && promptTemplate) {
                    try {
                        const { channelContext, recentLogs } = await transport.getContext(channel, {
                            logCount: this.chatContextLength,
                            commandPrefixes: this.allPrefixes
                        });
                        const framed = `[Event Alert: ${eventKind}] ${interpolate(promptTemplate, vars)}`;
                        const flaggedFramed = typeof this.emotePool.flagText === 'function'
                            ? this.emotePool.flagText(channel, framed)
                            : framed;
                        const raw = await this.aiEngine.generate(flaggedFramed, {
                            channel,
                            channelContext,
                            recentLogs,
                            harnessInstructions: [
                                this.emotePool.getHarnessInstructions(),
                                EVENT_ALERT_HARNESS
                            ],
                            overrideFileContext: this.#flaggedPersona(channel),
                            caller: {
                                loginName: event.user?.login || '',
                                isBroadcaster: false,
                                isMod: false
                            }
                        });
                        if (raw && String(raw).trim()) {
                            reply = this.emotePool.decorateReply(channel, raw, {
                                maxLength: this.maxMessageLength
                            });
                            source = 'ai';
                        }
                    } catch {
                        // Silent - quota, timeout, safety, network. Chat never sees this.
                    }
                }

                if (source !== 'ai') {
                    reply = interpolate(fallbackTemplate, vars).trim();
                    source = 'fallback';
                }

                if (!reply) {
                    return { kind: 'event', channel, eventKind, sent: false, source };
                }

                await transport.send(channel, reply);
                return { kind: 'event', channel, eventKind, sent: true, reply, source };
            }

            const aiEnabled = policy.ai_enabled !== false;
            const fallbackTemplate = policy.fallback_template || '';
            const promptTemplate = policy.ai_prompt || '';

            if (aiEnabled && promptTemplate) {
                try {
                    const { channelContext, recentLogs } = await transport.getContext(channel, {
                        logCount: this.chatContextLength,
                        commandPrefixes: this.allPrefixes
                    });
                    const framed = `[Event Alert: ${eventKind}] ${interpolate(promptTemplate, vars)}`;
                    const flaggedFramed = typeof this.emotePool.flagText === 'function'
                        ? this.emotePool.flagText(channel, framed)
                        : framed;
                    const raw = await this.aiEngine.generate(flaggedFramed, {
                        channel,
                        channelContext,
                        recentLogs,
                        harnessInstructions: [
                            this.emotePool.getHarnessInstructions(),
                            EVENT_ALERT_HARNESS
                        ],
                        overrideFileContext: this.#flaggedPersona(channel),
                        caller: {
                            loginName: event.user?.login || '',
                            isBroadcaster: false,
                            isMod: false
                        }
                    });
                    if (raw && String(raw).trim()) {
                        reply = this.emotePool.decorateReply(channel, raw, {
                            maxLength: this.maxMessageLength
                        });
                        source = 'ai';
                    }
                } catch {
                    // Silent - quota, timeout, safety, network. Chat never sees this.
                }
            }

            if (source !== 'ai') {
                reply = interpolate(fallbackTemplate, vars).trim();
                source = 'fallback';
            }

            if (!reply) {
                return { kind: 'event', channel, eventKind, sent: false, source };
            }

            await transport.send(channel, reply);
            return { kind: 'event', channel, eventKind, sent: true, reply, source };
        } catch (error) {
            console.error('[ChatRouter] Failed to handle event:', error);
            // Last resort: try fallback one more time, still never leak the error.
            try {
                const policy = this.eventAlerts.getPolicy(eventKind);
                if (eventKind === 'channel_points') {
                    const rewardCfg = findRewardConfig(policy, event.details?.reward?.title);
                    if (rewardCfg?.fallback_template) {
                        const reply = interpolate(rewardCfg.fallback_template, eventVars(event)).trim();
                        if (transport && reply) {
                            await transport.send(channel, reply);
                            return { kind: 'event', channel, eventKind, sent: true, reply, source: 'fallback' };
                        }
                    }
                } else if (policy?.fallback_template) {
                    const reply = interpolate(policy.fallback_template, eventVars(event)).trim();
                    if (transport && reply) {
                        await transport.send(channel, reply);
                        return { kind: 'event', channel, eventKind, sent: true, reply, source: 'fallback' };
                    }
                }
            } catch { /* ignore */ }
            return { kind: 'error', channel, eventKind, sent: false };
        }
    }

    #giftBombKey(channel, user) {
        const userIdentifier = user?.id || cleanName(user?.login) || 'anonymous';
        return `${channelKey(channel)}:${userIdentifier}`;
    }

    #consumeCommunityGift(channel, user) {
        const key = this.#giftBombKey(channel, user);
        const bomb = this.#communityGifts.get(key);
        if (!bomb) return false;
        if (this.clock() >= bomb.expiresAt || bomb.count <= 0) {
            this.#communityGifts.delete(key);
            return false;
        }
        bomb.count--;
        if (bomb.count <= 0) {
            this.#communityGifts.delete(key);
        }
        return true;
    }
}

export default ChatRouter;
