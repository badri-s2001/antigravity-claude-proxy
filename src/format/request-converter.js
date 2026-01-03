/**
 * Request Converter
 * Converts Anthropic Messages API requests to Google Generative AI format
 */

import {
    GEMINI_MAX_OUTPUT_TOKENS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertContentToParts, convertRole } from './content-converter.js';
import { sanitizeSchema, cleanSchemaForGemini } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking
} from './thinking-utils.js';
import { logger } from '../utils/logger.js';

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 *
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 *
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertAnthropicToGoogle(anthropicRequest) {
    const { messages, system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking } = anthropicRequest;
    const modelName = anthropicRequest.model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isThinking = isThinkingModel(modelName);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            systemParts = [{ text: system }];
        } else if (Array.isArray(system)) {
            // Filter for text blocks as system prompts are usually text
            // Anthropic supports text blocks in system prompts
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: block.text }));
        }

        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    // Add interleaved thinking hint for Claude thinking models with tools
    if (isClaudeModel && isThinking && tools && tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Apply thinking recovery for Gemini thinking models when needed
    // This handles corrupted tool loops where thinking blocks are stripped
    // Claude models handle this differently and don't need this recovery
    let processedMessages = messages;
    if (isGeminiModel && isThinking && needsThinkingRecovery(messages)) {
        logger.debug('[RequestConverter] Applying thinking recovery for Gemini');
        processedMessages = closeToolLoopForThinking(messages);
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            msgContent = restoreThinkingSignatures(msgContent);
            // Remove trailing unsigned thinking blocks
            msgContent = removeTrailingThinkingBlocks(msgContent);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);

        // SAFETY: Google API requires at least one part per content message
        // This happens when all thinking blocks are filtered out (unsigned)
        if (parts.length === 0) {
            logger.warn('[RequestConverter] WARNING: Empty parts array after filtering, adding placeholder');
            parts.push({ text: '' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for Claude models
    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    // For Claude thinking models, check if last model message has a thinking block
    // Claude API requires: "a final assistant message must start with a thinking block"
    // If missing, we must DISABLE thinking for this request to avoid the error
    let shouldDisableThinking = false;
    if (isClaudeModel && isThinking && googleRequest.contents.length > 0) {
        // Find the last model message
        for (let i = googleRequest.contents.length - 1; i >= 0; i--) {
            const content = googleRequest.contents[i];
            if (content.role === 'model') {
                // Check if first part is a thinking block
                const firstPart = content.parts && content.parts[0];
                const hasThinking = firstPart && (
                    firstPart.thought === true ||
                    firstPart.type === 'thinking' ||
                    firstPart.thinking !== undefined
                );

                if (!hasThinking) {
                    // Last model message lacks thinking - must disable thinking for this request
                    shouldDisableThinking = true;
                    logger.warn('[RequestConverter] Last model message lacks thinking block - disabling thinking for this request');
                }
                break;
            }
        }
    }

    // Generation config
    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    // Enable thinking for thinking models (Claude and Gemini 3+)
    // Skip thinking config for Claude if last model message lacks thinking block
    if (isThinking && !(isClaudeModel && shouldDisableThinking)) {
        if (isClaudeModel) {
            // Claude thinking config
            const thinkingConfig = {
                include_thoughts: true
            };

            // Only set thinking_budget if explicitly provided
            const thinkingBudget = thinking?.budget_tokens;
            if (thinkingBudget) {
                thinkingConfig.thinking_budget = thinkingBudget;

                // Ensure max_tokens > budget_tokens (Claude API requirement)
                const currentMaxTokens = googleRequest.generationConfig.maxOutputTokens || 0;
                if (currentMaxTokens <= thinkingBudget) {
                    const newMaxTokens = thinkingBudget + 1;
                    googleRequest.generationConfig.maxOutputTokens = newMaxTokens;
                    logger.debug(`[RequestConverter] Adjusted max_tokens from ${currentMaxTokens} to ${newMaxTokens} (must be > budget_tokens: ${thinkingBudget})`);
                }

                logger.debug(`[RequestConverter] Claude thinking enabled with budget: ${thinkingBudget}`);
            } else {
                logger.debug('[RequestConverter] Claude thinking enabled (no budget specified)');
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            // Gemini thinking config (uses camelCase)
            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinking?.budget_tokens || 16000
            };
            logger.debug(`[RequestConverter] Gemini thinking enabled with budget: ${thinkingConfig.thinkingBudget}`);


            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Convert tools to Google format
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            // Extract name from various possible locations
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

            // Extract description from various possible locations
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema from various possible locations
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            // Sanitize schema for general compatibility
            let parameters = sanitizeSchema(schema);

            // For Gemini models, apply additional cleaning for VALIDATED mode
            if (isGeminiModel) {
                parameters = cleanSchemaForGemini(parameters);
            }

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
        logger.debug(`[RequestConverter] Tools: ${JSON.stringify(googleRequest.tools).substring(0, 300)}`);
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        logger.debug(`[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}
