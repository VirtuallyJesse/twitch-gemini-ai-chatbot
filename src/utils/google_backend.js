const GOOGLE_BACKEND_ERROR = 'Configure exactly one Google backend: GEMINI_API_KEY or VERTEX_PROJECT_ID.';

export function resolveGoogleBackend(env = {}) {
    const apiKeys = String(env.GEMINI_API_KEY || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
    const projectId = String(env.VERTEX_PROJECT_ID || '').trim();
    const hasGemini = apiKeys.length > 0;
    const hasVertex = projectId.length > 0;

    if (hasGemini === hasVertex) throw new Error(GOOGLE_BACKEND_ERROR);
    if (hasVertex) return { kind: 'vertex', projectId };
    return { kind: 'gemini', apiKeys };
}
