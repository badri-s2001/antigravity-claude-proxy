/**
 * Thinking Signature Cache
 * 
 * Caches thinking block signatures to restore them in subsequent requests.
 * 
 * Problem: Claude Code doesn't preserve the 'signature' field when storing
 * assistant messages. When we receive a request with thinking blocks but no
 * signatures, we need to restore them from cache.
 * 
 * Solution: Cache thinking content → signature mapping on responses,
 * and restore signatures on requests.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// Cache TTL: 2 hours
const THINKING_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// Maximum cache size to prevent memory issues
const MAX_CACHE_SIZE = 500;

// Cache: hash → { signature, timestamp, prefix (first 100 chars for logging) }
const thinkingSignatureCache = new Map();

/**
 * Normalize thinking content for consistent hashing
 * @param {string} content - Thinking content
 * @returns {string} Normalized content
 */
function normalizeContent(content) {
    if (!content || typeof content !== 'string') return '';
    // Trim and normalize whitespace
    return content.trim();
}

/**
 * Hash thinking content for cache lookup
 * @param {string} content - Thinking content
 * @returns {string} SHA-256 hash
 */
function hashContent(content) {
    const normalized = normalizeContent(content);
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate a prefix hash for partial matching (first 500 chars)
 * @param {string} content - Thinking content
 * @returns {string} SHA-256 hash of prefix
 */
function hashPrefix(content) {
    const normalized = normalizeContent(content);
    const prefix = normalized.slice(0, 500);
    return 'prefix_' + crypto.createHash('sha256').update(prefix).digest('hex');
}

/**
 * Cache a thinking signature
 * @param {string} thinkingContent - The thinking block content
 * @param {string} signature - The signature to cache
 */
export function cacheThinkingSignature(thinkingContent, signature) {
    if (!thinkingContent || !signature) return;
    if (signature.length < 50) return; // Invalid signature

    const hash = hashContent(thinkingContent);
    const prefixHash = hashPrefix(thinkingContent);
    const preview = normalizeContent(thinkingContent).slice(0, 60);

    // Evict old entries if cache is too large
    if (thinkingSignatureCache.size >= MAX_CACHE_SIZE) {
        cleanupCache();
    }

    const entry = {
        signature,
        timestamp: Date.now(),
        preview: preview + '...'
    };

    // Cache both full hash and prefix hash
    thinkingSignatureCache.set(hash, entry);
    thinkingSignatureCache.set(prefixHash, entry);

    logger.debug(`[ThinkingCache] Cached signature for: "${preview}..."`);
}

/**
 * Get cached signature for thinking content
 * @param {string} thinkingContent - The thinking block content
 * @returns {string|null} The cached signature or null
 */
export function getCachedThinkingSignature(thinkingContent) {
    if (!thinkingContent) return null;

    const hash = hashContent(thinkingContent);
    let entry = thinkingSignatureCache.get(hash);

    // Try prefix match if exact match fails
    if (!entry) {
        const prefixHash = hashPrefix(thinkingContent);
        entry = thinkingSignatureCache.get(prefixHash);
        if (entry) {
            logger.debug(`[ThinkingCache] Found signature via prefix match`);
        }
    }

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > THINKING_CACHE_TTL_MS) {
        thinkingSignatureCache.delete(hash);
        return null;
    }

    logger.debug(`[ThinkingCache] Restored signature for: "${entry.preview}"`);
    return entry.signature;
}

/**
 * Clean up expired entries
 */
export function cleanupCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of thinkingSignatureCache) {
        if (now - entry.timestamp > THINKING_CACHE_TTL_MS) {
            thinkingSignatureCache.delete(key);
            cleaned++;
        }
    }

    // If still too large, remove oldest entries
    if (thinkingSignatureCache.size >= MAX_CACHE_SIZE) {
        const entries = Array.from(thinkingSignatureCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);

        const toRemove = entries.slice(0, Math.floor(MAX_CACHE_SIZE / 2));
        for (const [key] of toRemove) {
            thinkingSignatureCache.delete(key);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        logger.debug(`[ThinkingCache] Cleaned ${cleaned} expired entries`);
    }
}

/**
 * Get cache size (for debugging)
 * @returns {number} Number of entries
 */
export function getCacheSize() {
    return thinkingSignatureCache.size;
}

export default {
    cacheThinkingSignature,
    getCachedThinkingSignature,
    cleanupCache,
    getCacheSize
};
