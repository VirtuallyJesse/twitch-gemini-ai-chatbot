import { GoogleGenAI } from '@google/genai';
import ErrorHandler from '../utils/error_handler.js';
import { ImageDownloader } from './image_downloader.js';

const DEFAULT_MODEL = 'gemini-3.7-flash';
const ALLOWED_THINKING_LEVELS = new Set(['low', 'medium', 'high']);

const YT_ID_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const YT_URL_RE = /(https?:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)[\w-]+|https?:\/\/youtu\.be\/[\w-]+)/;
const URL_RE = /(https?:\/\/[^\s]+)/g;

// ANSI color codes for formatted console output
const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
};

export class AIEngine {
    #imageDownloader;
    #clientFor;

    constructor({
        apiKeys,
        modelName = DEFAULT_MODEL,
        fileContext = 'You are a helpful Twitch Chatbot.',
        historyLength = 5,
        enableSearchGrounding = false,
        thinkingLevel = 'medium',
        youtubeApiKey = null,
        maxResponseLength = 450,
        errorHandler = new ErrorHandler(),
        imageDownloader = null,
        fetchImpl = (...a) => globalThis.fetch(...a),
        genAIClient = null,
        verbose = false
    } = {}) {
        this.apiKeys = (Array.isArray(apiKeys) ? apiKeys : String(apiKeys ?? '').split(','))
            .map(k => String(k).trim()).filter(Boolean);
        if (this.apiKeys.length === 0) {
            throw new Error('No API keys provided');
        }

        this.modelName = modelName;
        this.fileContext = fileContext;
        this.historyLength = parseInt(historyLength, 10) || 5;
        this.enableSearchGrounding = String(enableSearchGrounding) === 'true' || enableSearchGrounding === true;
        const level = String(thinkingLevel || 'medium').toLowerCase();
        this.thinkingLevel = ALLOWED_THINKING_LEVELS.has(level) ? level : 'medium';
        this.youtubeApiKey = youtubeApiKey;
        this.maxResponseLength = parseInt(maxResponseLength, 10) || 450;
        this.errorHandler = errorHandler;
        this.fetchImpl = fetchImpl;
        this.verbose = verbose;

        this.currentKeyIndex = 0;
        this.histories = new Map();

        // Private internal collaborator
        this.#imageDownloader = imageDownloader ?? new ImageDownloader({ fetchImpl });
        this.#clientFor = typeof genAIClient === 'function'
            ? genAIClient
            : genAIClient
                ? () => genAIClient
                : (apiKey) => new GoogleGenAI({ apiKey });
    }

    /**
     * Extracts an 11-character YouTube video ID from a URL or text.
     * @param {string} text
     * @returns {string|null}
     */
    static extractYouTubeVideoId(text) {
        const m = String(text || '').match(YT_ID_RE);
        return m ? m[1] : null;
    }

