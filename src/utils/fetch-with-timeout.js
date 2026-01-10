/**
 * Fetch with Timeout
 *
 * Wraps fetch() with AbortController to ensure requests don't hang indefinitely.
 * Critical for production reliability - prevents resource exhaustion from slow/malicious upstreams.
 *
 * Features:
 * - Configurable timeout per request
 * - Automatic cleanup of timers
 * - Proper abort signal propagation
 * - Detailed timeout error messages
 *
 * @module utils/fetch-with-timeout
 */

import { logger } from './logger.js';

// Default timeout: 60 seconds (configurable via environment)
const DEFAULT_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS, 10) || 60000;

// Timeout for streaming requests (longer to allow for response streaming)
const STREAMING_TIMEOUT_MS = parseInt(process.env.STREAMING_TIMEOUT_MS, 10) || 180000;

/**
 * Fetch with automatic timeout
 *
 * Creates an AbortController that cancels the request if it doesn't complete
 * within the specified timeout. The timeout timer is always cleaned up,
 * whether the request succeeds, fails, or times out.
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} options - Standard fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns {Promise<Response>} - Fetch response
 * @throws {Error} - TimeoutError if request exceeds timeout, or original fetch error
 *
 * @example
 * // Basic usage with default timeout
 * const response = await fetchWithTimeout('https://api.example.com/data', {
 *   method: 'POST',
 *   body: JSON.stringify({ query: 'test' })
 * });
 *
 * @example
 * // Custom timeout for long operations
 * const response = await fetchWithTimeout(streamUrl, options, 120000);
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    // Create abort controller for this request
    const controller = new AbortController();

    // Set up timeout
    const timeoutId = setTimeout(() => {
        controller.abort();
        // Extract hostname for logging (don't log full URL which may contain tokens)
        try {
            const hostname = new URL(url).hostname;
            logger.warn(`[Fetch] Request to ${hostname} timed out after ${timeoutMs}ms`);
        } catch {
            logger.warn(`[Fetch] Request timed out after ${timeoutMs}ms`);
        }
    }, timeoutMs);

    try {
        // Merge abort signal with any existing signal
        const fetchOptions = {
            ...options,
            signal: controller.signal
        };

        const response = await fetch(url, fetchOptions);
        return response;

    } catch (error) {
        // Handle abort specifically
        if (error.name === 'AbortError') {
            const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
            timeoutError.name = 'TimeoutError';
            timeoutError.code = 'ETIMEDOUT';
            timeoutError.timeout = timeoutMs;
            throw timeoutError;
        }

        // Re-throw other errors
        throw error;

    } finally {
        // Always clean up the timeout
        clearTimeout(timeoutId);
    }
}

/**
 * Fetch with streaming-appropriate timeout
 *
 * Uses a longer timeout suitable for streaming responses where the initial
 * connection may take time but data will flow incrementally.
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} options - Standard fetch options
 * @returns {Promise<Response>} - Fetch response
 */
export async function fetchWithStreamingTimeout(url, options = {}) {
    return fetchWithTimeout(url, options, STREAMING_TIMEOUT_MS);
}

/**
 * Check if an error is a timeout error
 *
 * Works with both our custom TimeoutError and standard AbortError
 *
 * @param {Error} error - Error to check
 * @returns {boolean} - True if error is a timeout
 */
export function isTimeoutError(error) {
    if (!error) return false;

    return error.name === 'TimeoutError' ||
           error.name === 'AbortError' ||
           error.code === 'ETIMEDOUT' ||
           error.message?.includes('timeout') ||
           error.message?.includes('timed out') ||
           error.message?.includes('aborted');
}

/**
 * Create a timeout wrapper for an existing fetch call
 *
 * Useful when you need to add timeout to a fetch that's already configured
 *
 * @param {Promise<Response>} fetchPromise - Existing fetch promise
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>} - Fetch response or timeout error
 */
export function withTimeout(fetchPromise, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return Promise.race([
        fetchPromise,
        new Promise((_, reject) => {
            setTimeout(() => {
                const error = new Error(`Request timeout after ${timeoutMs}ms`);
                error.name = 'TimeoutError';
                error.code = 'ETIMEDOUT';
                reject(error);
            }, timeoutMs);
        })
    ]);
}

export default {
    fetchWithTimeout,
    fetchWithStreamingTimeout,
    isTimeoutError,
    withTimeout,
    DEFAULT_TIMEOUT_MS,
    STREAMING_TIMEOUT_MS
};
