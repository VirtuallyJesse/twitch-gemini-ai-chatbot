import ErrorHandler, { BotError } from '../utils/error_handler.js';
import { FACTORY } from '../utils/bot_config.js';
import { normalizeBadges } from '../utils/badges.js';

const MEDIA_TYPE_HARNESS = [
    { key: 'image', bullet: 'Generating images' },
    { key: 'video', bullet: 'Generating videos' },
    { key: 'tts', bullet: 'Generating text to speech' },
    { key: 'music', bullet: 'Generating music' }
];

const MEDIA_URL_POSITIONS = ['start', 'middle', 'end'];

const MEDIA_PRESENTATION_HARNESS = [
    '<media_delivery>',
    'Write the single Twitch chat message that accompanies the completed media.',
    'Treat the request as part of the ongoing conversation. If recent chat provides a relevant joke, role, invented detail, or callback, prefer that as the main angle.',
    'Add one brief, fresh thought rather than simply restating or renaming elements of the requested scene.',
    'Base commentary only on the request and conversation; do not imply you inspected the generated media.',
    'Include the exact generated media URL from runtime context exactly once.',
    '</media_delivery>'
].join('\n');

const URL_PLACEMENT_HARNESS = {
    start: 'Place the generated media URL before the commentary body.',
    middle: 'Place the generated media URL at a natural boundary within the commentary, normally between clauses or sentences.',
    end: 'Place the generated media URL after the commentary body.'
};

function providerId(provider) {
    return String(provider?.id || provider?.name || '').trim();
}

function normalizeProviders(providers) {
    const registry = new Map();
    const list = Array.isArray(providers) ? providers : Object.values(providers || {});
    for (const provider of list) {
        if (!provider || typeof provider.generate !== 'function') continue;
        const id = providerId(provider);
        if (!id) throw new Error('Media providers require a stable id');
        if (registry.has(id)) throw new Error(`Duplicate media provider id: ${id}`);
        registry.set(id, provider);
    }
    return registry;
}

function supportsType(provider, mediaType) {
    if (!provider) return false;
    if (typeof provider.supports === 'function') return provider.supports(mediaType);
    return provider.capabilities?.mediaTypes?.has(mediaType) === true;
}

function normalizeTargets(media = FACTORY.commands.media) {
    const targets = new Map();
    for (const { key } of MEDIA_TYPE_HARNESS) {
        const source = media?.[key] || FACTORY.commands.media[key];
        targets.set(key, {
            provider: String(source.provider || ''),
            model: String(source.model || ''),
            ...(('voice' in source && source.voice) ? { voice: String(source.voice) } : {}),
            ...(('duration' in source && Number.isFinite(Number(source.duration))) ? { duration: Number(source.duration) } : {})
        });
    }
    return targets;
}

function emptyCatalog() {
    return { image: [], video: [], tts: [], music: [] };
}

function resolveUsername(user) {
    if (!user) return 'someone';
    if (typeof user === 'string') return user;
    return user['display-name'] || user.username || user.name || 'someone';
}

function byteLength(value) {
    return value?.byteLength ?? value?.length ?? 0;
}

function extractText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && typeof result.text === 'string') return result.text;
    return '';
}

function isPresentationFailure(result, errorHandler) {
    if (errorHandler && typeof errorHandler.isFailure === 'function') {
        return errorHandler.isFailure(result);
    }
    if (!result) return true;
    if (typeof result === 'object') {
        if (result.blocked === true || result.safetyBlocked === true) return true;
        if (!result.text || !String(result.text).trim()) return true;
    }
    return !extractText(result).trim();
}

function ensureExactUrl(text, url) {
    const value = String(text || '').trim();
    if (!value) return url;
    const withUrl = value.includes(url)
        ? value
        : `${value} ${url}`.trim();

    return withUrl
        .split(url)
        .join(` ${url} `)
        .replace(/\s+/g, ' ')
        .trim();
}

function fitReplyAroundUrl(replyText, url, maxLength = 499) {
    if (!replyText || replyText.length <= maxLength) {
        return replyText;
    }
    if (!url || !replyText.includes(url)) {
        return replyText.slice(0, maxLength);
    }
    if (url.length >= maxLength) {
        return url.slice(0, maxLength);
    }

    const urlIndex = replyText.indexOf(url);
    const prefix = replyText.slice(0, urlIndex).trim();
    const suffix = replyText.slice(urlIndex + url.length).trim();

    const neededSeparators = (prefix ? 1 : 0) + (suffix ? 1 : 0);
    const availableCommentary = maxLength - url.length - neededSeparators;
    if (availableCommentary <= 0) {
        return url;
    }

    let truncatedPrefix = '';
    let truncatedSuffix = '';

    if (suffix) {
        if (suffix.length >= availableCommentary) {
            truncatedSuffix = suffix.slice(0, availableCommentary).trim();
            truncatedPrefix = '';
        } else {
            truncatedSuffix = suffix;
            const remainingForPrefix = availableCommentary - truncatedSuffix.length - (prefix ? 1 : 0);
            if (remainingForPrefix > 0 && prefix) {
                truncatedPrefix = prefix.slice(0, remainingForPrefix).trim();
            }
        }
    } else if (prefix) {
        truncatedPrefix = prefix.slice(0, availableCommentary).trim();
    }

    const parts = [truncatedPrefix, url, truncatedSuffix].filter(Boolean);
    return parts.join(' ').trim();
}