    /**
     * Fetches metadata for a YouTube video using the YouTube Data API.
     * @param {string} videoId
     * @returns {Promise<{title: string, description: string, channelName: string}|null>}
     */
    async #fetchYouTubeSnippet(videoId) {
        if (!this.youtubeApiKey) return null;
        try {
            const res = await this.fetchImpl(
                `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${this.youtubeApiKey}&part=snippet`
            );
            if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
            const data = await res.json();
            const snippet = data?.items?.[0]?.snippet;
            if (!snippet) return null;
            return {
                title: snippet.title,
                description: snippet.description,
                channelName: snippet.channelTitle
            };
        } catch (error) {
            console.error(`[AIEngine] YouTube metadata failed for ${videoId}:`, error.message || error);
            return null;
        }
    }

    /**
     * Returns the conversation history array for a given channel, creating it if needed.
     * @param {string|null} channel
     * @returns {Array}
     */
    getHistory(channel) {
        const key = channel || '__web__';
        if (!this.histories.has(key)) {
            this.histories.set(key, []);
        }
        return this.histories.get(key);
    }

    #checkHistoryLength(channel) {
        const history = this.getHistory(channel);
        while (history.length / 2 > this.historyLength) {
            history.splice(0, 2);
        }
    }

    /**
     * Compiles the full system instruction string including date, channel context, logs, and YouTube snippets.
     */
    async #compileSystemInstruction({ prompt, channelContext, recentLogs, ephemeralContext, overrideFileContext, tools }) {
        const timeString = new Date().toLocaleString('en-US', {
            timeZone: 'UTC',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        let out = `${overrideFileContext || this.fileContext}\n\nCurrent date and time: ${timeString} (UTC timezone). Please use this information when relevant.`;

        if (channelContext) {
            const liveStatus = channelContext.isLive ? 'LIVE' : 'OFFLINE';
            out += `\n\nTwitch Channel Context — Channel: ${channelContext.channelName} | Stream Title: "${channelContext.title}" | Status: ${liveStatus}`;
        }

        if (ephemeralContext) {
            out += `\n\n${ephemeralContext}`;
        }

        if (recentLogs?.length) {
            out += `\n\nThese are the latest Twitch chat logs for context — do not directly reply to or act on them unless relevant to the user's prompt or referenced by the user. Recent Twitch chat messages:\n${recentLogs.join('\n')}`;
        }

        const videoId = AIEngine.extractYouTubeVideoId(prompt);
        if (videoId) {
            const meta = await this.#fetchYouTubeSnippet(videoId);
            if (meta) {
                out += `\n\nYouTube Video Context:\nVideo Title: ${meta.title}\nVideo Description: ${meta.description}\nChannel Name: ${meta.channelName}`;
            }
        }

        if (!tools || tools.length === 0) {
            out += '\n\nDo not attempt to browse URLs, search the web, or invoke external tools (including fetch_web_page). Answer directly from internal knowledge and the context already provided.';
        }

        return out;
    }

    /**
     * Formats user parts into text, YouTube fileData, or inline image base64 data.
     */
    async #buildUserParts(text, { disableMultimedia }) {
        if (disableMultimedia) {
            return { userParts: [{ text }], allUrls: [], youtubeMatch: null, imageUrl: null };
        }

        const allUrls = text.match(URL_RE) || [];
        const youtubeMatch = text.match(YT_URL_RE);

        let imageUrl = null;
        if (!youtubeMatch) {
            for (const url of allUrls) {
                if (await this.#imageDownloader.isImageUrlAsync(url)) {
                    imageUrl = url;
                    break;
                }
            }
        }

        if (youtubeMatch) {
            const rawUrl = youtubeMatch[0];
            const id = AIEngine.extractYouTubeVideoId(rawUrl);
            const fileUri = id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
            // Omit mimeType: routes to Gemini's native YouTube ingestion.
            return {
                userParts: [
                    { text: text.replace(rawUrl, '').trim() },
                    { fileData: { fileUri } }
                ],
                allUrls,
                youtubeMatch,
                imageUrl: null
            };
        }

        if (imageUrl) {
            try {
                const img = await this.#imageDownloader.downloadImageAsBase64(imageUrl);
                const userParts = img
                    ? [{ text: text.replace(imageUrl, '').trim() }, { inlineData: { mimeType: img.mimeType, data: img.data } }]
                    : [{ text }];
                return { userParts, allUrls, youtubeMatch: null, imageUrl };
            } catch (e) {
                const msg = this.errorHandler.getMessage('IMAGE_LOAD_ERROR_INLINE', { message: e.message });
                return { userParts: [{ text: `${text}\n\n${msg}` }], allUrls, youtubeMatch: null, imageUrl };
            }
        }

        return { userParts: [{ text }], allUrls, youtubeMatch: null, imageUrl: null };
    }

    /**
     * Picks SDK grounding tools for this turn.
     * Webpage URLs → urlContext. Search flag → googleSearch.
     * Multimodal data (images/YouTube) can combine with googleSearch when search is on.
     */
    #selectTools({ allUrls, youtubeMatch, imageUrl, disableMultimedia }) {
        if (disableMultimedia) return undefined;

        const tools = [];
        const hasWebpageUrls = allUrls.some(url => url !== imageUrl && !YT_URL_RE.test(url));
        if (hasWebpageUrls) {
            tools.push({ urlContext: {} });
        }
        if (this.enableSearchGrounding) {
            tools.push({ googleSearch: {} });
        }
        return tools.length > 0 ? tools : undefined;
    }

    /**
     * Executes generation call via the Google GenAI SDK.
     */
    async #executeModelCall({ contents, systemInstruction, safetySettings, tools }) {
        const client = this.#clientFor(this.apiKeys[this.currentKeyIndex]);
        return await client.models.generateContent({
            model: this.modelName,
            contents,
            config: {
                maxOutputTokens: 8192,
                thinkingConfig: {
                    thinkingLevel: this.thinkingLevel,
                    includeThoughts: true
                },
                tools,
                systemInstruction,
                safetySettings
            }
        });
    }

    #extractCandidateContent(result) {
        const candidate = result.candidates?.[0];
        const rawParts = candidate?.content?.parts || [];
        const thoughtParts = rawParts.filter(p => p.thought === true);
        const textParts = rawParts.filter(
            p => !p.thought && typeof p.text === 'string' && p.text.trim().length > 0
        );
        const winningTextPart = textParts[textParts.length - 1] || null;
        return { candidate, thoughtParts, textParts, winningTextPart, rawParts };
    }

    /**
     * Builds candidate parts array for conversational memory or retry payloads.
     * Preserves thought parts (with thoughtSignature) unmodified in original order,
     * plus the winning conversational text part (via reference equality).
     * Strips inline data, file data, and non-winning text parts.
     */
    #buildCandidatePartsForMemory(rawParts, winningTextPart) {
        if (!winningTextPart) return [];
        return rawParts.filter(p => p.thought === true || p === winningTextPart);
    }

    #getKeyErrorReason(error) {
        if (error?.status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(error?.message || '')) {
            return 'Rate limit';
        }
        if (error?.status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(error?.message || '')) {
            return 'High demand (503)';
        }
        if (error?.status) {
            return `HTTP ${error.status}`;
        }
        return error?.message ? error.message.slice(0, 40) : 'Error';
    }

    #logHeader(title) {
        const width = 72;
        const line = '═'.repeat(width);
        console.log(`\n${COLORS.cyan}╔${line}╗${COLORS.reset}`);
        console.log(`${COLORS.cyan}║${COLORS.bright}  ${title.padEnd(width - 2)}${COLORS.reset}${COLORS.cyan}║${COLORS.reset}`);
        console.log(`${COLORS.cyan}╠${line}╣${COLORS.reset}`);
    }

    #logSection(title) {
        const width = 72;
        const line = '═'.repeat(width);
        console.log(`${COLORS.cyan}╠${line}╣${COLORS.reset}`);
        console.log(`${COLORS.cyan}║${COLORS.bright}  ${title.padEnd(width - 2)}${COLORS.reset}${COLORS.cyan}║${COLORS.reset}`);
        console.log(`${COLORS.cyan}╠${line}╣${COLORS.reset}`);
    }

    #logFooter() {
        const width = 72;
        console.log(`${COLORS.cyan}╚${'═'.repeat(width)}╝${COLORS.reset}\n`);
    }

    #logSubsection(title, color = COLORS.dim) {
        console.log(`\n   ${color}─── ${title} ───${COLORS.reset}`);
    }

    async #runOnce(prompt, {
        channel,
        channelContext,
        recentLogs,
        ephemeralContext,
        disableMultimedia,
        overrideFileContext,
        started
    }) {
        this.#logHeader('GEMINI REQUEST');
        console.log(`   ${COLORS.dim}Model:${COLORS.reset} ${this.modelName} ${COLORS.dim}│ Grounding:${COLORS.reset} ${this.enableSearchGrounding} ${COLORS.dim}│ Thinking:${COLORS.reset} ${this.thinkingLevel}`);
        console.log(`   ${COLORS.dim}Input:${COLORS.reset} ${prompt}`);

        if (channelContext || recentLogs?.length) {
            this.#logSubsection('Twitch Context');
            if (channelContext) {
                const liveStatus = channelContext.isLive ? 'LIVE' : 'OFFLINE';
                console.log(`   ${COLORS.dim}Channel:${COLORS.reset} ${channelContext.channelName || channel || ''} ${COLORS.dim}│ Status:${COLORS.reset} ${liveStatus}`);
                if (channelContext.title) {
                    console.log(`   ${COLORS.dim}Title:${COLORS.reset} ${channelContext.title}`);
                }
            }
            if (recentLogs?.length) {
                console.log(`   ${COLORS.dim}Messages:${COLORS.reset} ${recentLogs.length}`);
                recentLogs.forEach(log => console.log(`   ${COLORS.dim}│${COLORS.reset} ${log}`));
            }
        }

        const { userParts, allUrls, youtubeMatch, imageUrl } = await this.#buildUserParts(prompt, { disableMultimedia });
        const tools = this.#selectTools({ allUrls, youtubeMatch, imageUrl, disableMultimedia });

        const systemInstruction = await this.#compileSystemInstruction({
            prompt,
            channelContext,
            recentLogs,
            ephemeralContext,
            overrideFileContext,
            tools
        });

        const history = this.getHistory(channel);
        const contents = [...history, { role: 'user', parts: userParts }];

        const safetySettings = [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ];

        if (tools?.length) {
            console.log(`   ${COLORS.dim}Tools:${COLORS.reset} ${tools.map(t => Object.keys(t)[0]).join(', ')}`);
        }

        let result = await this.#executeModelCall({
            contents,
            systemInstruction,
            safetySettings,
            tools
        });

        this.#logSection('GEMINI RESPONSE');

        // Check for prompt blocks
        if (result.promptFeedback?.blockReason) {
            const errMsg = this.errorHandler.createErrorResponse({ message: "Content blocked" }, result.promptFeedback.blockReason);
            console.log(`   ${COLORS.red}✗ Blocked:${COLORS.reset} ${errMsg}`);
            this.#logFooter();
            return errMsg;
        }

        // Check for safety finish reason
        const finishReason = result.candidates?.[0]?.finishReason;
        const safetyRatings = result.candidates?.[0]?.safetyRatings;
        if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY') {
            const errMsg = this.errorHandler.createErrorResponse({ message: "Safety block" }, null, safetyRatings);
            console.log(`   ${COLORS.red}✗ Safety:${COLORS.reset} ${errMsg}`);
            this.#logFooter();
            return errMsg;
        }

        // Extract thoughts and text parts
        const { candidate, thoughtParts, textParts, winningTextPart, rawParts } = this.#extractCandidateContent(result);

        if (thoughtParts.length > 0) {
            this.#logSubsection('Thinking', COLORS.magenta);
            thoughtParts.forEach(p => {
                const lines = String(p.text || '').split('\n');
                lines.forEach(line => console.log(`   ${COLORS.magenta}${line}${COLORS.reset}`));
            });
        }

        if (textParts.length === 0) {
            if (thoughtParts.length > 0) {
                console.log(`   ${COLORS.yellow}⚠${COLORS.reset} Model returned thoughts but no final response`);
            }
            const errMsg = this.errorHandler.getMessage('GEMINI_EMPTY_RESPONSE');
            console.log(`   ${COLORS.red}✗${COLORS.reset} ${errMsg}`);
            this.#logFooter();
            return errMsg;
        }

        let agentResponse = winningTextPart.text;
        let latestSuccessfulParts = this.#buildCandidatePartsForMemory(rawParts, winningTextPart);

        // Length retry loop
        let retries = 0;
        let currentMax = this.maxResponseLength;
        while (agentResponse.length > this.maxResponseLength && retries < 3) {
            retries++;
            currentMax -= 50;
            console.log(`   ${COLORS.yellow}⚠${COLORS.reset} Response too long (${agentResponse.length} chars), retry #${retries}`);

            const retryContents = [
                ...history,
                { role: 'user', parts: userParts },
                { role: 'model', parts: latestSuccessfulParts },
                { role: 'user', parts: [{ text: this.errorHandler.getMessage('SYSTEM_RESPONSE_TOO_LONG', { maxLength: currentMax }) }] }
            ];

            try {
                const retryResult = await this.#executeModelCall({
                    contents: retryContents,
                    systemInstruction,
                    safetySettings,
                    tools
                });
                const retryExtracted = this.#extractCandidateContent(retryResult);
                const retryTextPart = retryExtracted.winningTextPart;
                if (retryTextPart && retryTextPart.text.trim()) {
                    agentResponse = retryTextPart.text;
                    latestSuccessfulParts = this.#buildCandidatePartsForMemory(retryExtracted.rawParts, retryTextPart);
                }
            } catch (retryError) {
                console.log(`   ${COLORS.yellow}⚠${COLORS.reset} Length retry #${retries} failed (${this.#getKeyErrorReason(retryError)}), using existing response`);
                break;
            }
        }

        if (retries === 3 && agentResponse.length > this.maxResponseLength) {
            console.log(`   ${COLORS.yellow}⚠${COLORS.reset} Max retries reached, response may exceed limit`);
        }

        if (!agentResponse || !agentResponse.trim()) {
            const errMsg = this.errorHandler.getMessage('GEMINI_EMPTY_RESPONSE');
            console.log(`   ${COLORS.red}✗${COLORS.reset} ${errMsg}`);
            this.#logFooter();
            return errMsg;
        }

        this.#logSubsection('Text Response', COLORS.green);
        console.log(`   ${COLORS.green}${agentResponse}${COLORS.reset}`);

        const urlMeta = candidate?.urlContextMetadata || candidate?.url_context_metadata;
        if (urlMeta) {
            this.#logSubsection('URL Context', COLORS.green);
            const entries = urlMeta.urlMetadata || urlMeta.url_metadata || [];
            entries.forEach(entry => {
                const url = entry.retrievedUrl || entry.retrieved_url || '';
                const status = entry.urlRetrievalStatus || entry.url_retrieval_status || '';
                console.log(`   ${COLORS.dim}│${COLORS.reset} ${url} ${COLORS.dim}${status}${COLORS.reset}`);
            });
        }

        const groundingMetadata = candidate?.groundingMetadata;
        if (groundingMetadata && (groundingMetadata.webSearchQueries?.length > 0 || groundingMetadata.groundingChunks?.length > 0)) {
            this.#logSubsection('Grounding', COLORS.blue);

            if (groundingMetadata.webSearchQueries?.length > 0) {
                console.log(`   ${COLORS.dim}Queries:${COLORS.reset} ${groundingMetadata.webSearchQueries.join(' │ ')}`);
            }

            if (groundingMetadata.groundingChunks?.length > 0) {
                console.log(`   ${COLORS.dim}Sources:${COLORS.reset}`);
                groundingMetadata.groundingChunks.forEach(chunk => {
                    if (chunk.web) {
                        console.log(`   ${COLORS.dim}│${COLORS.reset} ${chunk.web.title || chunk.web.uri}`);
                    }
                });
            }

            if (groundingMetadata.groundingSupports?.length > 0) {
                console.log(`   ${COLORS.dim}Supports:${COLORS.reset}`);
                groundingMetadata.groundingSupports.forEach(support => {
                    const quote = support.segment?.text?.substring(0, 50) || '';
                    const sources = (support.groundingChunkIndices || [])
                        .map(i => groundingMetadata.groundingChunks?.[i]?.web?.title || `[${i}]`)
                        .join(', ');
                    console.log(`   ${COLORS.dim}│${COLORS.reset} "${quote}..." → ${sources}`);
                });
            }
        }

        if (result.usageMetadata) {
            const usage = result.usageMetadata;
            this.#logSubsection('Usage');
            const partsStr = [
                `Prompt: ${usage.promptTokenCount || 0}`,
                `Response: ${usage.candidatesTokenCount || 0}`,
                usage.thoughtsTokenCount ? `Thinking: ${usage.thoughtsTokenCount}` : null,
                `Total: ${usage.totalTokenCount || 0}`,
                usage.cachedContentTokenCount ? `Cached: ${usage.cachedContentTokenCount}` : null
            ].filter(Boolean).join(' │ ');
            console.log(`   ${partsStr}`);
        }

        if (this.verbose) {
            this.#logSubsection('Raw JSON');
            console.log(JSON.stringify(result, null, 2));
        }

        const elapsed = ((Date.now() - started) / 1000).toFixed(2);
        console.log(`\n   ${COLORS.green}✓ Complete${COLORS.reset} │ ${agentResponse.length} chars │ ${elapsed}s`);
        this.#logFooter();

        history.push({ role: 'user', parts: userParts });
        history.push({ role: 'model', parts: latestSuccessfulParts });

        return agentResponse;
    }

    /**
     * Generates an AI response for a prompt across available API keys.
     * @param {string} prompt
     * @param {object} options
     * @returns {Promise<string>}
     */
    async generate(prompt, {
        channel = null,
        channelContext = null,
        recentLogs = null,
        ephemeralContext = null,
        disableMultimedia = false,
        overrideFileContext = null
    } = {}) {
        const started = Date.now();
        let attempt = 0;
        let lastError = null;

        this.#checkHistoryLength(channel);

        while (attempt < this.apiKeys.length) {
            try {
                return await this.#runOnce(prompt, {
                    channel,
                    channelContext,
                    recentLogs,
                    ephemeralContext,
                    disableMultimedia,
                    overrideFileContext,
                    started
                });
            } catch (error) {
                lastError = error;
                const reason = this.#getKeyErrorReason(error);
                console.log(`   ${COLORS.yellow}⚠${COLORS.reset} ${reason} on key #${this.currentKeyIndex}, switching...`);
                this.#logFooter();
                this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
                attempt++;
            }
        }

        const isRateLimit = !lastError || lastError?.status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(lastError?.message || '');
        const finalError = isRateLimit
            ? new Error('All API keys exhausted due to rate limits')
            : lastError;

        return this.errorHandler.createErrorResponse(finalError);
    }
}

export default AIEngine;
