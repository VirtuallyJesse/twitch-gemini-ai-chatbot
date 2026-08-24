export const MAX_TOOL_TURNS = 4;
export const DEFAULT_TOOL_TIMEOUT_MS = 3500;

const SEARCH_TOOL_NAMES = new Set(['search_web', 'web_search']);
const DEFAULT_SEARCH_NAME = 'search_web';
const DEFAULT_SEARCH_DESCRIPTION =
    'Search the web for real-time facts, current events, live stats, and breaking news.';
const DEFAULT_SEARCH_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The search query' }
    },
    required: ['query']
};
const TOOL_BUDGET_MESSAGE =
    'Tool calling budget exhausted. Answer now from the information already retrieved. Do not call any tools.';

export class ToolDispatcher {
    #tools;
    #searchProvider;
    #searchMode;
    #fetchImpl;
    #defaultTimeoutMs;
    #enableHelixActions;

    constructor({
        tools = [],
        searchProvider = null,
        searchMode = 'off',
        enableHelixActions = true,
        fetchImpl = (...a) => globalThis.fetch(...a),
        defaultTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS
    } = {}) {
        this.#tools = Array.isArray(tools) ? tools.filter(Boolean) : [];
        this.#searchProvider = searchProvider || null;
        this.#applySearchMode(searchMode);
        this.#enableHelixActions = enableHelixActions !== false;
        this.#fetchImpl = fetchImpl;
        this.#defaultTimeoutMs = Number(defaultTimeoutMs) > 0
            ? Number(defaultTimeoutMs)
            : DEFAULT_TOOL_TIMEOUT_MS;

        this.#validateToolDeclarations();
    }

    get searchMode() {
        return this.#searchMode;
    }

    get enableHelixActions() {
        return this.#enableHelixActions;
    }

    setEnableHelixActions(enabled) {
        this.#enableHelixActions = Boolean(enabled);
    }

    reloadSearchMode(searchMode, searchProvider = this.#searchProvider) {
        this.#searchProvider = searchProvider || null;
        this.#applySearchMode(searchMode);
        this.#validateToolDeclarations();
    }

