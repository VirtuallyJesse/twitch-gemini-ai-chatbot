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

function defaultFileReader(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

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
        cooldownDuration = 1,
        chatContextLength = 10,
        maxMessageLength = 499,
        prefixes = {},
        clock = Date.now,
        fileReader = defaultFileReader
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

        this.chatContextLength = chatContextLength;
        this.maxMessageLength = maxMessageLength;
        this.transport = null;

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
        this.matcher = new CommandMatcher(this.prefixLists);
    }

    /**
     * Binds inbound IRC messages to handle(). Returns an unsubscribe function.
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

        const transportUnsub = transport.onMessage(onMessage);
        return () => {
            listening = false;
            if (typeof transportUnsub === 'function') transportUnsub();
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
                const prompt = `Message from user ${message.loginName}: ${textForAi}`;
                const rawResponse = await this.aiEngine.generate(prompt, {
                    channel,
                    channelContext,
                    recentLogs
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
        const reply = this.errorHandler?.getMessage?.('COOLDOWN_ACTIVE', {
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
        if (typeof this.errorHandler?.createErrorResponse === 'function') {
            return this.errorHandler.createErrorResponse(error);
        }
        if (typeof this.errorHandler?.getMessage === 'function') {
            return this.errorHandler.getMessage('UNKNOWN_ERROR');
        }
        return null;
    }
}

export default ChatRouter;
