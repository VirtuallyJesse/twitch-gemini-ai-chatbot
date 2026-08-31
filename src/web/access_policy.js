import {
    COOKIE_NAME,
    parseCookies,
    verifySessionToken
} from './session.js';

const ADMIN_PINS_KEY = 'web:admin-identity-pins:v1';
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

function normalizeLogin(value) {
    const login = String(value || '').trim().replace(/^@/, '').toLowerCase();
    return TWITCH_LOGIN.test(login) ? login : '';
}

export class AdminIdentityPolicy {
    #storage;
    #resolveUsers;
    #configuredLogins;
    #pins = new Map();
    #adminIds = new Set();
    #logger;

    constructor({
        storage,
        adminUsernames = [],
        botUsername = '',
        resolveUsers,
        initialPins = {},
        logger = console
    } = {}) {
        this.#storage = storage;
        this.#resolveUsers = resolveUsers;
        this.#logger = logger;
        this.#configuredLogins = [...new Set([
            normalizeLogin(botUsername),
            ...(adminUsernames || []).map(normalizeLogin)
        ].filter(Boolean))];
        for (const [login, userId] of Object.entries(initialPins || {})) {
            const normalized = normalizeLogin(login);
            const id = String(userId || '').trim();
            if (normalized && id) this.#pins.set(normalized, id);
        }
        this.#refreshAdminIds();
    }

    async initialize() {
        if (this.#storage?.getJson) {
            try {
                const stored = await this.#storage.getJson(ADMIN_PINS_KEY);
                for (const [login, userId] of Object.entries(stored || {})) {
                    const normalized = normalizeLogin(login);
                    const id = String(userId || '').trim();
                    if (normalized && id && !this.#pins.has(normalized)) this.#pins.set(normalized, id);
                }
            } catch (error) {
                this.#logger.warn?.('[WebSecurity] Could not load administrator identity pins:', error?.message || error);
            }
        }

        const unresolved = this.#configuredLogins.filter((login) => !this.#pins.has(login));
        if (unresolved.length > 0 && typeof this.#resolveUsers === 'function') {
            try {
                const resolved = await this.#resolveUsers(unresolved);
                for (const login of unresolved) {
                    const id = String(resolved?.[login] || '').trim();
                    if (id) this.#pins.set(login, id);
                }
            } catch (error) {
                this.#logger.warn?.('[WebSecurity] Could not resolve one or more administrator identities:', error?.message || error);
            }
        }

        this.#refreshAdminIds();
        if (this.#storage?.setJson && this.#storage?.isPersistent) {
            try {
                await this.#storage.setJson(ADMIN_PINS_KEY, Object.fromEntries(this.#pins));
            } catch (error) {
                this.#logger.warn?.('[WebSecurity] Could not persist administrator identity pins:', error?.message || error);
            }
        } else if (this.#configuredLogins.length > 0) {
            this.#logger.warn?.('[WebSecurity] Administrator Twitch ID pins are process-local because persistent storage is disabled.');
        }

        const failed = unresolved.filter((login) => !this.#pins.has(login));
        if (failed.length > 0) {
            this.#logger.warn?.(`[WebSecurity] Administrator identities failed closed because Twitch IDs could not be resolved: ${failed.join(', ')}`);
        }
        return this;
    }

    #refreshAdminIds() {
        this.#adminIds = new Set(
            this.#configuredLogins
                .map((login) => this.#pins.get(login))
                .filter(Boolean)
        );
    }

    isAdminId(userId) {
        const id = String(userId || '').trim();
        return Boolean(id && this.#adminIds.has(id));
    }

    snapshot() {
        return {
            configuredLogins: [...this.#configuredLogins],
            pins: Object.fromEntries(this.#pins),
            adminIds: [...this.#adminIds]
        };
    }
}

export class WebAccessPolicy {
    #sessionSecret;
    #adminIdentities;
    #isDevMock;

    constructor({ sessionSecret, adminIdentities, isDevMock = false } = {}) {
        if (!sessionSecret) throw new Error('WebAccessPolicy requires session signing material.');
        if (!adminIdentities) throw new Error('WebAccessPolicy requires administrator identities.');
        this.#sessionSecret = sessionSecret;
        this.#adminIdentities = adminIdentities;
        this.#isDevMock = Boolean(isDevMock);
    }

    viewer(req) {
        const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
        const payload = verifySessionToken(token, this.#sessionSecret);
        if (!payload) {
            if (this.#isDevMock) {
                return {
                    login: 'jesse',
                    userId: 'dev_admin_1',
                    displayName: 'Jesse',
                    profileImageUrl: '/media/avatar.jpg',
                    isAdmin: true
                };
            }
            return null;
        }
        return { ...payload, isAdmin: this.#adminIdentities.isAdminId(payload.userId) };
    }

    requireAuthenticated(req, res) {
        const viewer = this.viewer(req);
        if (!viewer) {
            res.status(401).json({ error: 'unauthorized' });
            return null;
        }
        return viewer;
    }

    requireAdmin(req, res) {
        const viewer = this.requireAuthenticated(req, res);
        if (!viewer) return null;
        if (!viewer.isAdmin) {
            res.status(403).json({ error: 'forbidden' });
            return null;
        }
        return viewer;
    }
}

export function twitchUserResolver(transport) {
    return async (logins) => {
        const normalized = [...new Set((logins || []).map(normalizeLogin).filter(Boolean))];
        if (normalized.length === 0) return {};
        if (typeof transport?.helix?.resolveUserIds === 'function') {
            return transport.helix.resolveUserIds(normalized, { useAppToken: true });
        }
        if (typeof transport?.helix?.request !== 'function') return {};
        const response = await transport.helix.request('/users', {
            query: { login: normalized },
            useAppToken: true
        });
        return Object.fromEntries((response?.data || []).flatMap((user) => {
            const login = normalizeLogin(user?.login);
            const id = String(user?.id || '').trim();
            return login && id ? [[login, id]] : [];
        }));
    };
}
