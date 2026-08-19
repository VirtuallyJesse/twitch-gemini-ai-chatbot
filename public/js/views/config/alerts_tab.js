// public/js/views/config/alerts_tab.js
// Sub-view managing Twitch Event Alerts master-detail configuration canvas.

import { escapeHtml } from '../../utils/web_emotes.js';
import { attachSyntaxHighlighter, insertTokenAtCursor } from '../../utils/syntax_highlighter.js';

export { attachSyntaxHighlighter, insertTokenAtCursor };

export const ALERT_SPECS = [
    {
        kind: 'subscription',
        title: '⭐ New Subscription',
        desc: 'Fires when a viewer subscribes to the channel.',
        vars: ['username', 'tier'],
        sample: { username: 'CoolViewer', tier: 'Tier 1' },
        hasCooldown: true
    },
    {
        kind: 'resub',
        title: '🔄 Resubscription',
        desc: 'Fires when a viewer renews their subscription.',
        vars: ['username', 'months', 'streak', 'message'],
        sample: { username: 'LoyalViewer', months: '12', streak: '6', message: 'Love the stream!' },
        hasCooldown: true
    },
    {
        kind: 'community_sub_gift',
        title: '🎊 Community Gift Bomb',
        desc: 'Fires when a chatter gifts multiple subscriptions.',
        vars: ['username', 'count'],
        sample: { username: 'GenerousDonor', count: '5' },
        hasCooldown: true
    },
    {
        kind: 'sub_gift',
        title: '🎁 Gift Subscription',
        desc: 'Fires for individual gift subscription recipients.',
        vars: ['username', 'recipient'],
        sample: { username: 'GenerousDonor', recipient: 'LuckyChatter' },
        hasCooldown: true,
        extraToggle: { key: 'suppress_in_community_gift', label: 'Ignore during gift bombs' }
    },
    {
        kind: 'cheer',
        title: '💎 Cheer & Bits',
        desc: 'Fires when a chatter cheers bits.',
        vars: ['username', 'bits', 'message'],
        sample: { username: 'SuperFan', bits: '500', message: "Let's go!" },
        hasCooldown: true,
        extraNum: { key: 'min_bits', label: 'Min Bits' }
    },
    {
        kind: 'raid',
        title: '🚀 Incoming Raid',
        desc: 'Fires when another streamer raids your channel.',
        vars: ['username', 'viewers'],
        sample: { username: 'FriendlyStreamer', viewers: '35' },
        hasCooldown: true,
        extraNum: { key: 'min_viewers', label: 'Min Viewers' }
    },
    {
        kind: 'follow',
        title: '💜 Channel Follow',
        desc: 'Fires when a viewer follows the channel.',
        vars: ['username'],
        sample: { username: 'NewFollower' },
        hasCooldown: true
    },
    {
        kind: 'channel_points',
        title: '🎯 Channel Points Rewards',
        desc: 'Fires when a viewer redeems custom channel point rewards.',
        vars: ['username', 'reward', 'user_input'],
        sample: { username: 'HydrateFan', reward: 'Hydrate', user_input: 'Drink water!' },
        hasCooldown: true,
        isChannelPoints: true
    }
];

export function interpolate(template, vars = {}) {
    return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => {
        const v = vars[key];
        return v == null ? `{${key}}` : String(v);
    });
}

