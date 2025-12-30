/**
 * OpenAI Response Converter
 * Converts Google Generative AI responses to OpenAI Chat Completions format
 */

import crypto from 'crypto';
import {
    mapFinishReason,
    formatUsage,
    createMetadata,
    createReasoningDelta
} from '../utils/response-mapper.js';

/**
 * Convert internal/Anthropic response to OpenAI Chat Completions format
 *
 * @param {Object} anthropicResponse - Anthropic format response
 * @param {string} model - The model name used
 * @returns {Object} OpenAI Chat Completions format response
 */
export function convertToOpenAI(anthropicResponse, model) {
    const metadata = createMetadata();

    // Extract text and tool calls from content
    const content = anthropicResponse.content || [];
    let textContent = '';
    let thinkingContent = '';
    const toolCalls = [];

    for (const block of content) {
        if (block.type === 'text') {
            textContent += block.text || '';
        } else if (block.type === 'thinking' && block.thinking) {
            thinkingContent += block.thinking;
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            });
        }
    }

    const message = {
        role: 'assistant',
        content: textContent || null,
        ...createReasoningDelta(thinkingContent)
    };

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        if (!message.content) message.content = null;
    }

    const finishReason = mapFinishReason(anthropicResponse.stop_reason, toolCalls.length > 0);
    const usage = formatUsage(anthropicResponse.usage, thinkingContent);

    return {
        ...metadata,
        object: 'chat.completion',
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason
        }],
        usage
    };
}

/**
 * Create an OpenAI streaming chunk
 */
export function createStreamChunk(id, model, delta, finishReason = null) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }]
    };
}

/**
 * Generator that converts Anthropic SSE events to OpenAI streaming format
 */
export async function* streamToOpenAIFormat(anthropicEvents, model) {
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    let isFirstChunk = true;
    let currentToolCall = null;
    let toolCallIndex = 0;

    for await (const event of anthropicEvents) {
        // Init role
        if (isFirstChunk && event.type === 'message_start') {
            isFirstChunk = false;
            yield `data: ${JSON.stringify(createStreamChunk(id, model, { role: 'assistant' }))}\n\n`;
            continue;
        }

        // Handle blocks
        if (event.type === 'content_block_start') {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
                currentToolCall = {
                    index: toolCallIndex++,
                    id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                    type: 'function',
                    function: { name: block.name, arguments: '' }
                };
                yield `data: ${JSON.stringify(createStreamChunk(id, model, {
                    tool_calls: [{
                        index: currentToolCall.index,
                        id: currentToolCall.id,
                        type: 'function',
                        function: { name: currentToolCall.function.name, arguments: '' }
                    }]
                }))}\n\n`;
            }
            continue;
        }

        // Handle deltas
        if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
                yield `data: ${JSON.stringify(createStreamChunk(id, model, { content: delta.text }))}\n\n`;
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                yield `data: ${JSON.stringify(createStreamChunk(id, model, createReasoningDelta(delta.thinking)))}\n\n`;
            } else if (delta?.type === 'input_json_delta' && delta.partial_json && currentToolCall) {
                yield `data: ${JSON.stringify(createStreamChunk(id, model, {
                    tool_calls: [{
                        index: currentToolCall.index,
                        function: { arguments: delta.partial_json }
                    }]
                }))}\n\n`;
            }
            continue;
        }

        // Handle message delta
        if (event.type === 'message_delta') {
            const finishReason = mapFinishReason(event.delta?.stop_reason);
            const usage = event.usage ? formatUsage(event.usage) : undefined;
            const chunk = createStreamChunk(id, model, {}, finishReason);
            if (usage) chunk.usage = usage;
            yield `data: ${JSON.stringify(chunk)}\n\n`;
            continue;
        }

        if (event.type === 'message_stop') {
            yield 'data: [DONE]\n\n';
            continue;
        }
    }
}
