/**
 * Proactive Token Refresh
 *
 * Addresses the "Token Drift" reliability issue by refreshing OAuth tokens
 * BEFORE they expire, rather than waiting for a 401 error mid-stream.
 *
 * The Problem:
 * - OAuth tokens expire after ~1 hour
 * - If a token expires mid-stream, the SSE connection drops
 * - User loses their current "thought" and must restart
 *
 * The Solution:
 * - Track token expiration times
 * - Proactively refresh tokens 2-5 minutes before expiry
 * - Background refresh during idle periods
 *
 * @module utils/proactive-token-refresh
 */

import { logger } from './logger.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * How many milliseconds before expiry to trigger refresh
 * Default: 5 minutes (300,000 ms)
 *
 * Pro-tip: 5 minutes gives more buffer for long-running requests
 * that might span the refresh window.
 */
const REFRESH_BUFFER_MS = parseInt(process.env.TOKEN_REFRESH_BUFFER_MS, 10) || 5 * 60 * 1000;

/**
 * Minimum token lifetime before we consider refreshing
 * Prevents refresh loops on very short-lived tokens
 */
const MIN_TOKEN_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Background refresh check interval
 */
const BACKGROUND_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

// =============================================================================
// TOKEN TRACKING
// =============================================================================

/**
 * Map of account email -> token metadata
 * @type {Map<string, TokenMetadata>}
 */
const tokenMetadata = new Map();

/**
 * @typedef {Object} TokenMetadata
 * @property {string} email - Account email
 * @property {number} issuedAt - When token was issued (ms timestamp)
 * @property {number} expiresAt - When token expires (ms timestamp)
 * @property {number} expiresIn - Original expires_in value (seconds)
 * @property {boolean} refreshScheduled - Whether refresh is already scheduled
 * @property {number|null} lastFailedAt - Timestamp of last failure (for backoff)
 * @property {number} consecutiveFailures - Number of consecutive failures
 */

/**
 * Backoff settings for failed refreshes
 */
const BACKOFF_BASE_MS = 60 * 1000;        // 1 minute base backoff
const BACKOFF_MAX_MS = 15 * 60 * 1000;    // 15 minutes max backoff
const BACKOFF_MULTIPLIER = 2;              // Exponential multiplier

/**
 * Background refresh timer reference
 * @type {NodeJS.Timer|null}
 */
let backgroundTimer = null;

/**
 * Reference to account manager (set during initialization)
 * @type {Object|null}
 */
let accountManagerRef = null;

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Record token metadata when a new token is obtained
 *
 * Call this after successfully getting a new token (from OAuth refresh).
 *
 * @param {string} email - Account email
 * @param {number} expiresIn - Token lifetime in seconds
 */
export function recordTokenIssued(email, expiresIn) {
    if (!email || !expiresIn) return;

    const now = Date.now();
    const expiresInMs = expiresIn * 1000;

    // Don't track very short-lived tokens
    if (expiresInMs < MIN_TOKEN_LIFETIME_MS) {
        logger.warn(`[TokenRefresh] Token for ${email} has very short lifetime: ${expiresIn}s`);
        return;
    }

    tokenMetadata.set(email, {
        email,
        issuedAt: now,
        expiresAt: now + expiresInMs,
        expiresIn,
        refreshScheduled: false,
        lastFailedAt: null,
        consecutiveFailures: 0
    });

    logger.debug(`[TokenRefresh] Recorded token for ${email}, expires in ${expiresIn}s`);
}

/**
 * Check if a token should be proactively refreshed
 *
 * @param {string} email - Account email
 * @returns {boolean} True if token should be refreshed now
 */
export function shouldRefreshToken(email) {
    const metadata = tokenMetadata.get(email);
    if (!metadata) return false;

    const now = Date.now();
    const timeUntilExpiry = metadata.expiresAt - now;

    // Token is already expired or will expire soon
    return timeUntilExpiry <= REFRESH_BUFFER_MS;
}

/**
 * Get time until token expires
 *
 * @param {string} email - Account email
 * @returns {number|null} Milliseconds until expiry, or null if unknown
 */
export function getTimeUntilExpiry(email) {
    const metadata = tokenMetadata.get(email);
    if (!metadata) return null;

    return Math.max(0, metadata.expiresAt - Date.now());
}

/**
 * Get token status for an account
 *
 * @param {string} email - Account email
 * @returns {{ status: string, expiresIn: number|null, shouldRefresh: boolean }}
 */
export function getTokenStatus(email) {
    const metadata = tokenMetadata.get(email);
    if (!metadata) {
        return { status: 'unknown', expiresIn: null, shouldRefresh: false };
    }

    const timeUntilExpiry = metadata.expiresAt - Date.now();

    if (timeUntilExpiry <= 0) {
        return { status: 'expired', expiresIn: 0, shouldRefresh: true };
    }

    if (timeUntilExpiry <= REFRESH_BUFFER_MS) {
        return { status: 'expiring_soon', expiresIn: timeUntilExpiry, shouldRefresh: true };
    }

    return { status: 'valid', expiresIn: timeUntilExpiry, shouldRefresh: false };
}

/**
 * Clear token metadata for an account
 *
 * Call this when token is invalidated or account is removed.
 *
 * @param {string} email - Account email, or null to clear all
 */
export function clearTokenMetadata(email = null) {
    if (email) {
        tokenMetadata.delete(email);
        logger.debug(`[TokenRefresh] Cleared metadata for ${email}`);
    } else {
        tokenMetadata.clear();
        logger.debug('[TokenRefresh] Cleared all token metadata');
    }
}

// =============================================================================
// BACKGROUND REFRESH
// =============================================================================

