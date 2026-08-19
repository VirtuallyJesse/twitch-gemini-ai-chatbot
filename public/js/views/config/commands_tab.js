// public/js/views/config/commands_tab.js
// Sub-view managing Custom Commands configuration table.

import { escapeHtml } from '../../utils/web_emotes.js';

export class CommandsTab {
    constructor() {
        this.id = 'custom_commands';
        this._container = null;
        this._context = null;
        this._tbody = null;
        this._searchInput = null;
        this._btnAdd = null;
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

        this._tbody = container.querySelector('#commands-tbody');
        this._searchInput = container.querySelector('#search-commands');
        this._btnAdd = container.querySelector('#btn-add-command');

        if (this._btnAdd) {
            this._btnAdd.addEventListener('click', () => {
                this.addCommandRow({ command: '', response: '', role: 'all' });
                this._markDirty();
            });
        }

        if (this._searchInput) {
            this._searchInput.addEventListener('input', () => {
                this.filterCommands(this._searchInput.value);
            });
        }

        const saveBtn = container.querySelector('.btn-save[data-type="custom_commands"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const list = this.collectCommands();
                this._context?.saveConfig(this.id, list).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }

        const resetBtn = container.querySelector('.btn-reset[data-type="custom_commands"]');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this._context?.resetConfig(this.id).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }
    }

    render(config) {
        if (!this._tbody || !config) return;
        this._tbody.innerHTML = '';
        this._isDirty = false;

        const commands = Array.isArray(config.custom_commands) ? config.custom_commands : [];
        commands.forEach(cmd => this.addCommandRow(cmd));

        if (this._searchInput?.value) {
            this.filterCommands(this._searchInput.value);
        }

        const isOverride = Boolean(config.overrides?.custom_commands);
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, isOverride, false);
        }
    }

    addCommandRow(cmd = {}) {
        if (!this._tbody) return;
        const doc = this._container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;
        const tr = doc.createElement('tr');
        const aliasesStr = Array.isArray(cmd.aliases) ? cmd.aliases.join(', ') : (cmd.aliases || '');

        tr.innerHTML = `
            <td><input type="text" class="table-input cmd-name" value="${escapeHtml(cmd.command || '')}" placeholder="!command" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></td>
            <td><input type="text" class="table-input cmd-aliases" value="${escapeHtml(aliasesStr)}" placeholder="!alias1, !alias2" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></td>
            <td><input type="text" class="table-input cmd-resp" value="${escapeHtml(cmd.response || '')}" placeholder="Response text" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></td>
            <td>
                <select class="table-select cmd-role">
                    <option value="all" ${cmd.role === 'all' ? 'selected' : ''}>Everyone</option>
                    <option value="moderator" ${cmd.role === 'moderator' ? 'selected' : ''}>Moderator+</option>
                    <option value="broadcaster" ${cmd.role === 'broadcaster' ? 'selected' : ''}>Broadcaster Only</option>
                </select>
            </td>
            <td style="text-align: center;"><button class="btn btn-danger btn-del-row" title="Delete">✕</button></td>
        `;

        const nameInput = tr.querySelector('.cmd-name');
        const aliasInput = tr.querySelector('.cmd-aliases');
        const respInput = tr.querySelector('.cmd-resp');
        const roleSelect = tr.querySelector('.cmd-role');
        const delBtn = tr.querySelector('.btn-del-row');

        nameInput.addEventListener('blur', () => {
            let v = nameInput.value.trim();
            if (v && !v.startsWith('!')) nameInput.value = `!${v}`;
        });

        aliasInput.addEventListener('blur', () => {
            let parts = aliasInput.value.split(',').map(s => s.trim()).filter(Boolean);
            aliasInput.value = parts.map(p => p.startsWith('!') ? p : `!${p}`).join(', ');
        });

        nameInput.addEventListener('input', () => this._markDirty());
        aliasInput.addEventListener('input', () => this._markDirty());
        respInput.addEventListener('input', () => this._markDirty());
        roleSelect.addEventListener('change', () => this._markDirty());

        delBtn.addEventListener('click', () => {
            tr.remove();
            this._markDirty();
        });

        this._tbody.appendChild(tr);
    }

    _markDirty() {
        this._isDirty = true;
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, true, true);
        }
    }

    filterCommands(query) {
        if (!this._tbody) return;
        const q = String(query || '').trim().toLowerCase();
        this._tbody.querySelectorAll('tr').forEach(row => {
            const cmd = row.querySelector('.cmd-name')?.value.toLowerCase() || '';
            const aliases = row.querySelector('.cmd-aliases')?.value.toLowerCase() || '';
            const resp = row.querySelector('.cmd-resp')?.value.toLowerCase() || '';
            const match = !q || cmd.includes(q) || aliases.includes(q) || resp.includes(q);
            row.style.display = match ? '' : 'none';
        });
    }

    collectCommands() {
        if (!this._tbody) return [];
        const rows = this._tbody.querySelectorAll('tr');
        const list = [];
        for (const row of rows) {
            let command = row.querySelector('.cmd-name')?.value.trim();
            let aliasesRaw = row.querySelector('.cmd-aliases')?.value.trim() || '';
            const response = row.querySelector('.cmd-resp')?.value.trim();
            const role = row.querySelector('.cmd-role')?.value || 'all';
            if (command && response) {
                if (!command.startsWith('!')) command = `!${command}`;
                const aliases = aliasesRaw
                    ? aliasesRaw.split(',').map(s => s.trim()).filter(Boolean).map(a => a.startsWith('!') ? a : `!${a}`)
                    : [];
                list.push({ command, aliases, response, role });
            }
        }
        return list;
    }

    unmount() {
        this._container = null;
        this._context = null;
        this._tbody = null;
        this._searchInput = null;
        this._btnAdd = null;
    }
}
