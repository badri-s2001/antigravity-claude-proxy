/**
 * Graceful Shutdown Handler
 *
 * Ensures clean shutdown of the server by:
 * - Handling SIGINT and SIGTERM signals
 * - Closing active HTTP connections
 * - Allowing in-flight requests to complete
 * - Cleaning up resources (caches, timers)
 * - Preventing "zombie" processes
 *
 * @module utils/graceful-shutdown
 */

import { logger } from './logger.js';

// =============================================================================
// STATE
// =============================================================================

/** Active HTTP server instance */
let server = null;

/** Set of active connections for tracking */
const activeConnections = new Set();

/** Whether shutdown is in progress */
let isShuttingDown = false;

/** Shutdown timeout (force kill after this) */
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30000;

// =============================================================================
// CONNECTION TRACKING
// =============================================================================

/**
 * Track an active connection
 * @param {Socket} socket - The socket connection
 */
function trackConnection(socket) {
    activeConnections.add(socket);

    socket.on('close', () => {
        activeConnections.delete(socket);
    });
}

/**
 * Get count of active connections
 * @returns {number}
 */
export function getActiveConnectionCount() {
    return activeConnections.size;
}

// =============================================================================
// SHUTDOWN LOGIC
// =============================================================================

/**
 * Initiate graceful shutdown
 *
 * @param {string} signal - The signal that triggered shutdown
 * @returns {Promise<void>}
 */
async function initiateShutdown(signal) {
    if (isShuttingDown) {
        logger.warn('[Shutdown] Already shutting down, ignoring signal');
        return;
    }

    isShuttingDown = true;
    logger.info(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

    // Set a hard timeout to force exit
    const forceExitTimer = setTimeout(() => {
        logger.error('[Shutdown] Forced exit after timeout');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Don't let this timer keep the process alive
    forceExitTimer.unref();

    try {
        // Step 1: Stop accepting new connections
        if (server) {
            logger.info('[Shutdown] Closing HTTP server...');
            await new Promise((resolve, reject) => {
                server.close((err) => {
                    if (err) {
                        logger.error('[Shutdown] Error closing server:', err);
                        reject(err);
                    } else {
                        logger.info('[Shutdown] HTTP server closed');
                        resolve();
                    }
                });
            });
        }

        // Step 2: Wait for active connections to complete
        const connectionCount = activeConnections.size;
        if (connectionCount > 0) {
            logger.info(`[Shutdown] Waiting for ${connectionCount} active connections...`);

            // Give connections time to complete, but don't wait forever
            const connectionTimeout = Math.min(SHUTDOWN_TIMEOUT_MS - 5000, 10000);

            await Promise.race([
                waitForConnections(),
                new Promise(resolve => setTimeout(resolve, connectionTimeout))
            ]);

            // Force close remaining connections
            if (activeConnections.size > 0) {
                logger.warn(`[Shutdown] Forcibly closing ${activeConnections.size} remaining connections`);
                for (const socket of activeConnections) {
                    socket.destroy();
                }
                activeConnections.clear();
            }
        }

        // Step 3: Run cleanup callbacks
        logger.info('[Shutdown] Running cleanup callbacks...');
        await runCleanupCallbacks();

        // Step 4: Exit cleanly
        logger.success('[Shutdown] Graceful shutdown complete');
        clearTimeout(forceExitTimer);
        process.exit(0);

    } catch (error) {
        logger.error('[Shutdown] Error during shutdown:', error);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
}

/**
 * Wait for all connections to close
 * @returns {Promise<void>}
 */
function waitForConnections() {
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (activeConnections.size === 0) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
    });
}

// =============================================================================
// CLEANUP CALLBACKS
// =============================================================================

/** Registered cleanup callbacks */
const cleanupCallbacks = [];

/**
 * Register a cleanup callback to run on shutdown
 *
 * @param {string} name - Name of the cleanup task
 * @param {Function} callback - Async callback to run
 */
export function onShutdown(name, callback) {
    cleanupCallbacks.push({ name, callback });
}

/**
 * Run all registered cleanup callbacks
 */
async function runCleanupCallbacks() {
    for (const { name, callback } of cleanupCallbacks) {
        try {
            logger.debug(`[Shutdown] Running cleanup: ${name}`);
            await callback();
        } catch (error) {
            logger.error(`[Shutdown] Error in cleanup '${name}':`, error);
        }
    }
}

// =============================================================================
// SETUP
// =============================================================================

/**
 * Set up graceful shutdown for an HTTP server
 *
 * Call this after creating your Express server.
 *
 * @param {http.Server} httpServer - The HTTP server instance
 *
 * @example
 * const app = express();
 * const server = app.listen(8080);
 * setupGracefulShutdown(server);
 */
export function setupGracefulShutdown(httpServer) {
    server = httpServer;

    // Track connections
    server.on('connection', trackConnection);

    // Handle signals
    process.on('SIGTERM', () => initiateShutdown('SIGTERM'));
    process.on('SIGINT', () => initiateShutdown('SIGINT'));

    // Handle uncaught errors (but don't exit - let the signal handler do it)
    process.on('uncaughtException', (error) => {
        logger.error('[Shutdown] Uncaught exception:', error);
        initiateShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('[Shutdown] Unhandled rejection:', reason);
        // Don't shutdown on unhandled rejection by default, just log
    });

    logger.info('[Shutdown] Graceful shutdown handlers registered');
}

/**
 * Check if shutdown is in progress
 * @returns {boolean}
 */
export function isShutdownInProgress() {
    return isShuttingDown;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    setupGracefulShutdown,
    onShutdown,
    isShutdownInProgress,
    getActiveConnectionCount
};