/**
 * Calculate backoff time based on consecutive failures
 *
 * @param {number} failures - Number of consecutive failures
 * @returns {number} Backoff time in milliseconds
 */
function calculateBackoff(failures) {
    if (failures === 0) return 0;
    const backoff = BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, failures - 1);
    return Math.min(backoff, BACKOFF_MAX_MS);
}

/**
 * Perform background refresh check
 *
 * Iterates through all tracked tokens and refreshes any that are
 * about to expire. This runs periodically in the background.
 * Implements exponential backoff for failed refresh attempts.
 */
async function backgroundRefreshCheck() {
    if (!accountManagerRef) return;

    const now = Date.now();
    let refreshedCount = 0;
    let skippedCount = 0;

    for (const [email, metadata] of tokenMetadata) {
        // Skip if refresh already scheduled
        if (metadata.refreshScheduled) continue;

        // Check backoff: skip if we failed recently and backoff time hasn't elapsed
        if (metadata.lastFailedAt && metadata.consecutiveFailures > 0) {
            const backoffMs = calculateBackoff(metadata.consecutiveFailures);
            const timeSinceFailure = now - metadata.lastFailedAt;

            if (timeSinceFailure < backoffMs) {
                const remainingBackoff = Math.round((backoffMs - timeSinceFailure) / 1000);
                logger.debug(`[TokenRefresh] Skipping ${email}: backoff (${remainingBackoff}s remaining, ${metadata.consecutiveFailures} failures)`);
                skippedCount++;
                continue;
            }
        }

        const timeUntilExpiry = metadata.expiresAt - now;

        // Check if we should refresh
        if (timeUntilExpiry > 0 && timeUntilExpiry <= REFRESH_BUFFER_MS) {
            metadata.refreshScheduled = true;

            try {
                logger.info(`[TokenRefresh] Proactively refreshing token for ${email} (expires in ${Math.round(timeUntilExpiry / 1000)}s)`);

                // Clear token cache to force refresh on next use
                accountManagerRef.clearTokenCache(email);

                // Get a fresh token (this triggers the refresh)
                const accounts = accountManagerRef.getAllAccounts();
                const account = accounts.find(a => a.email === email);

                if (account && account.enabled !== false && !account.isInvalid) {
                    await accountManagerRef.getTokenForAccount(account);
                    refreshedCount++;

                    // Reset failure tracking on success
                    metadata.lastFailedAt = null;
                    metadata.consecutiveFailures = 0;

                    logger.success(`[TokenRefresh] Successfully refreshed token for ${email}`);
                }
            } catch (error) {
                // Track failure for backoff
                metadata.lastFailedAt = now;
                metadata.consecutiveFailures = (metadata.consecutiveFailures || 0) + 1;
                const nextBackoff = Math.round(calculateBackoff(metadata.consecutiveFailures) / 1000);

                logger.error(`[TokenRefresh] Failed to refresh token for ${email} (attempt ${metadata.consecutiveFailures}, next retry in ${nextBackoff}s):`, error.message);
            } finally {
                metadata.refreshScheduled = false;
            }
        }
    }

    if (refreshedCount > 0 || skippedCount > 0) {
        logger.debug(`[TokenRefresh] Background check: ${refreshedCount} refreshed, ${skippedCount} skipped (backoff)`);
    }
}

/**
 * Start background token refresh monitoring
 *
 * @param {Object} accountManager - Account manager instance
 */
export function startBackgroundRefresh(accountManager) {
    if (backgroundTimer) {
        logger.warn('[TokenRefresh] Background refresh already running');
        return;
    }

    accountManagerRef = accountManager;

    // Initial check after short delay
    setTimeout(backgroundRefreshCheck, 5000);

    // Periodic checks
    backgroundTimer = setInterval(backgroundRefreshCheck, BACKGROUND_CHECK_INTERVAL_MS);

    // Don't let this timer keep the process alive
    if (backgroundTimer.unref) {
        backgroundTimer.unref();
    }

    logger.info('[TokenRefresh] Background refresh monitoring started');
}

/**
 * Stop background token refresh monitoring
 */
export function stopBackgroundRefresh() {
    if (backgroundTimer) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
        logger.info('[TokenRefresh] Background refresh monitoring stopped');
    }
}

// =============================================================================
// MIDDLEWARE / WRAPPER
// =============================================================================

/**
 * Wrap a function to perform proactive token refresh if needed
 *
 * Use this to wrap operations that require a fresh token.
 *
 * @param {Object} accountManager - Account manager instance
 * @param {Object} account - Account to check
 * @param {Function} operation - Async operation to perform
 * @returns {Promise<any>} Result of operation
 *
 * @example
 * const result = await withProactiveRefresh(accountManager, account, async () => {
 *   return await sendMessage(request);
 * });
 */
export async function withProactiveRefresh(accountManager, account, operation) {
    if (!account || !account.email) {
        return operation();
    }

    // Check if we should refresh first
    if (shouldRefreshToken(account.email)) {
        const status = getTokenStatus(account.email);
        logger.info(`[TokenRefresh] Proactive refresh for ${account.email} (${status.status})`);

        try {
            accountManager.clearTokenCache(account.email);
            await accountManager.getTokenForAccount(account);
        } catch (error) {
            logger.warn(`[TokenRefresh] Proactive refresh failed: ${error.message}`);
            // Continue anyway - the operation might still work or trigger normal refresh
        }
    }

    return operation();
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    recordTokenIssued,
    shouldRefreshToken,
    getTimeUntilExpiry,
    getTokenStatus,
    clearTokenMetadata,
    startBackgroundRefresh,
    stopBackgroundRefresh,
    withProactiveRefresh,
    REFRESH_BUFFER_MS
};
