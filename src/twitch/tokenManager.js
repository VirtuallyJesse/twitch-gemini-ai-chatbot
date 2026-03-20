import dotenv from 'dotenv';
dotenv.config();

// --- User Access Token state ---
let accessToken = null;
let refreshToken = null;
let tokenExpiration = 0;
let refreshPromise = null;

// --- App Access Token state ---
let appToken = null;
let appTokenExpiration = 0;

let storage = null;

function requireClientCredentials() {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required.');
    }
}

/**
 * Initialize the token manager with a persistent storage backend.
 * Must be called before any token operations.
 * @param {Object} storageInstance - Storage instance with getTokens/setTokens methods.
 */
export function initTokenManager(storageInstance) {
    storage = storageInstance;
}

/**
 * Load tokens from Redis or TWITCH_REFRESH_TOKEN env var.
 * Immediately validates by performing a refresh.
 * @returns {Promise<boolean>} True if a valid token was obtained.
 */
export async function loadTokens() {
    // Try Redis first
    if (storage?.configured) {
        try {
            const stored = await storage.getTokens();
            if (stored?.refreshToken) {
                console.log('[TokenManager] Loaded refresh token from Redis');
                refreshToken = stored.refreshToken;
                try {
                    await refreshAccessToken();
                    return true;
                } catch (err) {
                    console.error('[TokenManager] Stored refresh token is invalid:', err.message);
                    refreshToken = null;
                }
            }
        } catch (err) {
            console.error('[TokenManager] Failed to load tokens from Redis:', err.message);
        }
    }

    // Fallback: bootstrap from env var
    if (process.env.TWITCH_REFRESH_TOKEN) {
        console.log('[TokenManager] Bootstrapping from TWITCH_REFRESH_TOKEN env var');
        refreshToken = process.env.TWITCH_REFRESH_TOKEN;
        try {
            await refreshAccessToken();
            return true;
        } catch (err) {
            console.error('[TokenManager] Env var refresh token is invalid:', err.message);
            refreshToken = null;
            return false;
        }
    }

    console.log('[TokenManager] No tokens found. Authorization required via /auth/setup');
    return false;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Called from the /auth/callback Express route.
 * @param {string} code - Authorization code from Twitch redirect.
 * @param {string} redirectUri - The redirect URI used in the auth request.
 * @param {string} [expectedUsername] - Optional: validate the token belongs to this username.
 * @returns {Promise<Object>} Full token response from Twitch.
 */
export async function exchangeCodeForTokens(code, redirectUri, expectedUsername) {
    requireClientCredentials();

    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
    });

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: params
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
    }

    // Validate that the authorized account matches the expected bot username
    if (expectedUsername) {
        const validateResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': `OAuth ${data.access_token}` }
        });

        if (!validateResponse.ok) {
            throw new Error('Failed to validate the received access token.');
        }

        const validateData = await validateResponse.json();
        const authorizedLogin = (validateData.login || '').toLowerCase();
        const expected = expectedUsername.toLowerCase();

        if (authorizedLogin !== expected) {
            // Revoke the token immediately — don't leave a dangling authorization
            await fetch(`https://id.twitch.tv/oauth2/revoke?client_id=${process.env.TWITCH_CLIENT_ID}&token=${data.access_token}`, {
                method: 'POST'
            }).catch(() => {});

            throw new Error(
                `Authorization rejected: expected bot account "${expected}" but got "${authorizedLogin}". ` +
                `Please log into the correct Twitch account and try again.`
            );
        }

        console.log(`[TokenManager] Verified token belongs to: ${authorizedLogin}`);
    }

    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    tokenExpiration = Date.now() + (data.expires_in * 1000);

    await persistTokens();
    console.log('[TokenManager] Authorization complete. Tokens stored.');

    return data;
}

/**
 * Get a valid user access token, refreshing automatically if expired.
 * Used for IRC auth and user-scoped Helix calls.
 * @returns {Promise<string>} A valid user access token.
 */
export async function getUserToken() {
    if (!refreshToken) {
        throw new Error('Not authorized. Visit /auth/setup to connect the bot Twitch account.');
    }

    // Return cached token if still valid (5-minute buffer)
    if (accessToken && Date.now() < tokenExpiration - 300000) {
        return accessToken;
    }

    return refreshAccessToken();
}

/**
 * Get a valid app access token via client credentials grant.
 * Used specifically for sendChatMessage to preserve bot badge behavior.
 * @returns {Promise<string>} A valid app access token.
 */
export async function getAppToken() {
    if (appToken && Date.now() < appTokenExpiration - 300000) {
        return appToken;
    }

    requireClientCredentials();
    console.log('[TokenManager] Fetching App Access Token...');

    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
    });

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: params
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`Failed to get app token: ${JSON.stringify(data)}`);
    }

    appToken = data.access_token;
    appTokenExpiration = Date.now() + (data.expires_in * 1000);

    return appToken;
}

/**
 * Check whether the bot has been authorized (has a refresh token).
 * @returns {boolean}
 */
export function isAuthorized() {
    return !!refreshToken;
}

/**
 * Force a user token refresh. Called reactively when a 401 is received.
 * @returns {Promise<string>} The new access token.
 */
export async function forceRefresh() {
    tokenExpiration = 0;
    return refreshAccessToken();
}

/**
 * Invalidate the cached app token so the next getAppToken() call fetches a new one.
 */
export function invalidateAppToken() {
    appToken = null;
    appTokenExpiration = 0;
}

/**
 * Refresh the user access token using the stored refresh token.
 * Serialized: concurrent callers share a single in-flight request.
 * @returns {Promise<string>} The new access token.
 */
async function refreshAccessToken() {
    // If a refresh is already in-flight, piggyback on it
    if (refreshPromise) {
        return refreshPromise;
    }

    refreshPromise = (async () => {
        try {
            requireClientCredentials();
            console.log('[TokenManager] Refreshing user access token...');

            const params = new URLSearchParams({
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            });

            const response = await fetch('https://id.twitch.tv/oauth2/token', {
                method: 'POST',
                body: params
            });

            const data = await response.json();

            if (!response.ok) {
                accessToken = null;
                refreshToken = null;
                tokenExpiration = 0;
                throw new Error(data.message || `Refresh failed: ${JSON.stringify(data)}`);
            }

            accessToken = data.access_token;
            refreshToken = data.refresh_token; // Twitch may rotate refresh tokens
            tokenExpiration = Date.now() + (data.expires_in * 1000);

            console.log(`[TokenManager] User token refreshed (expires in ${data.expires_in}s)`);
            await persistTokens();

            return accessToken;
        } finally {
            refreshPromise = null;
        }
    })();

    return refreshPromise;
}

/**
 * Persist current tokens to Redis for survival across restarts.
 */
async function persistTokens() {
    if (!storage?.configured) return;

    try {
        await storage.setTokens(accessToken, refreshToken, tokenExpiration);
    } catch (err) {
        console.error('[TokenManager] Failed to persist tokens to Redis:', err.message);
    }
}