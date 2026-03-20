import { GoogleGenAI } from '@google/genai';
import { getChannelInfo } from '../twitch/apiClient.js';

// ANSI color codes for console output
const C = {
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

export class AIOperations {
    constructor(file_context, api_key, model_name, history_length, enable_search_grounding, youtube_api_key = null,
        imageProcessor = null, urlHandler = null, errorHandler = null, systemInstructionBuilder = null, bot = null) {
        this.modelName = model_name;
        this.apiKeys = api_key.split(',').map(k => k.trim()).filter(k => k);
        if (this.apiKeys.length === 0) {
            throw new Error('No API keys provided');
        }
        this.currentKeyIndex = 0;
        this.youtube_api_key = youtube_api_key;
        this.enable_search_grounding = enable_search_grounding;
        this.history_length = parseInt(history_length, 10) || 5;
        this.file_context = file_context;

        // Per-channel conversation history
        this.histories = new Map();

        // Dependency injection for helper modules
        this.imageProcessor = imageProcessor;
        this.urlHandler = urlHandler;
        this.errorHandler = errorHandler;
        this.systemInstructionBuilder = systemInstructionBuilder;
        this.bot = bot;
    }

    /**
     * Returns the conversation history array for a given channel, creating it if needed.
     * Web/non-channel callers get an isolated '__web__' history.
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

    /**
     * Determines if an error is a rate limit or quota exceeded error from the Gemini API.
     * @param {Error} error - The error object from the API call.
     * @returns {boolean} True if the error indicates rate limiting or quota exhaustion.
     */
    isRateLimitError(error) {
        return error.status === 429 ||
            (error.message && (
                error.message.includes('RESOURCE_EXHAUSTED') ||
                error.message.includes('quota exceeded') ||
                error.message.includes('rate limit')
            ));
    }

    check_history_length(channel) {
        const history = this.getHistory(channel);
        const conversationCount = (history.length / 2);
        if (conversationCount > this.history_length) {
            history.splice(0, 2);
        }
    }

    /**
     * Logs a formatted section header
     */
    logHeader(title) {
        const width = 72;
        const line = '═'.repeat(width);
        console.log(`\n${C.cyan}╔${line}╗${C.reset}`);
        console.log(`${C.cyan}║${C.bright}  ${title.padEnd(width - 2)}${C.reset}${C.cyan}║${C.reset}`);
        console.log(`${C.cyan}╠${line}╣${C.reset}`);
    }

    /**
     * Logs a section divider with title
     */
    logSection(title) {
        const width = 72;
        const line = '═'.repeat(width);
        console.log(`${C.cyan}╠${line}╣${C.reset}`);
        console.log(`${C.cyan}║${C.bright}  ${title.padEnd(width - 2)}${C.reset}${C.cyan}║${C.reset}`);
        console.log(`${C.cyan}╠${line}╣${C.reset}`);
    }

    /**
     * Logs a footer
     */
    logFooter() {
        const width = 72;
        console.log(`${C.cyan}╚${'═'.repeat(width)}╝${C.reset}\n`);
    }

    /**
     * Logs a subsection header
     */
    logSubsection(title, color = C.dim) {
        console.log(`\n   ${color}─── ${title} ───${C.reset}`);
    }

    async make_gemini_call(text, { disableMultimedia = false, overrideFileContext = null, channel = null, ephemeralContext = null, emoteHandler = null } = {}) {
        let attempt = 0;
        const maxAttempts = this.apiKeys.length;
        const requestStartTime = Date.now();

        while (attempt < maxAttempts) {
            try {
                const genAI = new GoogleGenAI({ apiKey: this.apiKeys[this.currentKeyIndex] });

                let filteredText = text;
                let emotesWereProcessed = false;

                if (emoteHandler) {
                    filteredText = emoteHandler.processEmotesForLogs(text);
                    emotesWereProcessed = filteredText.includes('emote:');
                }

                // ═══════════════════════════════════════════════════════════════
                // REQUEST LOGGING
                // ═══════════════════════════════════════════════════════════════
                this.logHeader('GEMINI REQUEST');
                console.log(`   ${C.dim}Model:${C.reset} ${this.modelName} ${C.dim}│ Grounding:${C.reset} ${this.enable_search_grounding}`);

                // Show input - only show filtered separately if there was a change
                if (emotesWereProcessed) {
                    console.log(`   ${C.dim}Original:${C.reset} ${text}`);
                    console.log(`   ${C.dim}Filtered:${C.reset} ${filteredText}`);
                } else {
                    console.log(`   ${C.dim}Input:${C.reset} ${text}`);
                }

                this.check_history_length(channel);

                // Fetch and process Twitch chat logs
                let twitchLogs = null;
                let channelContext = null;
                if (channel && this.bot) {
                    // Fetch channel context (title, live status)
                    const cleanChannel = channel.replace('#', '').toLowerCase();
                    const broadcasterId = this.bot.channelIdMap?.[cleanChannel];
                    if (broadcasterId) {
                        channelContext = await getChannelInfo(broadcasterId);
                    }

                    const logLength = parseInt(process.env.CHAT_CONTEXT_LENGTH, 10) || 10;
                    if (logLength > 0) {
                        const allCommandNames = [
                            ...(process.env.BOT_COMMAND_NAME || '!gemini').split(',').map(cmd => cmd.trim().toLowerCase()),
                            ...(process.env.IMAGE_COMMAND_NAME || '!image').split(',').map(cmd => cmd.trim().toLowerCase()),
                            ...(process.env.VIDEO_COMMAND_NAME || '!video').split(',').map(cmd => cmd.trim().toLowerCase()),
                            ...(process.env.TTS_COMMAND_NAME || '!tts').split(',').map(cmd => cmd.trim().toLowerCase()),
                            ...(process.env.MUSIC_COMMAND_NAME || '!song').split(',').map(cmd => cmd.trim().toLowerCase())
                        ];

                        const rawLogs = this.bot.getRecentMessages(channel, logLength, allCommandNames);

                        if (rawLogs.length > 0 && emoteHandler) {
                            twitchLogs = rawLogs.map(log => emoteHandler.processEmotesForLogs(log));

                            // Consolidated Twitch context logging
                            this.logSubsection('Twitch Context');
                            const liveStatus = channelContext?.isLive ? 'LIVE' : 'OFFLINE';
                            console.log(`   ${C.dim}Channel:${C.reset} ${channel} ${C.dim}│ Status:${C.reset} ${liveStatus} ${C.dim}│ Messages:${C.reset} ${twitchLogs.length}`);
                            if (channelContext?.title) {
                                console.log(`   ${C.dim}Title:${C.reset} ${channelContext.title}`);
                            }
                            twitchLogs.forEach(log => console.log(`   ${C.dim}│${C.reset} ${log}`));
                        }
                    }
                }

                // Build system instruction
                const systemInstruction = this.systemInstructionBuilder ?
                    await this.systemInstructionBuilder.buildSystemInstruction(
                        this.file_context, ephemeralContext, overrideFileContext, filteredText, this.youtube_api_key, twitchLogs, channelContext
                    ) : '';

                // Parse URLs once for both multimedia handling and tool selection
                const youtubeRegex = /(https?:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)[\w-]+|https?:\/\/youtu\.be\/[\w-]+)/;
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                const allUrls = disableMultimedia ? [] : (filteredText.match(urlRegex) || []);
                const youtubeMatch = disableMultimedia ? null : filteredText.match(youtubeRegex);

                let imageUrl = null;
                if (!disableMultimedia && this.imageProcessor) {
                    for (const url of allUrls) {
                        if (await this.imageProcessor.isImageUrlAsync(url)) {
                            imageUrl = url;
                            break;
                        }
                    }
                }

                let userParts = [];
                if (disableMultimedia) {
                    userParts = [{ text: filteredText }];
                } else if (youtubeMatch) {
                    const rawUrl = youtubeMatch[0];
                    const textPrompt = filteredText.replace(rawUrl, '').trim();
                    
                    let normalizedUrl = rawUrl;
                    if (this.urlHandler) {
                        const videoId = this.urlHandler.extractYouTubeVideoId(rawUrl);
                        if (videoId) {
                            normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
                        }
                    }
                    
                    // Omit mimeType so the Gemini API routes this to the native YouTube integration
                    // rather than treating it as a raw MP4 download attempt.
                    userParts = [{ text: textPrompt }, { fileData: { fileUri: normalizedUrl } }];
                } else if (imageUrl) {
                    try {
                        const textPrompt = filteredText.replace(imageUrl, '').trim();
                        const imageData = await this.imageProcessor.downloadImageAsBase64(imageUrl);
                        if (imageData) {
                            userParts = [{ text: textPrompt }, { inlineData: { mimeType: imageData.mimeType, data: imageData.data } }];
                        } else {
                            userParts = [{ text: filteredText }];
                        }
                    } catch (imageError) {
                        const errorMessage = this.errorHandler.getMessage('IMAGE_LOAD_ERROR_INLINE', { message: imageError.message });
                        userParts = [{ text: `${filteredText}\n\n${errorMessage}` }];
                    }
                } else {
                    userParts = [{ text: filteredText }];
                }

                const history = this.getHistory(channel);
                const contents = [...history, { role: 'user', parts: userParts }];

                const generationConfig = {
                    maxOutputTokens: 8192,
                    temperature: 0.9,
                    topK: 40,
                    topP: 0.95,
                };

                const safetySettings = [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                ];

                let tools = [];
                let useRestForUrlContext = false;
                if (this.enable_search_grounding === 'true' && !disableMultimedia) {
                    const isWebpageUrl = allUrls.length > 0 && !youtubeMatch && !imageUrl;
                    if (isWebpageUrl) {
                        console.log(`   ${C.dim}Tools:${C.reset} urlContext`);
                        useRestForUrlContext = true;
                    } else if (!imageUrl && !youtubeMatch) {
                        console.log(`   ${C.dim}Tools:${C.reset} googleSearch`);
                        tools.push({ googleSearch: {} });
                    }
                }

                let result;
                let parts = [];

                if (useRestForUrlContext) {
                    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent?key=${this.apiKeys[this.currentKeyIndex]}`;
                    const body = {
                        contents,
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        tools: [{ url_context: {} }],
                        generationConfig,
                        safetySettings
                    };
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
                    }
                    result = await response.json();
                } else {
                    let config = {
                        generationConfig,
                        safetySettings,
                        tools: tools.length > 0 ? tools : undefined,
                        thinkingConfig: {
                            thinkingBudget: 24576,
                            includeThoughts: true
                        },
                    };

                    config.systemInstruction = systemInstruction;

                    const generateParams = {
                        model: this.modelName,
                        contents,
                        config
                    };

                    result = await genAI.models.generateContent(generateParams);
                }

                // ═══════════════════════════════════════════════════════════════
                // RESPONSE LOGGING - Parsed sections FIRST, then raw JSON
                // ═══════════════════════════════════════════════════════════════
                this.logSection('GEMINI RESPONSE');

                // Check for blocks first
                if (result.promptFeedback?.blockReason) {
                    const errMsg = this.errorHandler.createErrorResponse({ message: "Content blocked" }, result.promptFeedback.blockReason);
                    console.log(`   ${C.red}✗ Blocked:${C.reset} ${errMsg}`);
                    this.logFooter();
                    return errMsg;
                }

                const finishReason = result.candidates?.[0]?.finishReason;
                const safetyRatings = result.candidates?.[0]?.safetyRatings;
                if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY') {
                    const errMsg = this.errorHandler.createErrorResponse({ message: "Safety block" }, null, safetyRatings);
                    console.log(`   ${C.red}✗ Safety:${C.reset} ${errMsg}`);
                    this.logFooter();
                    return errMsg;
                }

                // Get all parts
                const rawParts = result.candidates?.[0]?.content?.parts || [];

                // Extract thoughts and response parts
                const thoughtParts = rawParts.filter(p => p.thought === true);
                parts = rawParts.filter(p => !p.thought);

                // 1. THINKING (if present)
                if (thoughtParts.length > 0) {
                    this.logSubsection('Thinking', C.magenta);
                    thoughtParts.forEach(p => {
                        const lines = p.text.split('\n');
                        lines.forEach(line => console.log(`   ${C.magenta}${line}${C.reset}`));
                    });
                }

                // Handle empty response
                if (parts.length === 0) {
                    if (thoughtParts.length > 0) {
                        console.log(`   ${C.yellow}⚠${C.reset} Model returned thoughts but no final response`);
                    }
                    const errMsg = this.errorHandler.getMessage('GEMINI_EMPTY_RESPONSE');
                    console.log(`   ${C.red}✗${C.reset} ${errMsg}`);
                    this.logFooter();
                    return errMsg;
                }

                // Process response
                let agent_response = parts[parts.length - 1].text || "";

                // Retry logic for too-long responses
                let retry_count = 0;
                const MAX_RETRIES = 3;
                const MAX_ACCEPTABLE_RESPONSE_LENGTH = parseInt(process.env.GEMINI_MAX_RESPONSE_LENGTH, 10) || 450;
                let currentMaxLength = MAX_ACCEPTABLE_RESPONSE_LENGTH;

                while (agent_response.length > MAX_ACCEPTABLE_RESPONSE_LENGTH && retry_count < MAX_RETRIES) {
                    retry_count++;
                    console.log(`   ${C.yellow}⚠${C.reset} Response too long (${agent_response.length} chars), retry #${retry_count}`);

                    currentMaxLength -= 50;

                    const last_user_request = { role: 'user', parts: userParts };
                    const last_model_response = { role: 'model', parts: [{ text: agent_response }] };
                    const retryMessage = this.errorHandler.getMessage('SYSTEM_RESPONSE_TOO_LONG', { maxLength: currentMaxLength });
                    const system_instruction = { role: 'user', parts: [{ text: retryMessage }] };

                    const retryContents = [...history, last_user_request, last_model_response, system_instruction];

                    const generateParams = {
                        model: this.modelName,
                        contents: retryContents,
                        config: {
                            generationConfig,
                            safetySettings,
                            tools: tools.length > 0 ? tools : undefined,
                            thinkingConfig: {
                                thinkingBudget: 24576
                            },
                            systemInstruction: systemInstruction,
                        }
                    };

                    const retryResult = await genAI.models.generateContent(generateParams);
                    const retry_agent_response = retryResult.candidates?.[0]?.content?.parts?.[0]?.text || "";

                    if (retry_agent_response.trim()) {
                        agent_response = retry_agent_response;
                        parts = [{ text: agent_response }];
                    }
                }

                if (retry_count === MAX_RETRIES && agent_response.length > MAX_ACCEPTABLE_RESPONSE_LENGTH) {
                    console.log(`   ${C.yellow}⚠${C.reset} Max retries reached, response may exceed limit`);
                }

                // CRITICAL FIX FOR BLANK RESPONSE BUG
                const finalAgentTextPart = parts[parts.length - 1]?.text;
                if (typeof finalAgentTextPart === 'string') {
                    agent_response = finalAgentTextPart;
                } else {
                    console.log(`   ${C.yellow}⚠${C.reset} Final part not text, joining all text parts`);
                    agent_response = parts.filter(p => p.text).map(p => p.text).join(' ');
                }

                if (!agent_response || !agent_response.trim()) {
                    const errMsg = this.errorHandler.getMessage('GEMINI_EMPTY_RESPONSE');
                    console.log(`   ${C.red}✗${C.reset} ${errMsg}`);
                    this.logFooter();
                    return errMsg;
                }

                // 2. TEXT RESPONSE
                this.logSubsection('Text Response', C.green);
                console.log(`   ${C.green}${agent_response}${C.reset}`);

                // 3. GROUNDING (if present)
                const groundingMetadata = result.candidates?.[0]?.groundingMetadata;
                if (groundingMetadata && (groundingMetadata.webSearchQueries?.length > 0 || groundingMetadata.groundingChunks?.length > 0)) {
                    this.logSubsection('Grounding', C.blue);

                    if (groundingMetadata.webSearchQueries?.length > 0) {
                        console.log(`   ${C.dim}Queries:${C.reset} ${groundingMetadata.webSearchQueries.join(' │ ')}`);
                    }

                    if (groundingMetadata.groundingChunks?.length > 0) {
                        console.log(`   ${C.dim}Sources:${C.reset}`);
                        groundingMetadata.groundingChunks.forEach(chunk => {
                            if (chunk.web) {
                                console.log(`   ${C.dim}│${C.reset} ${chunk.web.title || chunk.web.uri}`);
                            }
                        });
                    }

                    if (groundingMetadata.groundingSupports?.length > 0) {
                        console.log(`   ${C.dim}Supports:${C.reset}`);
                        groundingMetadata.groundingSupports.forEach(support => {
                            const quote = support.segment?.text?.substring(0, 50) || '';
                            const sources = (support.groundingChunkIndices || [])
                                .map(i => groundingMetadata.groundingChunks?.[i]?.web?.title || `[${i}]`)
                                .join(', ');
                            console.log(`   ${C.dim}│${C.reset} "${quote}..." → ${sources}`);
                        });
                    }
                }

                // Check URL context
                const candidate = result.candidates?.[0];
                if (candidate?.urlContextMetadata || candidate?.url_context_metadata) {
                    console.log(`   ${C.green}✓${C.reset} URL Context was used`);
                } else if (useRestForUrlContext) {
                    console.log(`   ${C.yellow}⚠${C.reset} URL Context was NOT used despite being configured`);
                }

                // 4. TOKEN USAGE
                const usage = result.usageMetadata;
                if (usage) {
                    this.logSubsection('Usage');
                    const parts_str = [
                        `Prompt: ${usage.promptTokenCount || 0}`,
                        `Response: ${usage.candidatesTokenCount || 0}`,
                        usage.thoughtsTokenCount ? `Thinking: ${usage.thoughtsTokenCount}` : null,
                        `Total: ${usage.totalTokenCount || 0}`,
                        usage.cachedContentTokenCount ? `Cached: ${usage.cachedContentTokenCount}` : null
                    ].filter(Boolean).join(' │ ');
                    console.log(`   ${parts_str}`);
                }

                // 5. RAW JSON (at the end for debugging)
                this.logSubsection('Raw JSON');
                console.log(JSON.stringify(result, null, 2));

                // Final summary
                const elapsed = ((Date.now() - requestStartTime) / 1000).toFixed(2);
                console.log(`\n   ${C.green}✓ Complete${C.reset} │ ${agent_response.length} chars │ ${elapsed}s`);
                this.logFooter();

                history.push({ role: "user", parts: userParts });

                const sanitizedModelParts = parts.map(p => {
                    if (p.inlineData) {
                        return { text: "[image output]" };
                    }
                    return p;
                });
                history.push({ role: "model", parts: sanitizedModelParts });

                // Sanitize the final response to remove "emote:" prefixes and add proper spacing
                if (emoteHandler) {
                    agent_response = emoteHandler.processResponse(
                        agent_response,
                        false, // isImageGen
                        emotesWereProcessed || agent_response.includes('emote:')
                    );
                }

                return agent_response;

            } catch (error) {
                if (this.isRateLimitError(error)) {
                    console.log(`   ${C.yellow}⚠${C.reset} Rate limit on key #${this.currentKeyIndex}, switching...`);
                    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
                    attempt++;
                    if (attempt >= maxAttempts) {
                        console.log(`   ${C.red}✗${C.reset} All API keys exhausted`);
                        this.logFooter();
                        return this.errorHandler.createErrorResponse(new Error('All API keys exhausted due to rate limits'));
                    }
                    continue;
                } else {
                    this.logSubsection('ERROR', C.red);
                    console.log(`   ${C.red}${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}${C.reset}`);

                    const errMsg = this.errorHandler.createErrorResponse(error);
                    this.logFooter();
                    return errMsg;
                }
            }
        }

        this.logFooter();
        return this.errorHandler.createErrorResponse(new Error('Max attempts reached'));
    }
}