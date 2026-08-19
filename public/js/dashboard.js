// public/js/dashboard.js
// Root dashboard bootstrap entry point exposing Dashboard.mount() and DashboardSession.

import { ApiClient } from './runtime/api_client.js';
import { DashboardRuntime } from './runtime/dashboard_runtime.js';
import { ChatView } from './views/chat_view.js';
import { GalleryView } from './views/gallery_view.js';
import { ConfigModalView } from './views/config/config_modal.js';

export class Dashboard {
    /**
     * Mounts the modular dashboard onto the specified root element or document.
     * @param {HTMLElement | Document} [rootElement=document]
     * @param {Object} [options]
     * @param {ApiClient} [options.apiClient]
     * @param {DashboardRuntime} [options.runtime]
     * @param {Object} [options.viewer]
     * @returns {DashboardSession}
     */
    static mount(rootElement = (typeof document !== 'undefined' ? document : null), options = {}) {
        const root = rootElement || (typeof document !== 'undefined' ? document : null);
        const apiClient = options.apiClient || new ApiClient(options);
        const runtime = options.runtime || new DashboardRuntime({
            apiClient,
            viewer: options.viewer,
            ...options
        });

        const chatView = new ChatView();
        const galleryView = new GalleryView();
        const configModalView = new ConfigModalView();

        const chatContainer = root?.querySelector?.('.panel.left-panel') || root;
        const galleryContainer = root?.querySelector?.('.panel.right-panel') || root;
        const modalContainer = root?.querySelector?.('#config-modal') || root;

        // Context passed to views
        const viewContext = {
            runtime,
            apiClient,
            onOpenConfig: () => configModalView.open()
        };

        if (chatContainer) {
            chatView.mount(chatContainer, viewContext);
        }

        if (galleryContainer) {
            galleryView.mount(galleryContainer, viewContext);
        }

        if (modalContainer) {
            configModalView.mount(modalContainer, viewContext);
        }

        // Start runtime bootstrap
        runtime.start().catch((err) => {
            console.error('[Dashboard] Failed to start runtime:', err);
        });

        return new DashboardSession({
            runtime,
            apiClient,
            views: {
                chat: chatView,
                gallery: galleryView,
                configModal: configModalView
            }
        });
    }
}

export class DashboardSession {
    /**
     * @param {Object} params
     * @param {DashboardRuntime} params.runtime
     * @param {ApiClient} params.apiClient
     * @param {Object} params.views
     */
    constructor({ runtime, apiClient, views }) {
        this.runtime = runtime;
        this.apiClient = apiClient;
        this.views = views;
    }

    get status() {
        return this.runtime ? this.runtime.status : 'idle';
    }

    /**
     * Synchronizes state across the dashboard.
     * @param {'all' | 'config' | 'media' | 'emotes'} [scope='all']
     */
    async sync(scope = 'all') {
        if (this.runtime) {
            await this.runtime.sync(scope);
        }
    }

    /**
     * Destroys the session, unmounting views and closing network connections.
     */
    async destroy() {
        if (this.views) {
            this.views.chat?.unmount();
            this.views.gallery?.unmount();
            this.views.configModal?.unmount();
        }
        if (this.runtime) {
            await this.runtime.destroy();
        }
    }
}

// Auto-bootstrap when executed in standard browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const autoMount = () => {
        if (document.querySelector('.dashboard-container') && !window.__DASHBOARD_SESSION__) {
            window.__DASHBOARD_SESSION__ = Dashboard.mount(document);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoMount, { once: true });
    } else {
        autoMount();
    }
}