export class AlertsTab {
    constructor() {
        this.id = 'event_alerts';
        this._container = null;
        this._context = null;
        this.selectedAlertKind = 'subscription';
        this.alertsConfig = {};
        this._navListEl = null;
        this._detailPanelEl = null;
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

        this._navListEl = container.querySelector('#alerts-nav-list');
        this._detailPanelEl = container.querySelector('#alerts-detail-panel');

        const saveBtn = container.querySelector('.btn-save[data-type="event_alerts"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const payload = this.collectAlerts();
                this._context?.saveConfig(this.id, payload).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }

        const resetBtn = container.querySelector('.btn-reset[data-type="event_alerts"]');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this._context?.resetConfig(this.id).then(() => {
                    this._isDirty = false;
                }).catch(() => {});
            });
        }
    }

    render(config) {
        if (!config) return;
        this.alertsConfig = structuredClone(config.event_alerts || {});
        this._isDirty = false;

        if (!this.selectedAlertKind || !ALERT_SPECS.some(s => s.kind === this.selectedAlertKind)) {
            this.selectedAlertKind = ALERT_SPECS[0].kind;
        }

        this.renderNav();
        this.renderDetail(this.selectedAlertKind);

        const isOverride = Boolean(config.overrides?.event_alerts);
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, isOverride, false);
        }
    }

    _markDirty() {
        this._isDirty = true;
        if (this._context?.updateStatusBadge) {
            this._context.updateStatusBadge(this.id, true, true);
        }
    }

    _createElement(tagName) {
        const doc = this._container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
        return doc ? doc.createElement(tagName) : null;
    }

    renderNav() {
        if (!this._navListEl) return;
        this._navListEl.innerHTML = '';

        ALERT_SPECS.forEach(spec => {
            const data = this.alertsConfig[spec.kind] || {};
            const enabled = data.enabled !== false;
            const aiEnabled = data.ai_enabled !== false;
            const isActive = spec.kind === this.selectedAlertKind;

            const navItem = this._createElement('div');
            if (!navItem) return;
            navItem.className = `alerts-nav-item ${isActive ? 'active' : ''}`;
            navItem.dataset.kind = spec.kind;

            let modeBadgeHtml = '';
            if (spec.isChannelPoints) {
                modeBadgeHtml = enabled
                    ? '<span class="alert-mode-badge badge-ai">Enabled</span>'
                    : '<span class="alert-mode-badge badge-off">Off</span>';
            } else {
                if (!enabled) {
                    modeBadgeHtml = '<span class="alert-mode-badge badge-off">Off</span>';
                } else if (aiEnabled) {
                    modeBadgeHtml = '<span class="alert-mode-badge badge-ai">✨ AI</span>';
                } else {
                    modeBadgeHtml = '<span class="alert-mode-badge badge-tpl">💬 Static</span>';
                }
            }

            navItem.innerHTML = `
                <div class="alerts-nav-left">
                    <div class="alerts-nav-title">${escapeHtml(spec.title)}</div>
                    <div class="alerts-nav-meta">
                        <span class="nav-mode-slot">${modeBadgeHtml}</span>
                    </div>
                </div>
                <div class="alerts-nav-right">
                    <label class="switch-toggle small" title="Toggle ${escapeHtml(spec.title)}">
                        <input type="checkbox" class="nav-alert-toggle" ${enabled ? 'checked' : ''}>
                        <span class="switch-slider"></span>
                    </label>
                </div>
            `;

            const toggleInput = navItem.querySelector('.nav-alert-toggle');
            toggleInput.addEventListener('click', (e) => e.stopPropagation());
            toggleInput.addEventListener('change', () => {
                const isEn = toggleInput.checked;
                if (!this.alertsConfig[spec.kind]) this.alertsConfig[spec.kind] = {};
                this.alertsConfig[spec.kind].enabled = isEn;

                // Update left mode badge
                const slot = navItem.querySelector('.nav-mode-slot');
                if (slot) {
                    if (spec.isChannelPoints) {
                        slot.innerHTML = isEn
                            ? '<span class="alert-mode-badge badge-ai">Enabled</span>'
                            : '<span class="alert-mode-badge badge-off">Off</span>';
                    } else {
                        const curAi = this.alertsConfig[spec.kind].ai_enabled !== false;
                        if (!isEn) {
                            slot.innerHTML = '<span class="alert-mode-badge badge-off">Off</span>';
                        } else if (curAi) {
                            slot.innerHTML = '<span class="alert-mode-badge badge-ai">✨ AI</span>';
                        } else {
                            slot.innerHTML = '<span class="alert-mode-badge badge-tpl">💬 Static</span>';
                        }
                    }
                }

                if (this.selectedAlertKind === spec.kind) {
                    const detailToggle = this._detailPanelEl?.querySelector('.detail-enabled-toggle');
                    if (detailToggle && detailToggle.checked !== isEn) {
                        detailToggle.checked = isEn;
                    }
                }
                this._markDirty();
            });

            navItem.addEventListener('click', () => {
                if (this.selectedAlertKind !== spec.kind) {
                    this.selectAlert(spec.kind);
                }
            });

            this._navListEl.appendChild(navItem);
        });
    }

    selectAlert(kind) {
        this.flushActiveAlertDetail();
        this.selectedAlertKind = kind;

        if (this._navListEl) {
            this._navListEl.querySelectorAll('.alerts-nav-item').forEach(item => {
                item.classList.toggle('active', item.dataset.kind === kind);
            });
        }
        this.renderDetail(kind);
    }

    flushActiveAlertDetail() {
        if (!this._detailPanelEl || !this.selectedAlertKind) return;
        const kind = this.selectedAlertKind;
        if (!this.alertsConfig[kind]) this.alertsConfig[kind] = {};
        const curData = this.alertsConfig[kind];

        const detailToggle = this._detailPanelEl.querySelector('.detail-enabled-toggle');
        if (detailToggle) curData.enabled = detailToggle.checked;

        const cooldownInput = this._detailPanelEl.querySelector('.alert-cooldown');
        if (cooldownInput) curData.cooldown_seconds = Number(cooldownInput.value) || 0;

        const extraNum = this._detailPanelEl.querySelector('.alert-extra-num');
        if (extraNum) curData[extraNum.dataset.key] = Number(extraNum.value) || 0;

        const extraToggle = this._detailPanelEl.querySelector('.alert-extra-toggle');
        if (extraToggle) curData[extraToggle.dataset.key] = extraToggle.checked;

        if (kind === 'channel_points') {
            const rewards = {};
            this._detailPanelEl.querySelectorAll('.reward-rule-card').forEach(rc => {
                const name = rc.querySelector('.reward-name-input')?.value.trim();
                if (!name) return;
                const rAiEnabled = rc.querySelector('.reward-ai-toggle')?.checked ?? true;
                const rFallback = (rAiEnabled
                    ? rc.querySelector('.reward-fallback-input')?.value
                    : rc.querySelector('.reward-static-input')?.value)?.trim() || '';
                const rPrompt = rc.querySelector('.reward-prompt-input')?.value.trim() || '';
                rewards[name] = {
                    ai_enabled: rAiEnabled,
                    fallback_template: rFallback,
                    ai_prompt: rPrompt
                };
            });
            curData.rewards = rewards;
        } else {
            const isAi = this._detailPanelEl.querySelector('.alert-ai-toggle')?.checked ?? true;
            curData.ai_enabled = isAi;
            const fallbackVal = (isAi
                ? this._detailPanelEl.querySelector('.alert-fallback-input')?.value
                : this._detailPanelEl.querySelector('.alert-static-input')?.value)?.trim() || '';
            curData.fallback_template = fallbackVal;
            curData.ai_prompt = this._detailPanelEl.querySelector('.alert-ai-prompt-input')?.value.trim() || '';
        }
    }

    attachSyntaxHighlighter(inputEl, validVars = []) {
        attachSyntaxHighlighter(inputEl, validVars);
    }

    createRewardRuleElement(rewardName, rData = {}, spec) {
        const rCard = this._createElement('div');
        if (!rCard) return null;
        rCard.className = 'reward-rule-card';
        const rAiEnabled = rData.ai_enabled !== undefined ? Boolean(rData.ai_enabled) : true;
        const rFallback = rData.fallback_template || '';
        const rPrompt = rData.ai_prompt || '';
        const botName = this._getBotDisplayName();
        const rVars = spec.vars || ['username', 'reward', 'user_input'];

        const varPillsHtml = rVars.map(v =>
            `<button type="button" class="var-pill" data-var="{${v}}">+ {${v}}</button>`
        ).join('');

        rCard.innerHTML = `
            <div class="reward-rule-header">
                <div class="reward-rule-title-row">
                    <input type="text" class="table-input reward-name-input" value="${escapeHtml(rewardName)}" placeholder="Reward Title (e.g. Hydrate)" spellcheck="false" autocomplete="off">
                </div>
                <div class="reward-rule-actions">
                    <div class="mode-segmented-btn-group small">
                        <button type="button" class="mode-btn reward-mode-ai ${rAiEnabled ? 'active' : ''}">✨ AI Mode</button>
                        <button type="button" class="mode-btn reward-mode-tpl ${!rAiEnabled ? 'active template-mode' : ''}">💬 Static Mode</button>
                    </div>
                    <input type="checkbox" class="reward-ai-toggle" style="display: none;" ${rAiEnabled ? 'checked' : ''}>
                    <button type="button" class="btn btn-danger btn-del-reward" title="Delete Reward">✕</button>
                </div>
            </div>
            <div class="reward-rule-body">
                <!-- AI Mode Editor -->
                <div class="reward-ai-view" style="${rAiEnabled ? '' : 'display: none;'}">
                    <div class="field-block">
                        <div class="field-header-row">
                            <label class="field-label">AI Prompt:</label>
                            <span class="char-counter reward-prompt-counter">${rPrompt.length} / 1,000 chars</span>
                        </div>
                        <div class="highlight-input-wrapper multiline">
                            <div class="highlight-backdrop" aria-hidden="true"></div>
                            <textarea class="table-input highlight-textarea reward-prompt-input code-font" rows="1" maxlength="1000" placeholder="e.g. Remind the streamer to hydrate in your cheeky persona, requested by {username}.">${escapeHtml(rPrompt)}</textarea>
                        </div>
                        <div class="var-pills-row">
                            <div class="pills-group">${varPillsHtml}</div>
                            <button type="button" class="btn-test-ai reward-test-ai" title="Generate a live test response using Gemini">✨ Test AI Reply</button>
                        </div>
                    </div>

                    <!-- Live AI Test Mock Preview -->
                    <div class="twitch-chat-mock reward-test-preview" style="display: none;">
                        <div class="mock-chat-header">
                            <span class="mock-chat-label">CHAT PREVIEW</span>
                            <span class="mock-chat-tag reward-preview-tag"></span>
                        </div>
                        <div class="mock-chat-bubble">
                            <span class="chat-badge-bot">BOT</span>
                            <span class="chat-username">${escapeHtml(botName)}:</span>
                            <span class="chat-message-text reward-preview-text"></span>
                        </div>
                    </div>

                    <div class="field-block" style="margin-top: 6px;">
                        <div class="field-header-row">
                            <div class="field-label-group">
                                <label class="field-label">Offline Fallback: <span class="field-subtext">(if AI is offline or rate-limited)</span></label>
                            </div>
                            <span class="char-counter reward-fallback-counter">${rFallback.length} / 450 chars</span>
                        </div>
                        <div class="highlight-input-wrapper multiline">
                            <div class="highlight-backdrop" aria-hidden="true"></div>
                            <textarea class="table-input highlight-textarea reward-fallback-input code-font" rows="1" maxlength="450" placeholder="e.g. Drink water, streamer! {username} redeemed {reward}!">${escapeHtml(rFallback)}</textarea>
                        </div>
                        <div class="var-pills-row">
                            <div class="pills-group">${varPillsHtml}</div>
                        </div>
                    </div>
                </div>

                <!-- Static Mode Editor -->
                <div class="reward-template-view" style="${rAiEnabled ? 'display: none;' : ''}">
                    <div class="field-block">
                        <div class="field-header-row">
                            <label class="field-label">Message Template:</label>
                            <span class="char-counter reward-static-counter">${rFallback.length} / 450 chars</span>
                        </div>
                        <div class="highlight-input-wrapper multiline">
                            <div class="highlight-backdrop" aria-hidden="true"></div>
                            <textarea class="table-input highlight-textarea reward-static-input code-font" rows="1" maxlength="450" placeholder="e.g. Drink water, streamer! {username} redeemed {reward}!">${escapeHtml(rFallback)}</textarea>
                        </div>
                        <div class="var-pills-row">
                            <div class="pills-group">${varPillsHtml}</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const nameInput = rCard.querySelector('.reward-name-input');
        const fallbackInput = rCard.querySelector('.reward-fallback-input');
        const staticInput = rCard.querySelector('.reward-static-input');
        const aiToggle = rCard.querySelector('.reward-ai-toggle');
        const promptInput = rCard.querySelector('.reward-prompt-input');
        const btnAi = rCard.querySelector('.reward-mode-ai');
        const btnTpl = rCard.querySelector('.reward-mode-tpl');
        const aiView = rCard.querySelector('.reward-ai-view');
        const staticView = rCard.querySelector('.reward-template-view');
        const btnTestAi = rCard.querySelector('.reward-test-ai');
        const promptCounter = rCard.querySelector('.reward-prompt-counter');
        const fallbackCounter = rCard.querySelector('.reward-fallback-counter');
        const staticCounter = rCard.querySelector('.reward-static-counter');
        const testPreview = rCard.querySelector('.reward-test-preview');
        const previewTag = rCard.querySelector('.reward-preview-tag');
        const previewText = rCard.querySelector('.reward-preview-text');

        this.attachSyntaxHighlighter(promptInput, rVars);
        this.attachSyntaxHighlighter(fallbackInput, rVars);
        this.attachSyntaxHighlighter(staticInput, rVars);

        const updateCounters = () => {
            if (promptCounter && promptInput) {
                promptCounter.textContent = `${promptInput.value.length} / 1,000 chars`;
            }
            if (fallbackCounter && fallbackInput) {
                const len = fallbackInput.value.length;
                fallbackCounter.textContent = `${len} / 450 chars`;
                fallbackCounter.classList.toggle('warning', len > 400);
                fallbackCounter.classList.toggle('error', len > 450);
            }
            if (staticCounter && staticInput) {
                const len = staticInput.value.length;
                staticCounter.textContent = `${len} / 450 chars`;
                staticCounter.classList.toggle('warning', len > 400);
                staticCounter.classList.toggle('error', len > 450);
            }
        };

        const setRewardMode = (isAi) => {
            aiToggle.checked = isAi;
            btnAi.classList.toggle('active', isAi);
            btnTpl.classList.toggle('active', !isAi);
            btnTpl.classList.toggle('template-mode', !isAi);
            aiView.style.display = isAi ? 'flex' : 'none';
            staticView.style.display = isAi ? 'none' : 'flex';
            if (isAi && staticInput && fallbackInput && !fallbackInput.value && staticInput.value) {
                fallbackInput.value = staticInput.value;
                fallbackInput.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (!isAi && staticInput && fallbackInput && !staticInput.value && fallbackInput.value) {
                staticInput.value = fallbackInput.value;
                staticInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            updateCounters();
            this.flushActiveAlertDetail();
            this._markDirty();
        };

        btnAi.addEventListener('click', () => setRewardMode(true));
        btnTpl.addEventListener('click', () => setRewardMode(false));

        nameInput.addEventListener('input', () => {
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        if (fallbackInput) {
            fallbackInput.addEventListener('input', () => {
                updateCounters();
                if (staticInput && staticInput.value !== fallbackInput.value) {
                    staticInput.value = fallbackInput.value;
                    staticInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                this.flushActiveAlertDetail();
                this._markDirty();
            });
        }

        if (staticInput) {
            staticInput.addEventListener('input', () => {
                updateCounters();
                if (fallbackInput && fallbackInput.value !== staticInput.value) {
                    fallbackInput.value = staticInput.value;
                    fallbackInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                this.flushActiveAlertDetail();
                this._markDirty();
            });
        }

        if (promptInput) {
            promptInput.addEventListener('input', () => {
                updateCounters();
                this.flushActiveAlertDetail();
                this._markDirty();
            });
        }
        updateCounters();

        if (btnTestAi) {
            btnTestAi.addEventListener('click', async () => {
                const rawPrompt = (promptInput?.value || '').trim();
                if (!rawPrompt) {
                    alert('Please enter an AI prompt first before testing.');
                    return;
                }
                const sample = { ...(spec.sample || {}), reward: nameInput.value.trim() || 'Reward' };
                const interpolated = interpolate(rawPrompt, sample);
                btnTestAi.disabled = true;
                btnTestAi.innerHTML = '✨ Generating...';
                if (testPreview) testPreview.style.display = 'flex';
                if (previewTag) {
                    previewTag.textContent = 'GENERATING...';
                    previewTag.className = 'mock-chat-tag pending';
                }
                if (previewText) previewText.textContent = 'Generating real AI response from Gemini...';

                try {
                    if (!this._context?.apiClient) {
                        throw new Error('ApiClient not available');
                    }
                    const aiAnswer = await this._context.apiClient.generateAiTestResponse(interpolated);
                    if (previewText) previewText.textContent = aiAnswer;
                    if (previewTag) {
                        previewTag.textContent = '✨ AI TEST OUTPUT';
                        previewTag.className = 'mock-chat-tag ai-tested';
                    }
                } catch (err) {
                    if (previewText) previewText.textContent = `[AI Test Error: ${err.message}]`;
                    if (previewTag) {
                        previewTag.textContent = '⚠️ AI ERROR';
                        previewTag.className = 'mock-chat-tag error';
                    }
                } finally {
                    btnTestAi.disabled = false;
                    btnTestAi.innerHTML = '✨ Test AI Reply';
                }
            });
        }

        rCard.querySelector('.btn-del-reward').addEventListener('click', () => {
            rCard.remove();
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        rCard.querySelectorAll('.var-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                const block = pill.closest('.field-block');
                const target = block ? block.querySelector('.table-input') : promptInput;
                insertTokenAtCursor(target || promptInput, pill.dataset.var);
                updateCounters();
                this.flushActiveAlertDetail();
                this._markDirty();
            });
        });

        return rCard;
    }

    renderDetail(kind) {
        if (!this._detailPanelEl) return;
        this._detailPanelEl.innerHTML = '';

        const spec = ALERT_SPECS.find(s => s.kind === kind);
        if (!spec) return;

        const data = this.alertsConfig[kind] || {};
        const aiEnabled = data.ai_enabled !== false;
        const cooldown = data.cooldown_seconds !== undefined ? data.cooldown_seconds : (spec.isChannelPoints ? 5 : 0);
        const fallbackTpl = data.fallback_template || '';
        const aiPrompt = data.ai_prompt || '';
        const botName = this._getBotDisplayName();

        if (spec.isChannelPoints) {
            const detailEl = this._createElement('div');
            if (!detailEl) return;
            detailEl.className = 'alerts-detail-content';
            detailEl.innerHTML = `
                <div class="alert-detail-header">
                    <div class="alert-detail-title-group">
                        <strong class="alert-detail-title">${escapeHtml(spec.title)}</strong>
                        <span class="alert-detail-desc">${escapeHtml(spec.desc)}</span>
                    </div>
                    <button type="button" class="btn btn-secondary btn-add-reward">+ Add Custom Reward</button>
                </div>

                <!-- Cooldown rule bar -->
                <div class="alert-delivery-footer" style="padding-top: 0; border-top: none; margin-top: 0;">
                    <div class="delivery-control">
                        <label class="delivery-label">⏱️ Cooldown:</label>
                        <div class="input-unit-group">
                            <input type="number" class="table-input alert-cooldown" value="${cooldown}" min="0" style="width: 65px;">
                            <span class="input-unit">sec</span>
                        </div>
                    </div>
                </div>

                <div class="rewards-container" style="margin-top: 4px;"></div>
            `;

            const cooldownInput = detailEl.querySelector('.alert-cooldown');
            const rewardsContainer = detailEl.querySelector('.rewards-container');
            const btnAddReward = detailEl.querySelector('.btn-add-reward');
            const rewards = (data.rewards && typeof data.rewards === 'object') ? data.rewards : {};

            cooldownInput.addEventListener('input', () => {
                this.flushActiveAlertDetail();
                this._markDirty();
            });

            for (const [rName, rData] of Object.entries(rewards)) {
                rewardsContainer.appendChild(this.createRewardRuleElement(rName, rData, spec));
            }

            btnAddReward.addEventListener('click', () => {
                const newEl = this.createRewardRuleElement('', { ai_enabled: true, fallback_template: '', ai_prompt: '' }, spec);
                rewardsContainer.appendChild(newEl);
                const nameInput = newEl.querySelector('.reward-name-input');
                if (nameInput) nameInput.focus();
                this.flushActiveAlertDetail();
                this._markDirty();
            });

            this._detailPanelEl.appendChild(detailEl);
            return;
        }

        let extrasHtml = '';
        if (spec.extraToggle) {
            const extraVal = data[spec.extraToggle.key] !== undefined ? Boolean(data[spec.extraToggle.key]) : true;
            extrasHtml += `
                <label class="switch-toggle small">
                    <input type="checkbox" class="alert-extra-toggle" data-key="${spec.extraToggle.key}" ${extraVal ? 'checked' : ''}>
                    <span class="switch-slider"></span>
                    <span class="switch-label">${escapeHtml(spec.extraToggle.label)}</span>
                </label>
            `;
        }
        if (spec.extraNum) {
            const numVal = data[spec.extraNum.key] !== undefined ? data[spec.extraNum.key] : 100;
            extrasHtml += `
                <div class="delivery-control">
                    <label class="delivery-label">${escapeHtml(spec.extraNum.label)}:</label>
                    <input type="number" class="table-input alert-extra-num" data-key="${spec.extraNum.key}" value="${numVal}" min="0" style="width: 65px;">
                </div>
            `;
        }

        const varPillsHtml = spec.vars.map(v =>
            `<button type="button" class="var-pill" data-var="{${v}}">+ {${v}}</button>`
        ).join('');

        const initialPreviewText = fallbackTpl
            ? interpolate(fallbackTpl, spec.sample)
            : `Thank you ${spec.sample?.username || 'Chatter'}!`;

        const detailEl = this._createElement('div');
        if (!detailEl) return;
        detailEl.className = 'alerts-detail-content';
        detailEl.innerHTML = `
            <div class="alert-detail-header">
                <div class="alert-detail-title-group">
                    <strong class="alert-detail-title">${escapeHtml(spec.title)}</strong>
                    <span class="alert-detail-desc">${escapeHtml(spec.desc)}</span>
                </div>
                <div class="mode-segmented-btn-group">
                    <button type="button" class="mode-btn mode-btn-ai ${aiEnabled ? 'active' : ''}">✨ AI Mode</button>
                    <button type="button" class="mode-btn mode-btn-tpl ${!aiEnabled ? 'active template-mode' : ''}">💬 Static Mode</button>
                </div>
                <input type="checkbox" class="alert-ai-toggle" style="display: none;" ${aiEnabled ? 'checked' : ''}>
            </div>

            <!-- Chat Mock Preview Bubble -->
            <div class="twitch-chat-mock alert-live-preview">
                <div class="mock-chat-header">
                    <span class="mock-chat-label">CHAT PREVIEW</span>
                    <span class="mock-chat-tag" style="display: none;"></span>
                </div>
                <div class="mock-chat-bubble">
                    <span class="chat-badge-bot">BOT</span>
                    <span class="chat-username">${escapeHtml(botName)}:</span>
                    <span class="chat-message-text alert-preview-text">${escapeHtml(initialPreviewText)}</span>
                </div>
            </div>

            <!-- AI Mode Form -->
            <div class="alert-ai-view" style="${aiEnabled ? '' : 'display: none;'}">
                <div class="field-block">
                    <div class="field-header-row">
                        <label class="field-label">AI Prompt:</label>
                        <span class="char-counter alert-prompt-counter">${aiPrompt.length} / 1,000 chars</span>
                    </div>
                    <div class="highlight-input-wrapper multiline">
                        <div class="highlight-backdrop" aria-hidden="true"></div>
                        <textarea class="table-input highlight-textarea alert-ai-prompt-input code-font" rows="1" maxlength="1000" placeholder="e.g. Acknowledge {username} subscribing with an enthusiastic welcome.">${escapeHtml(aiPrompt)}</textarea>
                    </div>
                    <div class="var-pills-row">
                        <div class="pills-group">${varPillsHtml}</div>
                        <button type="button" class="btn-test-ai alert-test-ai" title="Generate a test response using Gemini">✨ Test AI Reply</button>
                    </div>
                </div>

                <div class="field-block" style="margin-top: 10px;">
                    <div class="field-header-row">
                        <div class="field-label-group">
                            <label class="field-label">Offline Fallback: <span class="field-subtext">(if AI is offline or rate-limited)</span></label>
                        </div>
                        <span class="char-counter alert-fallback-counter">${fallbackTpl.length} / 450 chars</span>
                    </div>
                    <div class="highlight-input-wrapper multiline">
                        <div class="highlight-backdrop" aria-hidden="true"></div>
                        <textarea class="table-input highlight-textarea alert-fallback-input code-font" rows="1" maxlength="450" placeholder="e.g. Welcome to the community, {username}!">${escapeHtml(fallbackTpl)}</textarea>
                    </div>
                    <div class="var-pills-row">
                        <div class="pills-group">${varPillsHtml}</div>
                    </div>
                </div>
            </div>

            <!-- Static Mode Form -->
            <div class="alert-template-view" style="${aiEnabled ? 'display: none;' : ''}">
                <div class="field-block">
                    <div class="field-header-row">
                        <label class="field-label">Message Template:</label>
                        <span class="char-counter alert-static-counter">${fallbackTpl.length} / 450 chars</span>
                    </div>
                    <div class="highlight-input-wrapper multiline">
                        <div class="highlight-backdrop" aria-hidden="true"></div>
                        <textarea class="table-input highlight-textarea alert-static-input code-font" rows="1" maxlength="450" placeholder="e.g. Welcome to the community, {username}!">${escapeHtml(fallbackTpl)}</textarea>
                    </div>
                    <div class="var-pills-row">
                        <div class="pills-group">${varPillsHtml}</div>
                    </div>
                </div>
            </div>

            <!-- Trigger Conditions & Delivery rules -->
            <div class="alert-delivery-footer">
                <div class="delivery-control">
                    <label class="delivery-label">⏱️ Cooldown:</label>
                    <div class="input-unit-group">
                        <input type="number" class="table-input alert-cooldown" value="${cooldown}" min="0" style="width: 65px;">
                        <span class="input-unit">sec</span>
                    </div>
                </div>
                ${extrasHtml}
            </div>
        `;

        const btnAi = detailEl.querySelector('.mode-btn-ai');
        const btnTpl = detailEl.querySelector('.mode-btn-tpl');
        const aiToggle = detailEl.querySelector('.alert-ai-toggle');
        const aiView = detailEl.querySelector('.alert-ai-view');
        const staticView = detailEl.querySelector('.alert-template-view');
        const previewTag = detailEl.querySelector('.mock-chat-tag');
        const previewText = detailEl.querySelector('.alert-preview-text');

        const promptInput = detailEl.querySelector('.alert-ai-prompt-input');
        const fallbackInput = detailEl.querySelector('.alert-fallback-input');
        const staticInput = detailEl.querySelector('.alert-static-input');
        const promptCounter = detailEl.querySelector('.alert-prompt-counter');
        const fallbackCounter = detailEl.querySelector('.alert-fallback-counter');
        const staticCounter = detailEl.querySelector('.alert-static-counter');
        const btnTestAi = detailEl.querySelector('.alert-test-ai');
        const cooldownInput = detailEl.querySelector('.alert-cooldown');
        const extraNum = detailEl.querySelector('.alert-extra-num');
        const extraToggle = detailEl.querySelector('.alert-extra-toggle');

        this.attachSyntaxHighlighter(promptInput, spec.vars || []);
        this.attachSyntaxHighlighter(fallbackInput, spec.vars || []);
        this.attachSyntaxHighlighter(staticInput, spec.vars || []);

        const updateCounters = () => {
            if (promptCounter && promptInput) {
                promptCounter.textContent = `${promptInput.value.length} / 1,000 chars`;
            }
            if (fallbackCounter && fallbackInput) {
                const len = fallbackInput.value.length;
                fallbackCounter.textContent = `${len} / 450 chars`;
                fallbackCounter.classList.toggle('warning', len > 400);
                fallbackCounter.classList.toggle('error', len > 450);
            }
            if (staticCounter && staticInput) {
                const len = staticInput.value.length;
                staticCounter.textContent = `${len} / 450 chars`;
                staticCounter.classList.toggle('warning', len > 400);
                staticCounter.classList.toggle('error', len > 450);
            }
        };

        const updatePreviewFromTemplate = () => {
            if (previewTag) {
                previewTag.style.display = 'none';
                previewTag.textContent = '';
            }
            const tplVal = (aiToggle.checked ? fallbackInput?.value : staticInput?.value) || '';
            if (tplVal) {
                previewText.textContent = interpolate(tplVal, spec.sample);
            } else {
                previewText.textContent = `[${spec.title} will fire in chat]`;
            }
        };

        const setMode = (isAi) => {
            aiToggle.checked = isAi;
            btnAi.classList.toggle('active', isAi);
            btnTpl.classList.toggle('active', !isAi);
            btnTpl.classList.toggle('template-mode', !isAi);
            aiView.style.display = isAi ? 'flex' : 'none';
            staticView.style.display = isAi ? 'none' : 'flex';

            if (isAi && staticInput && fallbackInput && !fallbackInput.value && staticInput.value) {
                fallbackInput.value = staticInput.value;
                fallbackInput.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (!isAi && staticInput && fallbackInput && !staticInput.value && fallbackInput.value) {
                staticInput.value = fallbackInput.value;
                staticInput.dispatchEvent(new Event('input', { bubbles: true }));
            }

            updatePreviewFromTemplate();
            updateCounters();
            this.flushActiveAlertDetail();
            this.renderNav();
            this._markDirty();
        };

        btnAi.addEventListener('click', () => setMode(true));
        btnTpl.addEventListener('click', () => setMode(false));

        promptInput?.addEventListener('input', () => {
            updateCounters();
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        fallbackInput?.addEventListener('input', () => {
            updateCounters();
            if (staticInput && staticInput.value !== fallbackInput.value) {
                staticInput.value = fallbackInput.value;
                staticInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            updatePreviewFromTemplate();
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        staticInput?.addEventListener('input', () => {
            updateCounters();
            if (fallbackInput && fallbackInput.value !== staticInput.value) {
                fallbackInput.value = staticInput.value;
                fallbackInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            updatePreviewFromTemplate();
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        cooldownInput?.addEventListener('input', () => {
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        extraNum?.addEventListener('input', () => {
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        extraToggle?.addEventListener('change', () => {
            this.flushActiveAlertDetail();
            this._markDirty();
        });

        if (btnTestAi) {
            btnTestAi.addEventListener('click', async () => {
                const rawPrompt = (promptInput?.value || '').trim();
                if (!rawPrompt) {
                    alert('Please enter an AI prompt first before testing.');
                    return;
                }
                const interpolated = interpolate(rawPrompt, spec.sample);
                btnTestAi.disabled = true;
                btnTestAi.innerHTML = '✨ Generating...';
                if (previewTag) {
                    previewTag.style.display = 'inline-block';
                    previewTag.textContent = '⏳ GENERATING...';
                    previewTag.className = 'mock-chat-tag pending';
                }
                previewText.textContent = 'Generating real AI response from Gemini...';

                try {
                    if (!this._context?.apiClient) {
                        throw new Error('ApiClient not available');
                    }
                    const aiAnswer = await this._context.apiClient.generateAiTestResponse(interpolated);
                    previewText.textContent = aiAnswer;
                    if (previewTag) {
                        previewTag.textContent = '✨ AI TEST RESULT';
                        previewTag.className = 'mock-chat-tag ai-tested';
                    }
                } catch (err) {
                    previewText.textContent = `[AI Test Error: ${err.message}]`;
                    if (previewTag) {
                        previewTag.textContent = '⚠️ AI ERROR';
                        previewTag.className = 'mock-chat-tag error';
                    }
                } finally {
                    btnTestAi.disabled = false;
                    btnTestAi.innerHTML = '✨ Test AI Reply';
                }
            });
        }

        detailEl.querySelectorAll('.var-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                const block = pill.closest('.field-block');
                const target = block ? block.querySelector('.table-input') : promptInput;
                insertTokenAtCursor(target || promptInput, pill.dataset.var);
                updateCounters();
                if (target === fallbackInput || target === staticInput) updatePreviewFromTemplate();
                this.flushActiveAlertDetail();
                this._markDirty();
            });
        });

        this._detailPanelEl.appendChild(detailEl);
    }

    collectAlerts() {
        this.flushActiveAlertDetail();
        return structuredClone(this.alertsConfig);
    }

    _getBotDisplayName() {
        const v = this._context?.runtime?.viewer || (typeof window !== 'undefined' ? window.__VIEWER__ : null);
        return v?.displayName || v?.login || 'TwitchBot';
    }

    unmount() {
        this._container = null;
        this._context = null;
        this._navListEl = null;
        this._detailPanelEl = null;
    }
}
