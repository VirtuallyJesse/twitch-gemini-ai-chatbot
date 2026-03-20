// Lightweight Storage wrapper for Upstash Redis REST API
// Uses native fetch (Node 18+) to avoid adding heavy dependencies
export class Storage {
    constructor() {
        this.restUrl = null;
        this.token = null;
        this.configured = false;

        // 1. Try generic Redis connection string (from Render/User request)
        if (process.env.UPSTASH_REDIS_URL) {
            try {
                // Parse redis://default:token@host:port
                const url = new URL(process.env.UPSTASH_REDIS_URL);
                this.restUrl = `https://${url.hostname}`;
                this.token = url.password;
                this.configured = true;
            } catch (e) {
                console.error('[Storage] Failed to parse UPSTASH_REDIS_URL:', e.message);
            }
        }
        
        // 2. Override with explicit REST credentials if provided (Advanced)
        if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
            this.restUrl = process.env.UPSTASH_REDIS_REST_URL;
            this.token = process.env.UPSTASH_REDIS_REST_TOKEN;
            this.configured = true;
        }

        if (this.configured) {
            console.log(`[Storage] Connected to ${this.restUrl}`);
        } else {
            console.warn('[Storage] No Redis credentials found. Persistence disabled (Memory only).');
            // Fallbacks for memory-only mode
            this.memChat = {};
            this.memMedia = [];
        }
    }

    // Helper to send requests
    async request(endpoint, payload) {
        if (!this.configured) return null;
        try {
            const res = await fetch(`${this.restUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`Upstash ${res.status}: ${txt}`);
            }
            return await res.json();
        } catch (error) {
            console.error('[Storage] API Error:', error.message);
            return null;
        }
    }

    /**
     * Adds a chat message to the channel's log.
     * Trims list to 1000 items automatically.
     */
    async addChatMessage(channel, entry) {
        if (!this.configured) {
            if (!this.memChat[channel]) this.memChat[channel] = [];
            this.memChat[channel].push(entry);
            if (this.memChat[channel].length > 200) this.memChat[channel].shift();
            return;
        }

        const key = `chat:${channel.replace('#', '').toLowerCase()}`;
        const value = JSON.stringify(entry);

        // Use Pipeline: Push + Trim in one go
        await this.request('/pipeline', [
            ['RPUSH', key, value],
            ['LTRIM', key, -1000, -1] // Keep last 1000
        ]);
    }

    /**
     * Gets chat logs for a channel.
     */
    async getChatLog(channel, limit = 200) {
        if (!this.configured) {
            return (this.memChat[channel] || []).slice(-limit);
        }

        const key = `chat:${channel.replace('#', '').toLowerCase()}`;
        const data = await this.request('/', ['LRANGE', key, -limit, -1]);
        
        if (!data || !data.result) return [];
        
        return data.result.map(item => {
            try { return JSON.parse(item); } catch { return null; }
        }).filter(Boolean);
    }

    /**
     * Adds a generated media entry (Image/Video/Song).
     * Trims list to 500 items automatically.
     */
    async addMediaEntry(entry) {
        if (!this.configured) {
            this.memMedia.push(entry);
            if (this.memMedia.length > 500) this.memMedia.shift();
            return;
        }

        const key = 'media_log';
        const value = JSON.stringify(entry);

        await this.request('/pipeline', [
            ['RPUSH', key, value],
            ['LTRIM', key, -500, -1] // Keep last 500
        ]);
    }

    /**
     * Gets the media gallery.
     */
    async getMediaLog(limit = 500) {
        if (!this.configured) {
            return [...this.memMedia].reverse(); // newest first
        }

        const data = await this.request('/', ['LRANGE', 'media_log', -limit, -1]);

        if (!data || !data.result) return [];

        // Redis stores oldest->newest. We usually want newest first for the UI.
        const parsed = data.result.map(item => {
            try { return JSON.parse(item); } catch { return null; }
        }).filter(Boolean);

        return parsed.reverse();
    }

    /**
     * Persists OAuth tokens to Redis for survival across restarts.
     * @param {string} accessToken
     * @param {string} refreshToken
     * @param {number} expiration - Timestamp in ms when the access token expires.
     */
    async setTokens(accessToken, refreshToken, expiration) {
        if (!this.configured) return;

        const value = JSON.stringify({ accessToken, refreshToken, expiration });
        await this.request('/', ['SET', 'twitch:tokens', value]);
    }

    /**
     * Loads OAuth tokens from Redis.
     * @returns {Promise<{accessToken: string, refreshToken: string, expiration: number}|null>}
     */
    async getTokens() {
        if (!this.configured) return null;

        const data = await this.request('/', ['GET', 'twitch:tokens']);
        if (!data?.result) return null;

        try {
            return JSON.parse(data.result);
        } catch {
            return null;
        }
    }
}