// public/js/utils/syntax_highlighter.js
// Utility for token syntax highlighting, scroll syncing, and dynamic textarea sizing.

import { escapeHtml } from './web_emotes.js';

/**
 * Attaches real-time token highlighting and auto-resizing to an input/textarea element.
 * @param {HTMLElement} inputEl
 * @param {string[]} [validVars=[]]
 */
export function attachSyntaxHighlighter(inputEl, validVars = []) {
    if (!inputEl) return;
    const wrapper = inputEl.closest('.highlight-input-wrapper');
    if (!wrapper) return;
    const backdrop = wrapper.querySelector('.highlight-backdrop');
    if (!backdrop) return;

    const isTextarea = inputEl.tagName === 'TEXTAREA';

    const update = () => {
        const val = inputEl.value || '';
        let escaped = escapeHtml(val);
        escaped = escaped.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, vName) => {
            const isValid = validVars.includes(vName);
            return isValid
                ? `<mark class="token-var valid">${match}</mark>`
                : `<mark class="token-var invalid">${match}</mark>`;
        });

        if (isTextarea) {
            if (val.endsWith('\n')) escaped += ' ';
            backdrop.innerHTML = escaped;

            inputEl.style.height = 'auto';
            const scrollH = inputEl.scrollHeight;
            if (scrollH > 0) {
                const nextHeight = Math.min(Math.max(scrollH, 38), 82);
                inputEl.style.height = `${nextHeight}px`;
                const hasOverflow = scrollH > 82;
                inputEl.classList.toggle('has-overflow', hasOverflow);
                inputEl.style.overflowY = hasOverflow ? 'auto' : 'hidden';
            }
            backdrop.scrollTop = inputEl.scrollTop;
        } else {
            backdrop.innerHTML = escaped;
            backdrop.scrollLeft = inputEl.scrollLeft;
        }
    };

    if (isTextarea) {
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
            }
        });
    }

    inputEl.addEventListener('input', update);
    inputEl.addEventListener('scroll', () => {
        if (isTextarea) {
            backdrop.scrollTop = inputEl.scrollTop;
        } else {
            backdrop.scrollLeft = inputEl.scrollLeft;
        }
    });

    update();
    if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(update);
    }
}

/**
 * Inserts a variable or token into an input or textarea element at current cursor position.
 * @param {HTMLInputElement|HTMLTextAreaElement} inputEl
 * @param {string} token
 */
export function insertTokenAtCursor(inputEl, token) {
    if (!inputEl) return;
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? inputEl.value.length;
    const oldVal = inputEl.value;
    inputEl.value = oldVal.substring(0, start) + token + oldVal.substring(end);
    const newPos = start + token.length;
    if (typeof inputEl.setSelectionRange === 'function') {
        inputEl.setSelectionRange(newPos, newPos);
    }
    inputEl.focus?.();
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

