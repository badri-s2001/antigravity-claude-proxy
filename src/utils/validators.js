/**
 * Request Validators
 *
 * JSON Schema validation for API requests using AJV.
 * Provides protection against:
 * - Malformed inputs
 * - Type coercion attacks
 * - Prototype pollution
 * - Resource exhaustion via oversized payloads
 *
 * @module utils/validators
 */

import { logger } from './logger.js';

// =============================================================================
// ALLOWED VALUES - Whitelist for security
// =============================================================================

/**
 * Whitelist of allowed model names
 * Models not in this list will be rejected
 */
const ALLOWED_MODELS = [
    // Claude thinking models
    'claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking',

    // Claude standard models
    'claude-sonnet-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',

    // Gemini models
    'gemini-3-flash',
    'gemini-3-pro-low',
    'gemini-3-pro-high',
    'gemini-2.5-flash-lite',

    // Extended context variants
    'gemini-2.5-flash-lite[1m]',
    'gemini-3-flash[1m]',
    'gemini-3-pro-high[1m]'
];

/**
 * Validation limits to prevent resource exhaustion
 */
const LIMITS = {
    MAX_MESSAGE_LENGTH: 2000000,      // 2MB per message content
    MAX_MESSAGES: 500,                 // Max messages in conversation
    MAX_BLOCKS_PER_MESSAGE: 1000,      // Max content blocks per message
    MAX_TOOLS: 100,                    // Max tool definitions
    MAX_TOOL_NAME_LENGTH: 256,         // Tool name length
    MAX_SYSTEM_PROMPT_LENGTH: 100000,  // 100KB system prompt
    MAX_TOKENS_UPPER: 200000,          // Max tokens upper bound
    MAX_TOKENS_DEFAULT: 8192,          // Default max_tokens (capped for Gemini)
    MAX_IMAGE_SIZE: 10000000,          // 10MB for base64 images
    MAX_SIGNATURE_LENGTH: 10000,       // Thinking signature max
    MIN_PASSWORD_LENGTH: 8             // Minimum password length
};

// =============================================================================
// PROTOTYPE POLLUTION DETECTION
// =============================================================================

/**
 * Keys that indicate prototype pollution attempts
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Check for prototype pollution attempts in an object
 *
 * Recursively scans object for dangerous keys that could modify
 * Object.prototype or other built-in prototypes.
 *
 * @param {any} obj - Object to check
 * @param {Set} seen - Set of already seen objects (cycle detection)
 * @param {number} depth - Current recursion depth
 * @returns {boolean} True if pollution attempt detected
 */
