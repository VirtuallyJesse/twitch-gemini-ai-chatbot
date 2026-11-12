// Product choices shared by config, the engine, and the dashboard selector.
// Order is dropdown order; the shipped default is chosen separately.
export const CHAT_MODELS = Object.freeze([
    Object.freeze({ id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' }),
    Object.freeze({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }),
    Object.freeze({ id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }),
    Object.freeze({ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' })
]);
export const DEFAULT_CHAT_MODEL = 'gemini-3.8-flash';

export function normalizeChatModel(value) {
    const model = String(value || '').trim().replace(/^models\//, '');
    return CHAT_MODELS.some(choice => choice.id === model) ? model : DEFAULT_CHAT_MODEL;
}