export class MediaPipeline {
    #onMediaSaved = null;
    #urlPlacementByChannel = new Map();

    constructor({
        providers = [],
        targets = FACTORY.commands.media,
        uploader,
        storage,
        aiEngine,
        errorHandler = new ErrorHandler(),
        emotes,
        onMediaSaved = null,
        maxLength = 499,
        now = () => Date.now(),
        idFactory = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    } = {}) {
        this.providers = normalizeProviders(providers);
        this.targets = normalizeTargets(targets);
        this.uploader = uploader;
        this.storage = storage;
        this.aiEngine = aiEngine;
        this.errorHandler = errorHandler || new ErrorHandler();
        this.emotes = emotes;
        this.#onMediaSaved = typeof onMediaSaved === 'function' ? onMediaSaved : null;
        this.maxLength = maxLength;
        this.now = now;
        this.idFactory = idFactory;
    }

    get onMediaSaved() { return this.#onMediaSaved; }
    set onMediaSaved(handler) {
        this.#onMediaSaved = typeof handler === 'function' ? handler : null;
    }

    reloadTargets(media) {
        if (!media || typeof media !== 'object') return;
        this.targets = normalizeTargets(media);
    }

    #resolveTarget(mediaType) {
        const target = this.targets.get(mediaType) || null;
        const provider = target ? this.providers.get(target.provider) || null : null;
        return { target, provider };
    }

    supports(mediaType) {
        const { provider } = this.#resolveTarget(mediaType);
        return supportsType(provider, mediaType);
    }

