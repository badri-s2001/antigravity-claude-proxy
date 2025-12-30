/**
 * Response Mapper
 * Shared logic for mapping Anthropic responses to OpenAI format.
 */

import crypto from 'crypto';

/**
 * Map Anthropic stop reason to OpenAI finish_reason
 * @param {string} stopReason - Anthropic stop reason
 * @param {boolean} hasToolCalls - Whether tool calls are present
 * @returns {string} OpenAI finish reason
 */
export function mapFinishReason(stopReason, hasToolCalls = false) {
    if (stopReason === 'max_tokens') return 'length';
    if (stopReason === 'tool_use' || hasToolCalls) return 'tool_calls';
    if (stopReason === 'end_turn') return 'stop';
    return 'stop';
}

/**
 * Format usage object for OpenAI
 * @param {Object} anthropicUsage - Anthropic usage metadata
 * @param {string} thinkingContent - Optional thinking content for fallback estimation
 * @returns {Object} OpenAI usage object
 */
export function formatUsage(anthropicUsage, thinkingContent = '') {
    const reasoningTokens = anthropicUsage?.output_tokens_details?.reasoning_tokens ||
        (thinkingContent ? Math.ceil(thinkingContent.length / 4) : 0);

    return {
        prompt_tokens: (anthropicUsage?.input_tokens || 0) + (anthropicUsage?.cache_read_input_tokens || 0),
        completion_tokens: anthropicUsage?.output_tokens || 0,
        total_tokens: (anthropicUsage?.input_tokens || 0) + (anthropicUsage?.output_tokens || 0),
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

/**
 * Create a base response object metadata
 * @param {string} id - The completion ID (optional)
 * @returns {Object} Base metadata with ID and timestamp
 */
export function createMetadata(id = null) {
    return {
        id: id || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
        created: Math.floor(Date.now() / 1000)
    };
}

/**
 * Create a dictionary of thinking fields for native UI support
 * @param {string} thinking - Thinking content
 * @returns {Object} Reasoning fields
 */
export function createReasoningDelta(thinking) {
    if (!thinking) return {};
    return {
        reasoning_content: thinking,
        reasoning: thinking,
        thinking: thinking,
        thought: thinking
    };
}