function hasPrototypePollution(obj, seen = new Set(), depth = 0) {
    // Prevent stack overflow from deeply nested objects
    if (depth > 50) {
        logger.warn('[Validator] Object too deeply nested, rejecting');
        return true;
    }

    if (obj === null || typeof obj !== 'object') {
        return false;
    }

    // Cycle detection
    if (seen.has(obj)) {
        return false;
    }
    seen.add(obj);

    // Check array elements
    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (hasPrototypePollution(item, seen, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    // Check object keys
    for (const key of Object.keys(obj)) {
        if (DANGEROUS_KEYS.includes(key)) {
            logger.warn(`[Validator] Prototype pollution attempt detected: ${key}`);
            return true;
        }

        // Recursively check nested objects
        if (hasPrototypePollution(obj[key], seen, depth + 1)) {
            return true;
        }
    }

    return false;
}

// =============================================================================
// TYPE VALIDATORS
// =============================================================================

/**
 * Validate that a value is a non-empty string
 */
function isNonEmptyString(value, maxLength = null) {
    if (typeof value !== 'string') return false;
    if (value.trim().length === 0) return false;
    if (maxLength && value.length > maxLength) return false;
    return true;
}

/**
 * Validate that a value is a positive integer within range
 */
function isPositiveInt(value, min = 1, max = Infinity) {
    if (typeof value !== 'number') return false;
    if (!Number.isInteger(value)) return false;
    if (value < min || value > max) return false;
    return true;
}

/**
 * Validate that a value is a number within range
 */
function isNumberInRange(value, min, max) {
    if (typeof value !== 'number') return false;
    if (Number.isNaN(value)) return false;
    if (value < min || value > max) return false;
    return true;
}

// =============================================================================
// MESSAGE CONTENT VALIDATORS
// =============================================================================

/**
 * Validate a text content block
 */
function validateTextBlock(block) {
    if (block.type !== 'text') return { valid: false, error: 'Invalid text block type' };
    if (typeof block.text !== 'string') return { valid: false, error: 'Text must be a string' };
    if (block.text.length > LIMITS.MAX_MESSAGE_LENGTH) {
        return { valid: false, error: `Text exceeds ${LIMITS.MAX_MESSAGE_LENGTH} character limit` };
    }
    return { valid: true };
}

/**
 * Validate an image content block
 */
function validateImageBlock(block) {
    if (block.type !== 'image') return { valid: false, error: 'Invalid image block type' };
    if (!block.source || typeof block.source !== 'object') {
        return { valid: false, error: 'Image source is required' };
    }

    const source = block.source;
    if (!['base64', 'url'].includes(source.type)) {
        return { valid: false, error: 'Image source type must be base64 or url' };
    }

    if (source.type === 'base64') {
        if (typeof source.data !== 'string') {
            return { valid: false, error: 'Image data must be a string' };
        }
        if (source.data.length > LIMITS.MAX_IMAGE_SIZE) {
            return { valid: false, error: 'Image exceeds 10MB size limit' };
        }
        if (source.media_type && !/^image\/(jpeg|png|gif|webp)$/.test(source.media_type)) {
            return { valid: false, error: 'Invalid image media type' };
        }
    }

    if (source.type === 'url') {
        if (typeof source.url !== 'string') {
            return { valid: false, error: 'Image URL must be a string' };
        }
        try {
            new URL(source.url);
        } catch {
            return { valid: false, error: 'Invalid image URL' };
        }
    }

    return { valid: true };
}

/**
 * Validate a tool_use content block
 */
function validateToolUseBlock(block) {
    if (block.type !== 'tool_use') return { valid: false, error: 'Invalid tool_use block type' };

    if (!isNonEmptyString(block.id, 128)) {
        return { valid: false, error: 'tool_use.id must be a non-empty string (max 128 chars)' };
    }

    if (!isNonEmptyString(block.name, LIMITS.MAX_TOOL_NAME_LENGTH)) {
        return { valid: false, error: 'tool_use.name must be a non-empty string' };
    }

    // Validate tool name format (alphanumeric, underscore, hyphen)
    if (!/^[a-zA-Z0-9_-]+$/.test(block.name)) {
        return { valid: false, error: 'tool_use.name contains invalid characters' };
    }

    // Input can be any object (tool-specific)
    if (block.input !== undefined && typeof block.input !== 'object') {
        return { valid: false, error: 'tool_use.input must be an object' };
    }

    return { valid: true };
}

/**
 * Validate a tool_result content block
 */
function validateToolResultBlock(block) {
    if (block.type !== 'tool_result') return { valid: false, error: 'Invalid tool_result block type' };

    if (!isNonEmptyString(block.tool_use_id, 128)) {
        return { valid: false, error: 'tool_result.tool_use_id must be a non-empty string' };
    }

    // Content can be string or array
    if (block.content !== undefined) {
        if (typeof block.content !== 'string' && !Array.isArray(block.content)) {
            return { valid: false, error: 'tool_result.content must be string or array' };
        }
    }

    if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
        return { valid: false, error: 'tool_result.is_error must be boolean' };
    }

    return { valid: true };
}

/**
 * Validate a thinking content block
 */
function validateThinkingBlock(block) {
    if (block.type !== 'thinking') return { valid: false, error: 'Invalid thinking block type' };

    if (typeof block.thinking !== 'string') {
        return { valid: false, error: 'thinking.thinking must be a string' };
    }

    if (block.signature !== undefined) {
        if (typeof block.signature !== 'string') {
            return { valid: false, error: 'thinking.signature must be a string' };
        }
        if (block.signature.length > LIMITS.MAX_SIGNATURE_LENGTH) {
            return { valid: false, error: 'thinking.signature exceeds maximum length' };
        }
    }

    return { valid: true };
}

/**
 * Validate a single content block
 */
function validateContentBlock(block) {
    if (!block || typeof block !== 'object') {
        return { valid: false, error: 'Content block must be an object' };
    }

    switch (block.type) {
        case 'text':
            return validateTextBlock(block);
        case 'image':
            return validateImageBlock(block);
        case 'document':
            return validateImageBlock(block); // Same structure as image
        case 'tool_use':
            return validateToolUseBlock(block);
        case 'tool_result':
            return validateToolResultBlock(block);
        case 'thinking':
        case 'redacted_thinking':
            return validateThinkingBlock(block);
        default:
            // Allow unknown block types (forward compatibility)
            return { valid: true };
    }
}

/**
 * Validate message content (string or array of blocks)
 */
function validateMessageContent(content) {
    // Simple string content
    if (typeof content === 'string') {
        if (content.length > LIMITS.MAX_MESSAGE_LENGTH) {
            return { valid: false, error: 'Message content exceeds maximum length' };
        }
        return { valid: true };
    }

    // Array of content blocks
    if (Array.isArray(content)) {
        if (content.length > LIMITS.MAX_BLOCKS_PER_MESSAGE) {
            return { valid: false, error: `Message has too many blocks (max ${LIMITS.MAX_BLOCKS_PER_MESSAGE})` };
        }

        for (let i = 0; i < content.length; i++) {
            const blockResult = validateContentBlock(content[i]);
            if (!blockResult.valid) {
                return { valid: false, error: `content[${i}]: ${blockResult.error}` };
            }
        }

        return { valid: true };
    }

    return { valid: false, error: 'Message content must be string or array' };
}

// =============================================================================
// MAIN VALIDATORS
// =============================================================================

/**
 * Validate a /v1/messages request
 *
 * Performs comprehensive validation including:
 * - Prototype pollution check
 * - Model whitelist validation
 * - Message structure validation
 * - Content block validation
 * - Parameter range validation
 *
 * @param {Object} body - Request body to validate
 * @returns {{ valid: boolean, errors: string[] | null, data?: Object }}
 */
export function validateMessages(body) {
    const errors = [];

    // Safety: Check for prototype pollution first
    if (hasPrototypePollution(body)) {
        return { valid: false, errors: ['Prototype pollution attempt detected'] };
    }

    // Required: messages array
    if (!body.messages) {
        errors.push('messages is required');
    } else if (!Array.isArray(body.messages)) {
        errors.push('messages must be an array');
    } else if (body.messages.length === 0) {
        errors.push('messages cannot be empty');
    } else if (body.messages.length > LIMITS.MAX_MESSAGES) {
        errors.push(`messages exceeds limit of ${LIMITS.MAX_MESSAGES}`);
    } else {
        // Validate each message
        for (let i = 0; i < body.messages.length; i++) {
            const msg = body.messages[i];

            if (!msg || typeof msg !== 'object') {
                errors.push(`messages[${i}]: must be an object`);
                continue;
            }

            if (!['user', 'assistant'].includes(msg.role)) {
                errors.push(`messages[${i}].role: must be 'user' or 'assistant'`);
            }

            if (msg.content === undefined) {
                errors.push(`messages[${i}].content: is required`);
            } else {
                const contentResult = validateMessageContent(msg.content);
                if (!contentResult.valid) {
                    errors.push(`messages[${i}].${contentResult.error}`);
                }
            }
        }
    }

    // Optional: model (whitelist check)
    if (body.model !== undefined) {
        if (typeof body.model !== 'string') {
            errors.push('model must be a string');
        } else if (!ALLOWED_MODELS.includes(body.model)) {
            errors.push(`model '${body.model}' is not allowed. Valid models: ${ALLOWED_MODELS.slice(0, 5).join(', ')}...`);
        }
    }

    // Optional: max_tokens (range check)
    if (body.max_tokens !== undefined) {
        if (!isPositiveInt(body.max_tokens, 1, LIMITS.MAX_TOKENS_UPPER)) {
            errors.push(`max_tokens must be integer between 1 and ${LIMITS.MAX_TOKENS_UPPER}`);
        }
    }

    // Optional: temperature
    if (body.temperature !== undefined) {
        if (!isNumberInRange(body.temperature, 0, 2)) {
            errors.push('temperature must be number between 0 and 2');
        }
    }

    // Optional: top_p
    if (body.top_p !== undefined) {
        if (!isNumberInRange(body.top_p, 0, 1)) {
            errors.push('top_p must be number between 0 and 1');
        }
    }

    // Optional: top_k
    if (body.top_k !== undefined) {
        if (!isPositiveInt(body.top_k, 1, 500)) {
            errors.push('top_k must be integer between 1 and 500');
        }
    }

    // Optional: stream
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        errors.push('stream must be a boolean');
    }

    // Optional: system prompt
    if (body.system !== undefined) {
        if (typeof body.system === 'string') {
            if (body.system.length > LIMITS.MAX_SYSTEM_PROMPT_LENGTH) {
                errors.push('system prompt exceeds maximum length');
            }
        } else if (Array.isArray(body.system)) {
            // Array of system blocks
            for (let i = 0; i < body.system.length; i++) {
                const block = body.system[i];
                if (block.type !== 'text' || typeof block.text !== 'string') {
                    errors.push(`system[${i}]: must be text block`);
                }
            }
        } else {
            errors.push('system must be string or array');
        }
    }

    // Optional: tools
    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) {
            errors.push('tools must be an array');
        } else if (body.tools.length > LIMITS.MAX_TOOLS) {
            errors.push(`tools exceeds limit of ${LIMITS.MAX_TOOLS}`);
        } else {
            for (let i = 0; i < body.tools.length; i++) {
                const tool = body.tools[i];
                if (!tool.name || typeof tool.name !== 'string') {
                    errors.push(`tools[${i}].name: must be a non-empty string`);
                } else if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) {
                    errors.push(`tools[${i}].name: contains invalid characters`);
                }
            }
        }
    }

    // Optional: thinking configuration
    if (body.thinking !== undefined) {
        if (typeof body.thinking !== 'object') {
            errors.push('thinking must be an object');
        } else if (body.thinking.budget_tokens !== undefined) {
            if (!isPositiveInt(body.thinking.budget_tokens, 1000, 100000)) {
                errors.push('thinking.budget_tokens must be integer between 1000 and 100000');
            }
        }
    }

    // Return result
    if (errors.length > 0) {
        return { valid: false, errors };
    }

    // Return validated data with applied defaults
    const validatedData = {
        ...body,
        stream: body.stream ?? false,
        max_tokens: Math.min(body.max_tokens ?? LIMITS.MAX_TOKENS_DEFAULT, LIMITS.MAX_TOKENS_DEFAULT)
    };

    return { valid: true, errors: null, data: validatedData };
}

/**
 * Get the list of allowed models
 * @returns {string[]}
 */
export function getAllowedModels() {
    return [...ALLOWED_MODELS];
}

/**
 * Check if a model is in the allowed list
 * @param {string} model
 * @returns {boolean}
 */
export function isAllowedModel(model) {
    return ALLOWED_MODELS.includes(model);
}

/**
 * Get validation limits
 * @returns {Object}
 */
export function getLimits() {
    return { ...LIMITS };
}

export default {
    validateMessages,
    getAllowedModels,
    isAllowedModel,
    getLimits,
    LIMITS
};
