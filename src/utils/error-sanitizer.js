/**
 * Error Sanitizer
 *
 * Sanitizes error messages and responses to prevent information leakage.
 * In production, removes internal details while preserving useful error info.
 *
 * Security features:
 * - Redacts email addresses, IPs, tokens from error messages
 * - Masks internal endpoint URLs
 * - Removes file paths
 * - Provides consistent error response format
 *
 * @module utils/error-sanitizer
 */

import crypto from 'crypto';
import { logger } from './logger.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Whether we're in production mode (stricter sanitization) */
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Whether to include debug details in error responses */
const INCLUDE_DEBUG = process.env.ERROR_DEBUG === 'true' || !IS_PRODUCTION;

// =============================================================================
// REDACTION PATTERNS
// =============================================================================

/**
 * Patterns to redact from error messages
 * Order matters - more specific patterns should come first
 */
const REDACT_PATTERNS = [
    // Email addresses
    {
        pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        replacement: '[email]'
    },

    // OAuth tokens (Bearer ...)
    {
        pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
        replacement: 'Bearer [token]'
    },

    // Google API keys (AIza...)
    {
        pattern: /AIza[A-Za-z0-9_-]{35}/g,
        replacement: '[api-key]'
    },

    // Long alphanumeric strings (likely tokens/keys)
    {
        pattern: /\b[A-Za-z0-9]{40,}\b/g,
        replacement: '[credential]'
    },

    // IP addresses (IPv4)
    {
        pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
        replacement: '[ip]'
    },

    // IPv6 addresses (simplified pattern)
    {
        pattern: /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b/g,
        replacement: '[ipv6]'
    },

    // URLs with auth params
    {
        pattern: /\?[^"'\s]*(?:token|key|secret|password|auth|code)[^"'\s]*/gi,
        replacement: '?[params-redacted]'
    },

    // Internal endpoint URLs
    {
        pattern: /https?:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com[^\s"]*/g,
        replacement: '[cloud-api-endpoint]'
    },

    // File paths (Unix)
    {
        pattern: /\/(?:Users|home|var|etc|tmp)\/[^\s"']*/g,
        replacement: '[path]'
    },

    // File paths (Windows)
    {
        pattern: /[A-Za-z]:\\(?:Users|Program Files)[^\s"']*/g,
        replacement: '[path]'
    },

    // Project IDs
    {
        pattern: /projects?\/[a-zA-Z0-9-]+/g,
        replacement: 'project/[id]'
    },

    // Port numbers in URLs (potentially identifying)
    {
        pattern: /localhost:\d{4,5}/g,
        replacement: 'localhost:[port]'
    }
];

/**
 * Phrases to replace with sanitized versions
 */
const PHRASE_REPLACEMENTS = {
    'daily-cloudcode-pa.googleapis.com': '[cloud-api]',
    'cloudcode-pa.googleapis.com': '[cloud-api]',
    'Antigravity': 'the service',
    'antigravity': 'the service'
};

// =============================================================================
// SANITIZATION FUNCTIONS
// =============================================================================

/**
 * Sanitize an error message for external consumption
 *
 * Removes sensitive information while keeping the message useful.
 *
 * @param {string} message - Original error message
 * @returns {string} Sanitized message
 */
export function sanitizeErrorMessage(message) {
    if (!message || typeof message !== 'string') {
        return 'An error occurred';
    }

    let sanitized = message;

    // Apply pattern redactions
    for (const { pattern, replacement } of REDACT_PATTERNS) {
        sanitized = sanitized.replace(pattern, replacement);
    }

    // Apply phrase replacements
    for (const [search, replace] of Object.entries(PHRASE_REPLACEMENTS)) {
        sanitized = sanitized.split(search).join(replace);
    }

    // Clean up multiple consecutive redaction markers
    sanitized = sanitized.replace(/(\[(?:email|token|credential|path|ip|api-key)\]\s*)+/g, '[redacted] ');

    // Trim whitespace
    sanitized = sanitized.trim();

    // If message is completely empty or just redaction markers
    if (!sanitized || sanitized === '[redacted]' || sanitized.length < 5) {
        return 'An error occurred while processing your request';
    }

    return sanitized;
}

/**
 * Hash an email for pseudonymous identification
 *
 * Creates a short, consistent hash that can identify accounts
 * without exposing the actual email address.
 *
 * @param {string} email - Email to hash
 * @returns {string} Short hash (12 chars)
 */
function hashEmail(email) {
    if (!email) return 'unknown';
    return crypto
        .createHash('sha256')
        .update(email.toLowerCase().trim())
        .digest('hex')
        .substring(0, 12);
}

/**
 * Mask email for display
 *
 * Shows first letter and domain for some identifiability
 * while protecting the full email.
 *
 * @param {string} email - Email to mask
 * @returns {string} Masked email (e.g., "j***@example.com")
 */
function maskEmail(email) {
    if (!email || !email.includes('@')) return '***@***';
    const [local, domain] = email.split('@');
    const maskedLocal = local[0] + '***';
    return `${maskedLocal}@${domain}`;
}

/**
 * Sanitize an account object for API response
 *
 * Removes sensitive fields and optionally masks email.
 *
 * @param {Object} account - Account object
 * @param {Object} options - Sanitization options
 * @param {boolean} options.includeEmail - Show full email (default: false in prod)
 * @param {boolean} options.includeQuota - Include quota info
 * @returns {Object} Sanitized account object
 */
export function sanitizeAccountForResponse(account, options = {}) {
    if (!account) return null;

    const {
        includeEmail = !IS_PRODUCTION,
        includeQuota = true
    } = options;

    const sanitized = {
        // Identifier (hashed in prod, full email in dev)
        id: includeEmail ? account.email : hashEmail(account.email),

        // Display name (masked or full)
        displayName: includeEmail ? account.email : maskEmail(account.email),

        // Safe fields
        source: account.source || 'unknown',
        enabled: account.enabled !== false,
        isInvalid: account.isInvalid || false,
        lastUsed: account.lastUsed || null
    };

    // Include rate limit status (but not details)
    if (account.modelRateLimits) {
        sanitized.rateLimitedModels = Object.keys(account.modelRateLimits).filter(
            modelId => {
                const limit = account.modelRateLimits[modelId];
                return limit?.isRateLimited && limit.resetTime > Date.now();
            }
        );
    }

    // Include quota info if requested
    if (includeQuota && account.quota) {
        sanitized.quota = {
            tier: account.subscription?.tier || 'free',
            hasQuota: Object.keys(account.quota.models || {}).length > 0
        };
    }

    // Never include sensitive fields
    // Explicitly excluded: refreshToken, apiKey, dbPath, projectId (in prod)

    return sanitized;
}

// =============================================================================
// ERROR RESPONSE BUILDER
// =============================================================================

/**
 * Map of error patterns to response types
 */
const ERROR_TYPE_MAP = [
    {
        patterns: ['401', 'UNAUTHENTICATED', 'AUTH_INVALID', 'INVALID_GRANT'],
        type: 'authentication_error',
        status: 401,
        message: 'Authentication failed. Please check your credentials.'
    },
    {
        patterns: ['429', 'RESOURCE_EXHAUSTED', 'QUOTA', 'rate limit'],
        type: 'rate_limit_error',
        status: 429,
        message: 'Rate limit exceeded. Please try again later.'
    },
    {
        patterns: ['400', 'INVALID_ARGUMENT', 'invalid_request', 'validation'],
        type: 'invalid_request_error',
        status: 400,
        message: null  // Use sanitized original message
    },
    {
        patterns: ['timeout', 'DEADLINE_EXCEEDED', 'ETIMEDOUT', 'timed out'],
        type: 'timeout_error',
        status: 504,
        message: 'Request timed out. Please try again.'
    },
    {
        patterns: ['503', 'UNAVAILABLE', 'Service Unavailable'],
        type: 'service_unavailable',
        status: 503,
        message: 'Service temporarily unavailable. Please try again later.'
    },
    {
        patterns: ['404', 'NOT_FOUND'],
        type: 'not_found_error',
        status: 404,
        message: 'The requested resource was not found.'
    },
    {
        patterns: ['403', 'PERMISSION_DENIED', 'forbidden'],
        type: 'permission_error',
        status: 403,
        message: 'Permission denied.'
    }
];

/**
 * Create a production-safe error response
 *
 * Generates a consistent error response format suitable for API consumers.
 * Automatically determines error type, status code, and safe message.
 *
 * @param {Error} error - The original error
 * @param {Object} options - Options for error response
 * @param {boolean} options.includeDetails - Include internal details
 * @returns {{ statusCode: number, response: Object }} Safe error response
 */
export function createSafeErrorResponse(error, options = {}) {
    const { includeDetails = INCLUDE_DEBUG } = options;

    // Log full error internally (always)
    logger.error('[ErrorSanitizer] Error:', error.message);
    if (error.stack && !IS_PRODUCTION) {
        logger.debug('[ErrorSanitizer] Stack:', error.stack);
    }

    // Get error message
    const errorMessage = error.message || error.toString() || 'Unknown error';
    const upperMessage = errorMessage.toUpperCase();

    // Determine error type and response
    let errorType = 'api_error';
    let statusCode = 500;
    let userMessage = 'An internal error occurred';

    for (const mapping of ERROR_TYPE_MAP) {
        const matches = mapping.patterns.some(pattern =>
            upperMessage.includes(pattern.toUpperCase())
        );

        if (matches) {
            errorType = mapping.type;
            statusCode = mapping.status;
            userMessage = mapping.message || sanitizeErrorMessage(errorMessage);
            break;
        }
    }

    // Build response
    const response = {
        type: 'error',
        error: {
            type: errorType,
            message: userMessage
        }
    };

    // Include additional details in non-production
    if (includeDetails) {
        response.error.internal_message = sanitizeErrorMessage(errorMessage);

        // Include error code if available
        if (error.code) {
            response.error.code = error.code;
        }

        // Include retry info for rate limits
        if (errorType === 'rate_limit_error' && error.resetMs) {
            response.error.retry_after_ms = error.resetMs;
        }
    }

    return { statusCode, response };
}

/**
 * Create error response for validation failures
 *
 * @param {string[]} errors - Array of validation error messages
 * @returns {{ statusCode: number, response: Object }}
 */
export function createValidationErrorResponse(errors) {
    return {
        statusCode: 400,
        response: {
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: `Validation failed: ${errors[0]}`,
                details: INCLUDE_DEBUG ? errors : undefined
            }
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    sanitizeErrorMessage,
    sanitizeAccountForResponse,
    createSafeErrorResponse,
    createValidationErrorResponse,
    IS_PRODUCTION,
    INCLUDE_DEBUG
};
