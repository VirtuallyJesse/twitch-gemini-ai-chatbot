// public/js/views/config/persona_tab.js
// Sub-view managing Bot Persona and System Instructions.

export class PersonaTab {
    constructor() {
        this.id = 'system_instructions';
        this._container = null;
        this._context = null;
        this._textarea = null;
        this._counter = null;
        this._isDirty = false;
    }

    /**
     * @param {HTMLElement} container
     * @param {Object} context
     * @param {import('../../runtime/dashboard_runtime.js').DashboardRuntime} context.runtime
     * @param {import('../../runtime/api_client.js').ApiClient} context.apiClient
     * @param {(type: string, isOverride: boolean, isDirty?: boolean) => void} context.updateStatusBadge
     * @param {(type: string, payload: any) => Promise<void>} context.saveConfig
     * @param {(type: string) => Promise<void>} context.resetConfig
     */
    mount(container, context) {
        this._container = container;
        this._context = context;

        this._textarea = container.querySelector('#input-system_instructions');
        this._counter = container.querySelector('#persona-char-counter');

        if (this._textarea) {
            this._textarea.addEventListener('input', () => {
                this.updateCharCounter();
                this._isDirty = true;
                if (this._context?.updateStatusBadge) {
                    this._context.updateStatusBadge(this.id, true, true);
                }
            });
        }

        const saveBtn = container.querySelector('.btn-save[data-type="system_instructions"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const val = this._textarea?.value || '';
                this._context?.saveConfig(this.id, val).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }

        const resetBtn = container.querySelector('.btn-reset[data-type="system_instructions"]');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this._context?.resetConfig(this.id).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }
    }

    render(config) {
        if (!this._textarea || !config) return;
        this._textarea.value = config.system_instructions || '';
        this._isDirty = false;
        this.updateCharCounter();

        const isOverride = Boolean(config.overrides?.system_instructions);
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, isOverride, false);
        }
    }

    updateCharCounter() {
        if (!this._textarea || !this._counter) return;
        const len = this._textarea.value.length;
        this._counter.textContent = `${len.toLocaleString()} / 16,000 characters`;
        this._counter.classList.toggle('error', len > 16000);
    }

    getValue() {
        return this._textarea?.value || '';
    }

    unmount() {
        this._container = null;
        this._context = null;
        this._textarea = null;
        this._counter = null;
    }
}
