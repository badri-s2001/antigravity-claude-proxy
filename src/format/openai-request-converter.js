/**
 * OpenAI Request Converter
 * Converts OpenAI Chat Completions API requests to Google Generative AI format
 */

import {
    GEMINI_MAX_OUTPUT_TOKENS,
} from '../constants.js';
import {
    getModelFamily,
    isThinkingModel,
    resolveModelAlias
} from '../utils/model-utils.js';
import { sanitizeSchema, cleanSchemaForGemini } from './schema-sanitizer.js';

/**
 * Convert OpenAI Chat Completions request to Google Generative AI format
 *
 * @param {Object} openaiRequest - OpenAI Chat Completions format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertOpenAIToGoogle(openaiRequest) {
    const {
        model,
        messages,
        max_tokens,
        temperature,
        top_p,
        stop,
        tools,
        tool_choice,
        n,
        presence_penalty,
        frequency_penalty
    } = openaiRequest;

    const modelName = model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isGptModel = modelFamily === 'gpt';
    const isThinking = isThinkingModel(modelName);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Process messages - extract system message and convert others
    let systemContent = null;
    const conversationMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            // Accumulate system messages
            if (systemContent === null) {
                systemContent = msg.content;
            } else {
                systemContent += '\n\n' + msg.content;
            }
        } else {
            conversationMessages.push(msg);
        }
    }

    // Handle system instruction
    if (systemContent) {
        googleRequest.systemInstruction = {
            parts: [{ text: systemContent }]
        };
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

    // Convert messages to Google contents format
    for (const msg of conversationMessages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const parts = [];

        // Handle content - can be string or array (for vision models)
        if (typeof msg.content === 'string') {
            parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
            // OpenAI multi-modal format
            for (const item of msg.content) {
                if (item.type === 'text') {
                    parts.push({ text: item.text });
                } else if (item.type === 'image_url') {
                    // Handle image URLs
                    const imageUrl = item.image_url?.url || item.image_url;
                    if (imageUrl && imageUrl.startsWith('data:')) {
                        // Base64 encoded image
                        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                        if (match) {
                            parts.push({
                                inlineData: {
                                    mimeType: match[1],
                                    data: match[2]
                                }
                            });
                        }
                    }
                }
            }
        }

        // Handle tool calls in assistant messages
        if (msg.role === 'assistant' && msg.tool_calls) {
            for (const toolCall of msg.tool_calls) {
                if (toolCall.type === 'function') {
                    let args = {};
                    try {
                        args = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        args = {};
                    }
                    parts.push({
                        functionCall: {
                            name: toolCall.function.name,
                            args: args
                        }
                    });
                }
            }
        }

        // Handle tool response messages
        if (msg.role === 'tool') {
            // Convert tool response to function response format
            parts.push({
                functionResponse: {
                    name: msg.name || 'tool_response',
                    response: { result: msg.content }
                }
            });
        }

        // Ensure at least one part
        if (parts.length === 0) {
            parts.push({ text: '' });
        }

        googleRequest.contents.push({ role, parts });
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
    if (stop) {
        const stopSequences = Array.isArray(stop) ? stop : [stop];
        googleRequest.generationConfig.stopSequences = stopSequences.slice(0, 4);
    }

    // Enable thinking for thinking models
    if (isThinking) {
        if (isClaudeModel) {
            googleRequest.generationConfig.thinkingConfig = {
                include_thoughts: true
            };
        } else if (isGeminiModel || isGptModel) {
            // GPT models (like gpt-oss) in Antigravity follow Gemini-style config
            googleRequest.generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: 16000
            };
        }
    }

    // Convert tools to Google format
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            if (tool.type !== 'function') return null;

            const func = tool.function;
            const name = func.name || `tool-${idx}`;
            const description = func.description || '';
            const schema = func.parameters || { type: 'object' };

            let parameters = sanitizeSchema(schema);
            if (isGeminiModel) {
                parameters = cleanSchemaForGemini(parameters);
            }

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description,
                parameters
            };
        }).filter(Boolean);

        if (functionDeclarations.length > 0) {
            googleRequest.tools = [{ functionDeclarations }];
        }
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}

/**
 * Convert OpenAI request to internal Anthropic-like format for the cloudcode-client
 */
export function convertOpenAIToInternal(openaiRequest) {
    const {
        model,
        messages,
        max_tokens,
        temperature,
        top_p,
        stop,
        stream,
        tools
    } = openaiRequest;

    // Resolve model alias to actual model name
    const resolvedModel = resolveModelAlias(model);

    // Extract system message
    let system = null;
    const conversationMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system = system ? system + '\n\n' + msg.content : msg.content;
        } else if (msg.role === 'user') {
            conversationMessages.push({
                role: 'user',
                content: msg.content
            });
        } else if (msg.role === 'assistant') {
            const content = [];

            // Add text content
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }

            // Add tool calls
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.type === 'function') {
                        let input = {};
                        try {
                            input = JSON.parse(tc.function.arguments || '{}');
                        } catch (e) {
                            input = {};
                        }
                        content.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input
                        });
                    }
                }
            }

            conversationMessages.push({
                role: 'assistant',
                content: content.length > 0 ? content : msg.content
            });
        } else if (msg.role === 'tool') {
            // Tool response - find the matching assistant message and add tool_result
            conversationMessages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: msg.content
                }]
            });
        }
    }

    // Convert tools to Anthropic format
    let anthropicTools = null;
    if (tools && tools.length > 0) {
        anthropicTools = tools
            .filter(t => t.type === 'function')
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object' }
            }));
    }

    return {
        model: resolvedModel,
        messages: conversationMessages,
        max_tokens: max_tokens || 4096,
        temperature,
        top_p,
        stop_sequences: stop ? (Array.isArray(stop) ? stop : [stop]) : undefined,
        stream,
        system,
        tools: anthropicTools
    };
}
