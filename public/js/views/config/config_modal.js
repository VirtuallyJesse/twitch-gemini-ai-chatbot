// public/js/views/config/config_modal.js
// Coordinator module for the Admin Bot Configuration modal and sub-tabs.

import { PersonaTab } from './persona_tab.js';
import { CommandsTab } from './commands_tab.js';
import { AlertsTab } from './alerts_tab.js';
import { ErrorsTab } from './errors_tab.js';

export class ConfigModalView {
    constructor() {
        this.id = 'config_modal';
        this._container = null;
        this._context = null;
        this._unsubscribers = [];

        this.activeTab = 'system_instructions';

        // Sub-tabs
        this.personaTab = new PersonaTab();
        this.commandsTab = new CommandsTab();
        this.alertsTab = new AlertsTab();
        this.errorsTab = new ErrorsTab();

        this._modalBackdrop = null;
        this._closeBtn = null;
        this._saveNotice = null;

        this._handleKeyDown = this._handleKeyDown.bind(this);
    }

    /**
     * @param {HTMLElement} container - Modal container or root document
     * @param {Object} context
     * @param {import('../../runtime/dashboard_runtime.js').DashboardRuntime} context.runtime
     * @param {import('../../runtime/api_client.js').ApiClient} context.apiClient
     */
    mount(container, context) {
        this._container = container;
        this._context = context;

        const doc = container.ownerDocument || document;
        this._modalBackdrop = container.id === 'config-modal' ? container : (container.querySelector('#config-modal') || doc.getElementById('config-modal'));
        if (!this._modalBackdrop) return;

        this._closeBtn = this._modalBackdrop.querySelector('#close-config-btn');
        this._saveNotice = this._modalBackdrop.querySelector('#modal-save-notice');

        // Sub-tab context
        const subContext = {
            runtime: context.runtime,
            apiClient: context.apiClient,
            updateStatusBadge: this.updateStatusBadge.bind(this),
            saveConfig: this.saveConfig.bind(this),
            resetConfig: this.resetConfig.bind(this)
        };

        // Mount sub-tabs into their respective panes
        const personaPane = this._modalBackdrop.querySelector('#pane-system_instructions');
        if (personaPane) this.personaTab.mount(personaPane, subContext);

        const commandsPane = this._modalBackdrop.querySelector('#pane-custom_commands');
        if (commandsPane) this.commandsTab.mount(commandsPane, subContext);

        const alertsPane = this._modalBackdrop.querySelector('#pane-event_alerts');
        if (alertsPane) this.alertsTab.mount(alertsPane, subContext);

        const errorsPane = this._modalBackdrop.querySelector('#pane-error_messages');
        if (errorsPane) this.errorsTab.mount(errorsPane, subContext);

        // Setup modal event listeners
        this._setupModalEvents();

        // Subscribe to runtime config updates
        const { runtime } = context;
        this._unsubscribers.push(
            runtime.on('config:loaded', (config) => {
                this.render(config);
            })
        );

        if (runtime.config) {
            this.render(runtime.config);
        }
    }

