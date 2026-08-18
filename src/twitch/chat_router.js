// twitch-gemini-ai-chatbot/src/twitch/chat_router.js
// Coordinates Twitch chat ingestion, command RBAC, media/AI dispatch,
// per-channel cooldowns, and chatter-safe error translation.
import fs from 'fs';

const VALID_ROLES = new Set(['broadcaster', 'moderator', 'all']);
const DEFAULT_PREFIXES = {
    ai: ['!gemini'],
    image: ['!image'],
    video: ['!video'],
    tts: ['!tts'],
    music: ['!song']
};

const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
const channelKey = (channel) => `#${cleanName(channel)}`;

function defaultFileReader(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function defaultFileStat(filePath) {
    return fs.statSync(filePath);
}

const DEFAULT_EVENT_ALERTS = {
    subscription: {
        enabled: true,
        ai_enabled: true,
        cooldown_seconds: 0,
        fallback_template: 'Welcome to the community, {username}! Thanks for subscribing at {tier}!',
        ai_prompt: 'Acknowledge {username} subscribing at {tier} with an enthusiastic welcome.'
    },
    resub: {
        enabled: true,
        ai_enabled: true,
        cooldown_seconds: 0,
        fallback_template: 'Welcome back, {username}! Thanks for {months} months of support (streak: {streak})! {message}',
        ai_prompt: "Celebrate {username} resubscribing for {months} cumulative months (streak: {streak}). Their resub message: '{message}'."
    },
    community_sub_gift: {
        enabled: true,
        ai_enabled: true,
        cooldown_seconds: 0,
        fallback_template: 'Huge hype! {username} just gifted {count} subscriptions to the community!',
        ai_prompt: 'Celebrate {username} generously gifting {count} subscriptions to the community with massive hype.'
    },
    sub_gift: {
        enabled: true,
        ai_enabled: true,
        cooldown_seconds: 0,
        suppress_in_community_gift: true,
        fallback_template: 'Thanks for the gift sub, {username}!',
        ai_prompt: 'Thank {username} for gifting a subscription to the channel.'
    },
    cheer: {
        enabled: true,
        ai_enabled: true,
        min_bits: 100,
        cooldown_seconds: 0,
        fallback_template: 'Thanks for cheering {bits} bits, {username}! {message}',
        ai_prompt: "Thank {username} for cheering {bits} bits. Their cheer message: '{message}'."
    },
    channel_points: {
        enabled: true,
        ai_enabled: true,
        cooldown_seconds: 5,
        default_fallback_template: '{username} redeemed {reward}!',
        rewards: {
            Hydrate: {
                ai_enabled: true,
                fallback_template: 'Drink water, streamer! {username} redeemed Hydrate!',
                ai_prompt: "Remind the streamer to hydrate in your cheeky persona, requested by {username}. Note: '{user_input}'."
            }
        }
    },
    raid: {
        enabled: true,
        ai_enabled: true,
        min_viewers: 1,
        cooldown_seconds: 10,
        fallback_template: 'Welcome raiders! Thanks {username} for bringing {viewers} viewers over!',
        ai_prompt: 'Welcome {username} and their raid of {viewers} viewers with huge energy.'
    },
    follow: {
        enabled: false,
        ai_enabled: false,
        cooldown_seconds: 5,
        fallback_template: 'Thanks for following the channel, {username}!',
        ai_prompt: 'Thank {username} for following the channel.'
    }
};

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

function parseCustomCommandText(source) {
    const commands = new Map();
    if (source == null) return commands;

    for (const line of String(source).split('\n')) {
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

        if (!VALID_ROLES.has(role)) {
            console.warn(`[Custom Commands] Invalid role "${role}" for command "${cmd}", defaulting to "all"`);
            role = 'all';
        }

        if (cmd && response) {
            commands.set(cmd, { response, role });
        }
    }

    return commands;
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
    #mtimeMs = -1;

    constructor({ eventAlerts, eventAlertsPath, fileReader, fileStat }) {
        this.eventAlertsPath = eventAlertsPath;
        this.fileReader = fileReader;
        this.fileStat = fileStat;
        this.source = 'file';
        this.config = DEFAULT_EVENT_ALERTS;
        this.#mtimeMs = -1;
        if (eventAlerts && typeof eventAlerts === 'object') {
            this.source = 'object';
            this.config = eventAlerts;
            return;
        }
        this.#maybeReload(true);
    }

    getPolicy(kind) {
        this.#maybeReload(false);
        return this.config?.[kind] || null;
    }

    reload(source) {
        if (source && typeof source === 'object') {
            this.source = 'object';
            this.config = source;
            return;
        }
        if (this.source === 'object') return;
        this.source = 'file';
        this.#mtimeMs = -1;
        this.#maybeReload(true);
    }

    #maybeReload(force) {
        if (this.source !== 'file') return;
        try {
            const stat = this.fileStat(this.eventAlertsPath);
            const mtimeMs = stat?.mtimeMs ?? 0;
            if (!force && mtimeMs === this.#mtimeMs) return;
            const parsed = JSON.parse(this.fileReader(this.eventAlertsPath));
            if (!parsed || typeof parsed !== 'object') throw new Error('event_alerts.json must be an object');
            this.config = parsed;
            this.#mtimeMs = mtimeMs;
        } catch (error) {
            if (force && error?.code === 'ENOENT') {
                console.log('[Event Alerts] No event_alerts.json found, using defaults.');
                this.config = DEFAULT_EVENT_ALERTS;
                return;
            }
            if (force) {
                console.error('[Event Alerts] Error loading event_alerts.json:', error);
                this.config = DEFAULT_EVENT_ALERTS;
            }
            // stale config kept on mid-flight parse errors
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
    constructor({ customCommands, customCommandsPath, fileReader }) {
        this.customCommandsPath = customCommandsPath;
        this.fileReader = fileReader;
        this.source = 'file';
        this.commands = new Map();
        this.reload(customCommands);
    }

    reload(source) {
        if (source instanceof Map) {
            this.source = 'map';
            this.commands = source;
            return;
        }

        if (typeof source === 'string') {
            this.source = 'string';
            this.raw = source;
            this.commands = parseCustomCommandText(source);
            return;
        }

        if (this.source === 'map') return;

        if (this.source === 'string') {
            this.commands = parseCustomCommandText(this.raw);
            return;
        }

        try {
            const data = this.fileReader(this.customCommandsPath);
            this.commands = parseCustomCommandText(data);
            console.log(`[Custom Commands] Loaded ${this.commands.size} command(s) from custom_commands.txt`);
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                console.log('[Custom Commands] No custom_commands.txt found, skipping.');
            } else {
                console.error('[Custom Commands] Error loading custom_commands.txt:', error);
            }
            this.commands = new Map();
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
    constructor(prefixLists) {
        this.ai = prefixLists.ai;
        this.media = [
            ...prefixLists.music.map((cmd) => ({ cmd, mediaType: 'music' })),
            ...prefixLists.tts.map((cmd) => ({ cmd, mediaType: 'tts' })),
            ...prefixLists.video.map((cmd) => ({ cmd, mediaType: 'video' })),
            ...prefixLists.image.map((cmd) => ({ cmd, mediaType: 'image' }))
        ];
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

function userHasRole({ isBroadcaster, isMod } = {}, requiredRole) {
    if (!requiredRole || requiredRole === 'all') return true;
    if (requiredRole === 'broadcaster') return !!isBroadcaster;
    return !!isBroadcaster || !!isMod;
}

export class ChatRouter {
    #communityGifts = new Map();
    #systemInstructions = '';
    #systemInstructionsPath;
    #systemInstructionsSource = 'file';
    #systemInstructionsMtimeMs = -1;
    #fileReader;
    #fileStat;

    /**
     * @param {object} options collaborator instances and policy. Never reads environment variables.
     */
    constructor({
        aiEngine,
        mediaPipeline,
        emotePool,
        errorHandler,
        customCommandsPath = './custom_commands.txt',
        customCommands,
        eventAlertsPath = './event_alerts.json',
        eventAlerts,
        systemInstructionsPath = './system_instructions.txt',
        systemInstructions,
        cooldownDuration = 1,
        chatContextLength = 10,
        maxMessageLength = 499,
        communityGiftWindowMs = 30_000,
        prefixes = {},
        clock = Date.now,
        fileReader = defaultFileReader,
        fileStat = defaultFileStat
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

        this.#systemInstructionsPath = systemInstructionsPath;
        this.#systemInstructionsMtimeMs = -1;
        this.#fileReader = fileReader;
        this.#fileStat = fileStat;
        if (typeof systemInstructions === 'string') {
            this.#systemInstructionsSource = 'override';
            this.#systemInstructions = systemInstructions;
        } else {
            this.#systemInstructionsSource = 'file';
            this.#systemInstructions = '';
            this.#maybeReloadSystemInstructions(true);
        }

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
        this.customCommands = new CustomCommandRegistry({
            customCommands,
            customCommandsPath,
            fileReader
        });
        this.eventAlerts = new EventAlertRegistry({
            eventAlerts,
            eventAlertsPath,
            fileReader,
            fileStat
        });
        this.eventCooldowns = new EventCooldownTracker({ clock });
        this.matcher = new CommandMatcher(this.prefixLists);
        this.#communityGifts = new Map();
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
     * @param {Map|string} [source] Optional new Map or raw string
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
     * Current system instructions persona. Reloads from file if modified on disk.
     */
    get systemInstructions() {
        this.#maybeReloadSystemInstructions(false);
        return this.#systemInstructions;
    }

    /**
     * Re-reads system instructions persona from configured source or supplied override.
     * @param {string} [source] Optional string override
     */
    reloadSystemInstructions(source) {
        if (typeof source === 'string') {
            this.#systemInstructionsSource = 'override';
            this.#systemInstructions = source;
            return;
        }
        if (this.#systemInstructionsSource === 'override') return;
        this.#systemInstructionsSource = 'file';
        this.#systemInstructionsMtimeMs = -1;
        this.#maybeReloadSystemInstructions(true);
    }

    #maybeReloadSystemInstructions(force) {
        if (this.#systemInstructionsSource !== 'file') return;
        try {
            const stat = this.#fileStat(this.#systemInstructionsPath);
            const mtimeMs = stat?.mtimeMs ?? 0;
            if (!force && mtimeMs === this.#systemInstructionsMtimeMs) return;
            this.#systemInstructions = String(this.#fileReader(this.#systemInstructionsPath) ?? '');
            this.#systemInstructionsMtimeMs = mtimeMs;
        } catch (error) {
            if (force && error?.code === 'ENOENT') {
                console.log('[System Instructions] No system_instructions.txt found.');
                this.#systemInstructions = '';
                return;
            }
            if (force) {
                console.error('[System Instructions] Error loading system_instructions.txt:', error);
                this.#systemInstructions = '';
            }
            // mid-flight parse/IO errors keep the last good persona
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
                transport.logMessage(channel, message.username, textForLogs, {
                    twitchEmotesByName: emoteIdMap
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
                    command: media.cmd
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

            if (eventKind === 'sub_gift' && policy.suppress_in_community_gift
                && this.#consumeCommunityGift(channel, event.user)) {
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

            const rewardCfg = eventKind === 'channel_points'
                ? findRewardConfig(policy, event.details?.reward?.title)
                : null;
            const aiEnabled = eventKind === 'channel_points'
                ? (rewardCfg ? (policy.ai_enabled !== false && rewardCfg.ai_enabled !== false) : false)
                : policy.ai_enabled !== false;
            const fallbackTemplate = rewardCfg?.fallback_template
                || (eventKind === 'channel_points' ? policy.default_fallback_template : policy.fallback_template)
                || policy.default_fallback_template
                || '';
            const promptTemplate = rewardCfg?.ai_prompt
                || (eventKind === 'channel_points' ? '' : policy.ai_prompt)
                || '';
            const vars = eventVars(event);

            let reply = '';
            let source = 'fallback';

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
                const reply = interpolate(
                    policy?.fallback_template || policy?.default_fallback_template || '',
                    eventVars(event)
                ).trim();
                if (transport && reply) {
                    await transport.send(channel, reply);
                    return { kind: 'event', channel, eventKind, sent: true, reply, source: 'fallback' };
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
