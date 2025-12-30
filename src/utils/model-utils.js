/**
 * Model Utilities
 * Handles model aliasing, family detection, and capability checks.
 */

/**
 * Get the model family from model name.
 * @param {string} modelName - The model name
 * @returns {'claude' | 'gemini' | 'gpt' | 'unknown'} The model family
 */
export function getModelFamily(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    if (lower.includes('gpt')) return 'gpt';
    return 'unknown';
}

/**
 * Check if a model supports thinking/reasoning output.
 * @param {string} modelName - The model name
 * @returns {boolean} True if the model supports thinking blocks
 */
export function isThinkingModel(modelName) {
    const lower = (modelName || '').toLowerCase();

    // Claude thinking models
    if (lower.includes('claude') && lower.includes('thinking')) return true;

    // Gemini thinking models: explicit "thinking" in name, OR gemini version 3+
    if (lower.includes('gemini')) {
        if (lower.includes('thinking')) return true;
        const versionMatch = lower.match(/gemini-(\d+)/);
        if (versionMatch && parseInt(versionMatch[1], 10) >= 3) return true;
    }

    // GPT thinking models (e.g., gpt-oss, gpt-4-reasoning)
    if (lower.includes('gpt')) {
        if (lower.includes('thinking') || lower.includes('reasoning') || lower.includes('oss')) return true;
    }

    return false;
}

/**
 * Map model aliases to actual Antigravity model names.
 * @param {string} modelName - The model name from the request
 * @returns {string} The actual model name to use
 */
export function resolveModelAlias(modelName) {
    const name = (modelName || '').toLowerCase();

    const aliases = {
        'opus': 'claude-opus-4-5-thinking',
        'opus-proxy': 'claude-opus-4-5-thinking',
        'antigravity-opus': 'claude-opus-4-5-thinking',
        'claude-opus': 'claude-opus-4-5-thinking',

        'sonnet': 'claude-sonnet-4-5-thinking',
        'sonnet-proxy': 'claude-sonnet-4-5-thinking',
        'antigravity-sonnet': 'claude-sonnet-4-5-thinking',

        'sonnet-no-thinking': 'claude-sonnet-4-5',
        'claude-sonnet-4-5': 'claude-sonnet-4-5',

        'gemini': 'gemini-3-flash',
        'gemini-proxy': 'gemini-3-flash',
        'flash': 'gemini-3-flash',

        'gemini-pro': 'gemini-3-pro-high',
        'gemini-pro-high': 'gemini-3-pro-high',
        'gemini-pro-low': 'gemini-3-pro-low',

        'gpt-oss': 'gpt-oss-120b-medium',
        'gpt-oss-120b': 'gpt-oss-120b-medium',

        'test': 'claude-sonnet-4-5-thinking',
        'default': 'claude-sonnet-4-5-thinking'
    };

    if (aliases[name]) return aliases[name];
    if (name.includes('claude') || name.includes('gemini') || name.includes('gpt')) return modelName;

    return 'claude-sonnet-4-5-thinking';
}
