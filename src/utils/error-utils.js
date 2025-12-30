import {
    RateLimitError,
    AuthError,
    NoAccountsError,
    MaxRetriesError,
    ApiError
} from '../errors.js';

/**
 * Common error types based on OpenAI documentation
 */
export const ErrorTypes = {
    INVALID_REQUEST: 'invalid_request_error',
    AUTHENTICATION: 'authentication_error',
    PERMISSION: 'permission_error',
    RATE_LIMIT: 'rate_limit_error',
    API_ERROR: 'api_error',
    OVERLOADED: 'server_overloaded_error'
};

/**
 * Format an error as an OpenAI-compatible JSON response
 * @param {Error|string} error - The error to format
 * @param {string} type - Default error type
 * @param {number} code - Default HTTP status code
 * @returns {Object} OpenAI error response object
 */
export function formatOpenAIError(error, type = ErrorTypes.API_ERROR, code = 500) {
    if (typeof error === 'string') {
        return { error: { message: error, type, code, param: null } };
    }

    let finalMessage = error.message;
    let finalType = type;
    let finalCode = code;

    // Map internal error classes to OpenAI types
    if (error instanceof RateLimitError) {
        finalType = ErrorTypes.RATE_LIMIT;
        finalCode = 429;
    } else if (error instanceof AuthError) {
        finalType = ErrorTypes.AUTHENTICATION;
        finalCode = 401;
    } else if (error instanceof NoAccountsError) {
        finalType = ErrorTypes.OVERLOADED;
        finalCode = 503;
    } else if (error instanceof MaxRetriesError) {
        finalType = ErrorTypes.API_ERROR;
        finalCode = 502;
    } else if (error instanceof ApiError) {
        finalType = error.errorType || ErrorTypes.API_ERROR;
        finalCode = error.statusCode || 500;
    }

    return {
        error: {
            message: finalMessage,
            type: finalType,
            code: finalCode,
            param: null
        }
    };
}

/**
 * Format an error as an OpenAI SSE error event
 * @param {Error|string} error - The error to format
 * @returns {string} SSE formatted error lines
 */
export function formatOpenAISStreamError(error) {
    const errorJson = formatOpenAIError(error);
    return `data: ${JSON.stringify(errorJson)}\n\ndata: [DONE]\n\n`;
}