    #applySearchMode(searchMode) {
        const normalized = searchMode === 'tavily' ? 'custom' : searchMode;
        this.#searchMode = normalized === 'google' || normalized === 'custom' ? normalized : 'off';
    }

    #validateToolDeclarations() {
        const seen = new Set();
        const customSearchName = this.#searchMode === 'custom' && this.#searchProvider
            ? (this.#searchProvider.name || DEFAULT_SEARCH_NAME)
            : null;

        if (customSearchName) {
            seen.add(customSearchName);
        }

        for (const tool of this.#tools) {
            if (!tool?.name || typeof tool.name !== 'string') {
                throw new Error('Tool declaration missing valid string name');
            }
            if (this.#searchMode === 'google' && SEARCH_TOOL_NAMES.has(tool.name)) {
                // In google mode, conflicting search tool names are stripped during compilation
                continue;
            }
            if (seen.has(tool.name)) {
                throw new Error(`Duplicate tool declaration name: "${tool.name}"`);
            }
            seen.add(tool.name);
        }
    }

    static resolveSearchMode({
        searchGrounding = null,
        enableSearchGrounding = false,
        searchProvider = null
    } = {}) {
        const explicit = String(searchGrounding || '').toLowerCase();
        if (explicit === 'tavily') {
            return searchProvider ? 'custom' : 'off';
        }
        if (explicit === 'google' || explicit === 'custom' || explicit === 'off') {
            if (explicit === 'custom' && !searchProvider) return 'off';
            return explicit;
        }
        if (searchProvider) return 'custom';
        if (enableSearchGrounding === true || enableSearchGrounding === 'true') return 'google';
        return 'off';
    }

    #allowedForCaller(tool, caller) {
        const tier = tool?.tokenTier;
        if (tier === 'broadcaster' || tier === 'moderator') {
            return !!(caller?.isBroadcaster || caller?.isMod);
        }
        return true;
    }

    compileTools({ hasWebpageUrls = false, disableMultimedia = false, caller } = {}) {
        if (disableMultimedia) return undefined;

        const compiled = [];
        if (hasWebpageUrls) compiled.push({ urlContext: {} });
        if (this.#searchMode === 'google') compiled.push({ googleSearch: {} });

        const declarations = this.#compileFunctionDeclarations(caller);
        if (declarations.length > 0) {
            compiled.push({ functionDeclarations: declarations });
        }
        return compiled.length > 0 ? compiled : undefined;
    }

    hasGoogleSearch(tools) {
        if (!Array.isArray(tools)) return false;
        return tools.some(t => Boolean(t && (t.googleSearch || t.google_search)));
    }

    withoutFunctionDeclarations(tools) {
        if (!tools?.length) return tools;
        const filtered = tools.filter(t => !t.functionDeclarations);
        return filtered.length > 0 ? filtered : undefined;
    }

    withoutGoogleSearch(tools) {
        if (!tools?.length) return tools;
        const filtered = tools.filter(t => !(t && (t.googleSearch || t.google_search)));
        return filtered.length > 0 ? filtered : undefined;
    }

    #compileFunctionDeclarations(caller) {
        const decls = [];
        const searchTool = this.#customSearchTool();
        if (searchTool) decls.push(this.#toDeclaration(searchTool));

        if (this.#enableHelixActions) {
            for (const tool of this.#tools) {
                if (!tool?.name) continue;
                if (this.#searchMode === 'google' && SEARCH_TOOL_NAMES.has(tool.name)) continue;
                if (searchTool && tool.name === searchTool.name) continue;
                if (!this.#allowedForCaller(tool, caller)) continue;
                decls.push(this.#toDeclaration(tool));
            }
        }
        return decls;
    }

    #customSearchTool() {
        if (this.#searchMode !== 'custom' || !this.#searchProvider) return null;
        const provider = this.#searchProvider;
        if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) {
            return null;
        }
        return {
            name: provider.name || DEFAULT_SEARCH_NAME,
            description: provider.description || DEFAULT_SEARCH_DESCRIPTION,
            parameters: provider.parameters || DEFAULT_SEARCH_PARAMETERS,
            timeoutMs: provider.timeoutMs,
            execute: async (args, context) => provider.search(args?.query, context)
        };
    }

    #toDeclaration(tool) {
        return {
            name: tool.name,
            description: tool.description || '',
            parametersJsonSchema: tool.parameters || { type: 'object', properties: {} }
        };
    }

    #lookupTool(name) {
        const searchTool = this.#customSearchTool();
        if (searchTool && searchTool.name === name) return searchTool;
        if (this.#searchMode === 'google' && SEARCH_TOOL_NAMES.has(name)) return null;
        return this.#tools.find(t => t.name === name) || null;
    }

    #extractFunctionCalls(result) {
        const parts = result?.candidates?.[0]?.content?.parts || [];
        const calls = [];
        for (const part of parts) {
            const fc = part.functionCall || part.function_call;
            if (fc && fc.name) {
                calls.push({
                    name: fc.name,
                    args: this.#normalizeArgs(fc.args ?? fc.arguments),
                    id: fc.id
                });
            }
        }
        return calls;
    }

    #normalizeArgs(args) {
        if (args == null) return {};
        if (typeof args === 'string') {
            try { return JSON.parse(args); } catch { return { raw: args }; }
        }
        return args;
    }

    #rawParts(result) {
        return result?.candidates?.[0]?.content?.parts || [];
    }

    async executeTurnLoop({
        contents,
        tools,
        invokeModel,
        context = {},
        maxTurns = MAX_TOOL_TURNS
    }) {
        const workingContents = [...contents];
        const limit = Math.max(1, parseInt(maxTurns, 10) || MAX_TOOL_TURNS);
        let result = null;
        let turnCount = 0;

        for (let turn = 0; turn < limit; turn++) {
            const isLast = turn === limit - 1;
            const turnTools = (isLast && turn > 0)
                ? this.withoutFunctionDeclarations(tools)
                : tools;

            // Force text synthesis on the last call of a multi-turn loop.
            if (isLast && turn > 0) {
                workingContents.push({
                    role: 'user',
                    parts: [{ text: TOOL_BUDGET_MESSAGE }]
                });
            }

            result = await invokeModel({ contents: workingContents, tools: turnTools });
            turnCount += 1;

            if (result?.promptFeedback?.blockReason) {
                return { result, turnCount, workingContents, stopped: 'blocked' };
            }
            const finishReason = result?.candidates?.[0]?.finishReason;
            if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY') {
                return { result, turnCount, workingContents, stopped: 'safety' };
            }

            const functionCalls = this.#extractFunctionCalls(result);
            if (functionCalls.length === 0) {
                return { result, turnCount, workingContents, stopped: 'text' };
            }
            if (isLast) {
                return { result, turnCount, workingContents, stopped: 'ceiling' };
            }

            const responseParts = await this.#dispatchFunctionCalls(functionCalls, context);
            const fatalPart = responseParts.find((p) => p?.functionResponse?.response?.fatal);
            if (fatalPart) {
                const response = fatalPart.functionResponse.response;
                return {
                    result,
                    turnCount,
                    workingContents,
                    stopped: 'error',
                    errorKey: response.errorKey || response.error
                };
            }

            // CRITICAL: push unmodified candidate parts so thought + thoughtSignature
            // + functionCall survive the next generateContent call.
            workingContents.push({ role: 'model', parts: this.#rawParts(result) });
            workingContents.push({
                role: 'user',
                parts: responseParts
            });
        }

        return { result, turnCount, workingContents, stopped: 'ceiling' };
    }

    async #dispatchFunctionCalls(functionCalls, context) {
        return Promise.all(functionCalls.map(fc => this.#executeOne(fc, context)));
    }

    async #executeOne(fc, context) {
        const tool = this.#lookupTool(fc.name);
        if (!tool) {
            return this.#functionResponse(fc, { error: `Unknown tool: ${fc.name}` });
        }
        if (!this.#allowedForCaller(tool, context?.caller)) {
            return this.#functionResponse(fc, { error: 'You do not have permission to use this tool.' });
        }

        const timeoutMs = Number(tool.timeoutMs) > 0 ? Number(tool.timeoutMs) : this.#defaultTimeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const payload = await Promise.race([
                Promise.resolve().then(() => tool.execute(fc.args, {
                    ...context,
                    fetchImpl: this.#fetchImpl,
                    signal: controller.signal
                })),
                this.#timeoutPromise(controller.signal, tool.name, timeoutMs)
            ]);
            return this.#safeFunctionResponse(fc, payload);
        } catch (err) {
            const timedOut = controller.signal.aborted;
            if (timedOut && tool.tokenTier) {
                return this.#functionResponse(fc, {
                    error: 'HELIX_ACTION_TIMEOUT',
                    errorKey: 'HELIX_ACTION_TIMEOUT',
                    fatal: true
                });
            }
            const message = timedOut
                ? `Tool ${tool.name} timed out after ${timeoutMs}ms`
                : (err?.message || String(err));
            return this.#functionResponse(fc, { error: message });
        } finally {
            clearTimeout(timer);
        }
    }

    #timeoutPromise(signal, name, timeoutMs) {
        return new Promise((_, reject) => {
            const fail = () => reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`));
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
        });
    }

    #safeFunctionResponse(fc, payload) {
        if (payload && typeof payload === 'object' && payload.error != null && !('output' in payload)) {
            const response = { error: String(payload.error) };
            if (payload.errorKey) response.errorKey = String(payload.errorKey);
            if (payload.fatal) response.fatal = true;
            return this.#functionResponse(fc, response);
        }
        const response = { output: payload ?? null };
        try {
            JSON.stringify(response);
        } catch {
            return this.#functionResponse(fc, { error: 'Tool result could not be serialized' });
        }
        return this.#functionResponse(fc, response);
    }

    #functionResponse(fc, response) {
        const body = { name: fc.name, response };
        if (fc.id) body.id = fc.id;
        return { functionResponse: body };
    }
}

export default ToolDispatcher;