    _setupModalEvents() {
        if (!this._modalBackdrop) return;

        if (this._closeBtn) {
            this._closeBtn.addEventListener('click', () => this.close());
        }

        // Click outside dialog to shake
        this._modalBackdrop.addEventListener('click', (e) => {
            if (e.target === this._modalBackdrop) {
                const dialog = this._modalBackdrop.querySelector('.modal-dialog');
                if (dialog) {
                    dialog.classList.remove('modal-shake');
                    void dialog.offsetWidth; // force reflow
                    dialog.classList.add('modal-shake');
                    dialog.addEventListener('animationend', () => {
                        dialog.classList.remove('modal-shake');
                    }, { once: true });
                }
            }
        });

        const win = typeof window !== 'undefined' ? window : null;
        if (win) {
            win.addEventListener('keydown', this._handleKeyDown);
        }

        // Tab switching
        this._modalBackdrop.querySelectorAll('.modal-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                if (targetTab) {
                    this.switchTab(targetTab);
                }
            });
        });
    }

    _handleKeyDown(e) {
        if (e.key === 'Escape' && this._modalBackdrop && this._modalBackdrop.style.display !== 'none') {
            this.close();
        }
    }

    open() {
        if (!this._modalBackdrop) return;
        const dialog = this._modalBackdrop.querySelector('.modal-dialog');
        if (dialog) dialog.classList.remove('modal-shake');
        this._modalBackdrop.style.display = 'flex';

        if (this._context?.runtime) {
            this._context.runtime.loadConfig().catch(() => {});
        }
    }

    close() {
        if (!this._modalBackdrop) return;
        const dialog = this._modalBackdrop.querySelector('.modal-dialog');
        if (dialog) dialog.classList.remove('modal-shake');
        this._modalBackdrop.style.display = 'none';
        if (this._saveNotice) this._saveNotice.textContent = '';
    }

    switchTab(tabKey) {
        this.activeTab = tabKey;
        if (!this._modalBackdrop) return;

        this._modalBackdrop.querySelectorAll('.modal-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabKey);
        });

        this._modalBackdrop.querySelectorAll('.tab-pane').forEach(p => {
            const isTarget = p.id === `pane-${tabKey}`;
            p.style.display = isTarget ? 'flex' : 'none';
            p.classList.toggle('active', isTarget);
        });

        if (tabKey === 'error_messages') {
            this.errorsTab.updateGateVisibility();
            if (this.errorsTab.errorsUnlocked) {
                this.errorsTab.renderMasterDetail();
            }
        }

        if (this._saveNotice) this._saveNotice.textContent = '';
    }

    render(config) {
        if (!config) return;
        this.personaTab.render(config);
        this.commandsTab.render(config);
        this.alertsTab.render(config);
        this.errorsTab.render(config);
    }

    updateStatusBadge(type, isOverride, isDirty = false) {
        if (!this._modalBackdrop) return;
        const badge = this._modalBackdrop.querySelector(`#status-${type}`);
        if (!badge) return;

        if (isDirty) {
            badge.innerHTML = '<span class="status-dot dirty">●</span> Unsaved Changes';
            badge.className = 'pane-status dirty';
        } else if (isOverride) {
            badge.innerHTML = '<span class="status-dot override">●</span> Custom Config';
            badge.className = 'pane-status override';
        } else {
            badge.innerHTML = '<span class="status-dot default">●</span> Factory Preset';
            badge.className = 'pane-status';
        }
    }

    async saveConfig(type, payload) {
        if (!this._saveNotice) return;
        this._saveNotice.className = 'modal-save-notice';
        this._saveNotice.textContent = 'Saving...';

        try {
            const res = await this._context.apiClient.saveConfig(type, payload);
            this._saveNotice.textContent = `✓ ${type.replace('_', ' ')} saved successfully.`;
            this.updateStatusBadge(type, res.override, false);

            // Hot reload local runtime config state
            if (this._context?.runtime) {
                if (!this._context.runtime.config) this._context.runtime.config = {};
                this._context.runtime.config[type] = res.value !== undefined ? res.value : payload;
                if (!this._context.runtime.config.overrides) this._context.runtime.config.overrides = {};
                this._context.runtime.config.overrides[type] = res.override;
            }

            setTimeout(() => {
                if (this._saveNotice && this._saveNotice.textContent.includes('✓')) {
                    this._saveNotice.textContent = '';
                }
            }, 3000);
        } catch (err) {
            this._saveNotice.className = 'modal-save-notice error';
            this._saveNotice.textContent = `Failed to save: ${err.message}`;
            throw err;
        }
    }

    async resetConfig(type) {
        const labelMap = {
            system_instructions: 'Persona',
            custom_commands: 'Commands',
            event_alerts: 'Alerts',
            error_messages: 'Errors'
        };
        const label = labelMap[type] || type.replace('_', ' ');

        const win = typeof window !== 'undefined' ? window : null;
        if (win && typeof win.confirm === 'function') {
            if (!win.confirm(`Reset all ${label} to factory default presets? This will overwrite your current ${label.toLowerCase()} configuration.`)) {
                return;
            }
        }

        if (!this._saveNotice) return;
        this._saveNotice.className = 'modal-save-notice';
        this._saveNotice.textContent = `Resetting ${label}...`;

        try {
            const res = await this._context.apiClient.resetConfig(type);
            this._saveNotice.textContent = `✓ Reverted ${label} to factory default.`;

            if (this._context?.runtime) {
                if (!this._context.runtime.config) this._context.runtime.config = {};
                this._context.runtime.config[type] = res.value;
                if (!this._context.runtime.config.overrides) this._context.runtime.config.overrides = {};
                this._context.runtime.config.overrides[type] = res.override;
                this.render(this._context.runtime.config);
            }

            setTimeout(() => {
                if (this._saveNotice && this._saveNotice.textContent.includes('✓')) {
                    this._saveNotice.textContent = '';
                }
            }, 3000);
        } catch (err) {
            this._saveNotice.className = 'modal-save-notice error';
            this._saveNotice.textContent = `Reset failed: ${err.message}`;
            throw err;
        }
    }

    unmount() {
        const win = typeof window !== 'undefined' ? window : null;
        if (win) {
            win.removeEventListener('keydown', this._handleKeyDown);
        }

        this.personaTab.unmount();
        this.commandsTab.unmount();
        this.alertsTab.unmount();
        this.errorsTab.unmount();

        this._unsubscribers.forEach(unsub => unsub());
        this._unsubscribers = [];
        this._container = null;
        this._context = null;
        this._modalBackdrop = null;
        this._closeBtn = null;
        this._saveNotice = null;
    }
}