    /**
     * Provider-neutral catalog assembled concurrently. A provider adapter owns
     * discovery degradation, so aggregation never needs provider-specific logic.
     */
    async catalog() {
        const result = emptyCatalog();
        const contributions = await Promise.allSettled(
            [...this.providers.values()].map((provider) => provider.catalog?.())
        );
        for (const contribution of contributions) {
            if (contribution.status !== 'fulfilled' || !contribution.value) continue;
            for (const { key } of MEDIA_TYPE_HARNESS) {
                if (Array.isArray(contribution.value[key])) {
                    result[key].push(...contribution.value[key]);
                }
            }
        }
        for (const { key } of MEDIA_TYPE_HARNESS) {
            result[key].sort((left, right) => {
                const providerOrder = ['pollinations', 'google'];
                const leftRank = providerOrder.indexOf(left.provider);
                const rightRank = providerOrder.indexOf(right.provider);
                if (leftRank !== rightRank) return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank);
                return String(left.id).localeCompare(String(right.id));
            });
        }
        return result;
    }

    getSupportedMediaTypes() {
        return MEDIA_TYPE_HARNESS.map(({ key }) => key).filter((key) => this.supports(key));
    }

    getHarnessInstructions(prefixes) {
        if (!prefixes) return null;

        const active = [];
        for (const { key, bullet } of MEDIA_TYPE_HARNESS) {
            if (!this.supports(key)) continue;
            const cmdList = prefixes[key];
            if (cmdList?.length) {
                active.push(`- ${bullet}: ${cmdList[0]}`);
            }
        }

        if (active.length === 0) return null;

        return (
            '<media_commands>\n' +
            'Media generation and editing are available through chat commands. When a user asks to generate or edit supported media, do not say you are unable to generate it; instead, direct them to the matching command. Do not emit or use a media-generation command yourself.\n\n' +
            `${active.join('\n')}\n` +
            '</media_commands>'
        );
    }

    async #saveEntry(entry) {
        if (this.storage && typeof this.storage.addMediaEntry === 'function') {
            try {
                await this.storage.addMediaEntry(entry);
            } catch (error) {
                console.error('[Media] Failed to persist media entry:', error);
            }
        }

        if (typeof this.#onMediaSaved === 'function') {
            try {
                await this.#onMediaSaved(entry);
            } catch (error) {
                console.error('[Media] Failed to notify media subscribers:', error);
            }
        }
    }

    #claimUrlPlacement(channel) {
        const key = String(channel || '').replace(/^#/, '').trim().toLowerCase() || '__default__';
        const index = this.#urlPlacementByChannel.get(key) || 0;
        this.#urlPlacementByChannel.set(key, (index + 1) % MEDIA_URL_POSITIONS.length);
        return MEDIA_URL_POSITIONS[index];
    }

    async #presentMedia({ channel, username, prompt, mediaType, mediaUrl, conversationPrompt }) {
        const fallback = this.errorHandler.format('MEDIA_FALLBACK_RESPONSE', {
            mediaType,
            username,
            url: mediaUrl
        });

        let presentation;
        try {
            const originalRequest = String(prompt || '').trim();
            const urlPlacement = this.#claimUrlPlacement(channel);

            const result = await this.aiEngine?.generate(
                conversationPrompt,
                {
                    disableMultimedia: true,
                    recordMemory: false,
                    channel,
                    harnessInstructions: [
                        MEDIA_PRESENTATION_HARNESS,
                        URL_PLACEMENT_HARNESS[urlPlacement]
                    ].join('\n\n'),
                    mediaDelivery: {
                        mediaType,
                        requester: username,
                        originalRequest,
                        generatedUrl: mediaUrl
                    }
                }
            );

            if (isPresentationFailure(result, this.errorHandler)) {
                presentation = fallback;
            } else {
                presentation = extractText(result).trim() || fallback;
            }
        } catch (error) {
            console.error('[Media] Presentation generation failed:', error);
            presentation = fallback;
        }

        let decorated = presentation;
        try {
            if (this.emotes && typeof this.emotes.decorateReply === 'function') {
                decorated = this.emotes.decorateReply(
                    channel,
                    presentation,
                    { maxLength: this.maxLength }
                ) || presentation;
            }
        } catch (error) {
            console.error('[Media] Reply decoration failed:', error);
        }

        let replyText = ensureExactUrl(decorated, mediaUrl);
        replyText = fitReplyAroundUrl(replyText, mediaUrl, this.maxLength);
        return replyText;
    }

    async synthesize({
        channel,
        user,
        prompt,
        mediaType,
        command,
        conversationPrompt,
    }) {
        const username = resolveUsername(user);
        const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';

        if (!cleanPrompt) {
            return {
                success: false,
                replyText: this.errorHandler.format('MEDIA_PROMPT_REQUIRED', {
                    username,
                    mediaType
                }),
                mediaEntry: null
            };
        }

        try {
            const { target, provider } = this.#resolveTarget(mediaType);
            if (!provider) {
                throw new BotError('MEDIA_PROVIDER_UNAVAILABLE', {
                    params: { provider: target?.provider || 'media provider', mediaType }
                });
            }
            if (!supportsType(provider, mediaType)) {
                throw new BotError('MEDIA_PROVIDER_UNAVAILABLE', {
                    params: { provider: target.provider, mediaType }
                });
            }

            const generated = await provider.generate({
                type: mediaType,
                prompt: cleanPrompt,
                target: { ...target }
            });

            if (!generated?.buffer || byteLength(generated.buffer) === 0) {
                return {
                    success: false,
                    replyText: this.errorHandler.format('MEDIA_NO_DATA', {
                        service: providerId(provider),
                        mediaType
                    }),
                    mediaEntry: null
                };
            }

            const mediaUrl = await this.uploader.upload(generated.buffer, {
                mediaType,
                mimeType: generated.mimeType
            });

            const timestamp = this.now();
            const userId = typeof user === 'object' ? (user['user-id'] || user.userId || user.id || null) : null;
            const avatarUrl = typeof user === 'object' ? (user.profileImageUrl || user.avatarUrl || null) : null;
            const badges = normalizeBadges(user);
            const mediaEntry = {
                id: this.idFactory(),
                timestamp,
                channel,
                username,
                userId,
                avatarUrl,
                command,
                prompt: cleanPrompt,
                mediaUrl,
                mediaType,
                provider: target.provider,
                model: target.model
            };
            if (badges.length > 0) {
                mediaEntry.badges = badges;
            }

            await this.#saveEntry(mediaEntry);

            const replyText = await this.#presentMedia({
                channel,
                username,
                prompt: cleanPrompt,
                mediaType,
                mediaUrl,
                conversationPrompt: conversationPrompt || `${command} ${cleanPrompt}`.trim()
            });

            return {
                success: true,
                replyText,
                mediaEntry
            };
        } catch (error) {
            console.error(`[Media] ${mediaType} synthesis failed:`, error);

            return {
                success: false,
                replyText: this.errorHandler.format(error),
                mediaEntry: null
            };
        }
    }
}

export default MediaPipeline;
