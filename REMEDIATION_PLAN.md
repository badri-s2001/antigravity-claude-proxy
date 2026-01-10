# Antigravity Claude Proxy - Comprehensive Remediation Plan

**Document Version:** 1.0
**Analysis Date:** 2026-01-11
**Prepared By:** Claude Opus 4.5 Ultrathink Analysis
**Estimated Total Effort:** 2-3 days

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Phase 1: Critical Security Fixes](#2-phase-1-critical-security-fixes)
3. [Phase 2: High Priority Security Fixes](#3-phase-2-high-priority-security-fixes)
4. [Phase 3: Code Quality Improvements](#4-phase-3-code-quality-improvements)
5. [Phase 4: Infrastructure Hardening](#5-phase-4-infrastructure-hardening)
6. [Phase 5: Testing & Verification](#6-phase-5-testing--verification)
7. [Implementation Checklist](#7-implementation-checklist)

---

## 1. Executive Summary

This remediation plan addresses **15 identified issues** across security, code quality, and infrastructure categories. Issues are prioritized by risk level and grouped into implementation phases.

### Priority Matrix

| Priority | Count | Estimated Effort |
|----------|-------|------------------|
| Critical | 3     | 2-3 hours        |
| High     | 5     | 4-6 hours        |
| Medium   | 5     | 4-6 hours        |
| Low      | 2     | 1-2 hours        |

### Risk Reduction Timeline

```
Day 1 (Morning):  Critical fixes → Reduce risk from HIGH to MEDIUM
Day 1 (Afternoon): High priority fixes → Reduce risk to LOW-MEDIUM
Day 2:            Code quality + Infrastructure → Production ready
```

---

## 2. Phase 1: Critical Security Fixes

### 2.1 Add Request Timeouts with AbortController

**Issue ID:** CRIT-001
**Severity:** CRITICAL
**Effort:** 1 hour
**Files Affected:**
- `src/cloudcode/message-handler.js`
- `src/cloudcode/streaming-handler.js`
- `src/cloudcode/request-builder.js` (new helper)

#### 2.1.1 Narrative

Currently, all `fetch()` calls to the Cloud Code API have no timeout mechanism. This creates a severe denial-of-service vulnerability where:

1. A malicious or malfunctioning upstream server could hold connections open indefinitely
2. Each hung connection consumes memory (pending Promise, request context)
3. Node.js can only handle ~16,000 concurrent connections by default
4. An attacker could exhaust server resources by triggering slow responses

The fix involves creating an `AbortController` with a timeout that automatically cancels requests after 60 seconds (configurable). We'll also add a helper function to centralize this logic.

#### 2.1.2 Step-by-Step Implementation

**Step 1:** Create a new utility file for fetch helpers.

Create file `src/utils/fetch-with-timeout.js`:

```javascript
/**
 * Fetch with Timeout
 *
 * Wraps fetch() with AbortController to ensure requests
 * don't hang indefinitely. Critical for production reliability.
 */

import { logger } from './logger.js';

// Default timeout: 60 seconds (configurable via environment)
const DEFAULT_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS, 10) || 60000;

/**
 * Fetch with automatic timeout
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns {Promise<Response>} - Fetch response
 * @throws {Error} - Throws if timeout exceeded or fetch fails
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        logger.warn(`[Fetch] Request to ${new URL(url).hostname} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Check if an error is a timeout error
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isTimeoutError(error) {
    return error.name === 'AbortError' ||
           error.message?.includes('Request timeout') ||
           error.message?.includes('timed out');
}

export default { fetchWithTimeout, isTimeoutError };
```

**Step 2:** Update `message-handler.js` to use the new timeout utility.

In `src/cloudcode/message-handler.js`, make these changes:

```javascript
// At the top of the file, add import:
import { fetchWithTimeout, isTimeoutError } from '../utils/fetch-with-timeout.js';

// Replace all occurrences of:
const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json'),
    body: JSON.stringify(payload)
});

// With:
const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json'),
    body: JSON.stringify(payload)
}, 60000); // 60 second timeout

// Also update the error handling to catch timeout errors:
// In the catch block around line 171-177, add:
} catch (endpointError) {
    if (isTimeoutError(endpointError)) {
        logger.warn(`[CloudCode] Request to ${endpoint} timed out, trying next...`);
        lastError = endpointError;
        continue;
    }
    if (isRateLimitError(endpointError)) {
        throw endpointError;
    }
    // ... rest of error handling
}
```

**Step 3:** Update `streaming-handler.js` similarly.

In `src/cloudcode/streaming-handler.js`:

```javascript
// Add import at top:
import { fetchWithTimeout, isTimeoutError } from '../utils/fetch-with-timeout.js';

// Replace fetch calls with fetchWithTimeout
// For streaming, use a longer timeout (120 seconds) since responses stream over time
const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: buildHeaders(token, model, 'text/event-stream'),
    body: JSON.stringify(payload)
}, 120000); // 2 minute timeout for streaming

// Update error handling similarly to message-handler.js
```

**Step 4:** Update credentials.js for project discovery.

In `src/account-manager/credentials.js`, update `discoverProject()`:

```javascript
// Add import:
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';

// In discoverProject function, replace:
const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {

// With:
const response = await fetchWithTimeout(`${endpoint}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({ ... })
}, 30000); // 30 second timeout for project discovery
```

#### 2.1.3 Verification

```bash
# Test that timeout works
# 1. Start a slow server (you can use netcat)
nc -l 8888 &

# 2. Configure proxy to use it (temporarily modify ANTIGRAVITY_ENDPOINT_FALLBACKS)
# 3. Make a request - should timeout after 60 seconds with clear error message

# 4. Run existing tests to ensure no regression
npm test
```

---

### 2.2 Remove Token Prefix Exposure

**Issue ID:** CRIT-002
**Severity:** CRITICAL
**Effort:** 10 minutes
**Files Affected:** `src/server.js`

#### 2.2.1 Narrative

The `/refresh-token` endpoint currently returns a preview of the refreshed token:

```javascript
tokenPrefix: token.substring(0, 10) + '...'
```

While this might seem helpful for debugging, it exposes information that could help attackers:
- Identify the token format/type
- Narrow down brute force attempts
- Fingerprint the authentication mechanism

Security best practice: Never expose any part of authentication tokens in API responses.

#### 2.2.2 Step-by-Step Implementation

**Step 1:** Modify `src/server.js` at line 524-529.

Find this code block:
```javascript
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            tokenPrefix: token.substring(0, 10) + '...'  // REMOVE THIS LINE
        });
```

**Replace with:**
```javascript
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        // Clear all caches
        accountManager.clearTokenCache();
        accountManager.clearProjectCache();
        // Force refresh default token
        await forceRefresh();

        // Log success internally but don't expose token details
        logger.info('[API] Token caches cleared and refreshed successfully');

        res.json({
            status: 'ok',
            message: 'Token caches cleared and refreshed',
            timestamp: new Date().toISOString()
        });
```

#### 2.2.3 Verification

```bash
# Test the endpoint
curl -X POST http://localhost:8080/refresh-token

# Expected response (should NOT contain tokenPrefix):
# {"status":"ok","message":"Token caches cleared and refreshed","timestamp":"2026-01-11T..."}

# Grep codebase for any other token exposure
grep -r "token.substring" src/
grep -r "tokenPrefix" src/
```

---

### 2.3 Fix WebUI Authentication Bypass

**Issue ID:** CRIT-003
**Severity:** CRITICAL
**Effort:** 30 minutes
**Files Affected:** `src/webui/index.js`

#### 2.3.1 Narrative

The current authentication middleware has two critical flaws:

1. **Unprotected `/api/config` endpoint:** This exposes server configuration to unauthenticated users
2. **Password accepted via query parameter:** This causes passwords to appear in logs, browser history, and proxy servers

The current problematic code:
```javascript
const isException = req.path === '/api/auth/url' || req.path === '/api/config';
// ...
const providedPassword = req.headers['x-webui-password'] || req.query.password;
```

#### 2.3.2 Step-by-Step Implementation

**Step 1:** Update the auth middleware in `src/webui/index.js`.

Find the `createAuthMiddleware` function (around line 104) and replace it entirely:

```javascript
/**
 * Auth Middleware - Password protection for WebUI
 *
 * Security improvements:
 * - Only accept password via header (not query param)
 * - Use timing-safe comparison to prevent timing attacks
 * - Minimal exception list (only OAuth URL generation)
 * - Add rate limiting for failed attempts
 */
import crypto from 'crypto';

// Track failed authentication attempts for rate limiting
const failedAttempts = new Map(); // IP -> { count, lastAttempt }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function createAuthMiddleware() {
    return (req, res, next) => {
        const password = config.webuiPassword;

        // If no password configured, allow all access
        if (!password) return next();

        // Only OAuth URL generation is publicly accessible
        // (needed to initiate OAuth flow before authentication)
        const isPublicEndpoint = req.path === '/api/auth/url';
        if (isPublicEndpoint) return next();

        // Determine if this path requires authentication
        const isApiRoute = req.path.startsWith('/api/');
        const isSensitiveEndpoint = req.path === '/account-limits' || req.path === '/health';
        const isProtected = isApiRoute || isSensitiveEndpoint;

        if (!isProtected) return next();

        // Check for rate limiting (by IP)
        const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
        const attempts = failedAttempts.get(clientIP);

        if (attempts && attempts.count >= MAX_FAILED_ATTEMPTS) {
            const timeSinceLockout = Date.now() - attempts.lastAttempt;
            if (timeSinceLockout < LOCKOUT_DURATION_MS) {
                const remainingMs = LOCKOUT_DURATION_MS - timeSinceLockout;
                const remainingMin = Math.ceil(remainingMs / 60000);
                logger.warn(`[WebUI] Rate limited IP ${clientIP} - ${remainingMin} minutes remaining`);
                return res.status(429).json({
                    status: 'error',
                    error: `Too many failed attempts. Try again in ${remainingMin} minutes.`
                });
            } else {
                // Lockout expired, reset counter
                failedAttempts.delete(clientIP);
            }
        }

        // SECURITY: Only accept password via header, NOT query parameter
        // Query parameters appear in logs, browser history, and referer headers
        const providedPassword = req.headers['x-webui-password'];

        if (!providedPassword) {
            return res.status(401).json({
                status: 'error',
                error: 'Authentication required. Provide password via X-WebUI-Password header.'
            });
        }

        // Use timing-safe comparison to prevent timing attacks
        // Convert to buffers of same length for comparison
        const passwordBuffer = Buffer.from(password, 'utf8');
        const providedBuffer = Buffer.from(providedPassword, 'utf8');

        // If lengths differ, comparison will fail but we still do constant-time check
        const lengthMatch = passwordBuffer.length === providedBuffer.length;

        // Pad shorter buffer to match lengths for timing-safe comparison
        const maxLength = Math.max(passwordBuffer.length, providedBuffer.length);
        const paddedPassword = Buffer.alloc(maxLength);
        const paddedProvided = Buffer.alloc(maxLength);
        passwordBuffer.copy(paddedPassword);
        providedBuffer.copy(paddedProvided);

        const isValid = lengthMatch && crypto.timingSafeEqual(paddedPassword, paddedProvided);

        if (!isValid) {
            // Track failed attempt
            const current = failedAttempts.get(clientIP) || { count: 0, lastAttempt: 0 };
            current.count++;
            current.lastAttempt = Date.now();
            failedAttempts.set(clientIP, current);

            logger.warn(`[WebUI] Failed auth attempt from ${clientIP} (${current.count}/${MAX_FAILED_ATTEMPTS})`);

            return res.status(401).json({
                status: 'error',
                error: 'Invalid password'
            });
        }

        // Successful auth - reset failed attempts
        failedAttempts.delete(clientIP);
        next();
    };
}

// Cleanup old failed attempt records periodically (every hour)
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of failedAttempts.entries()) {
        if (now - attempts.lastAttempt > LOCKOUT_DURATION_MS * 2) {
            failedAttempts.delete(ip);
        }
    }
}, 60 * 60 * 1000);
```

**Step 2:** Update the password change endpoint to also use timing-safe comparison.

Find the `/api/config/password` handler (around line 328) and update:

```javascript
app.post('/api/config/password', (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        // Validate input
        if (!newPassword || typeof newPassword !== 'string') {
            return res.status(400).json({
                status: 'error',
                error: 'New password is required'
            });
        }

        // Validate password strength
        if (newPassword.length < 8) {
            return res.status(400).json({
                status: 'error',
                error: 'Password must be at least 8 characters'
            });
        }

        // If current password exists, verify old password with timing-safe comparison
        if (config.webuiPassword) {
            if (!oldPassword) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Current password is required'
                });
            }

            const currentBuffer = Buffer.from(config.webuiPassword, 'utf8');
            const oldBuffer = Buffer.from(oldPassword, 'utf8');

            // Pad for timing-safe comparison
            const maxLength = Math.max(currentBuffer.length, oldBuffer.length);
            const paddedCurrent = Buffer.alloc(maxLength);
            const paddedOld = Buffer.alloc(maxLength);
            currentBuffer.copy(paddedCurrent);
            oldBuffer.copy(paddedOld);

            const lengthMatch = currentBuffer.length === oldBuffer.length;
            const isValid = lengthMatch && crypto.timingSafeEqual(paddedCurrent, paddedOld);

            if (!isValid) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Invalid current password'
                });
            }
        }

        // Save new password
        const success = saveConfig({ webuiPassword: newPassword });

        if (success) {
            // Update in-memory config
            config.webuiPassword = newPassword;
            logger.info('[WebUI] Password changed successfully');
            res.json({
                status: 'ok',
                message: 'Password changed successfully'
            });
        } else {
            throw new Error('Failed to save password to config file');
        }
    } catch (error) {
        logger.error('[WebUI] Error changing password:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});
```

**Step 3:** Add the crypto import at the top of webui/index.js if not present:

```javascript
import crypto from 'crypto';
```

#### 2.3.3 Verification

```bash
# Test 1: Verify /api/config now requires auth
curl http://localhost:8080/api/config
# Expected: 401 Unauthorized

# Test 2: Verify password in query param doesn't work
curl "http://localhost:8080/api/accounts?password=testpass"
# Expected: 401 (should not accept query param)

# Test 3: Verify header-based auth works
curl -H "X-WebUI-Password: testpass" http://localhost:8080/api/accounts
# Expected: 200 OK (if password matches)

# Test 4: Verify rate limiting after 5 failed attempts
for i in {1..6}; do
  curl -H "X-WebUI-Password: wrongpass" http://localhost:8080/api/accounts
done
# Expected: 429 Too Many Requests on 6th attempt

# Test 5: Verify OAuth URL still accessible without auth
curl http://localhost:8080/api/auth/url
# Expected: 200 OK with OAuth URL
```

---

## 3. Phase 2: High Priority Security Fixes

### 3.1 Add Input Validation Schema

**Issue ID:** HIGH-001
**Severity:** HIGH
**Effort:** 3-4 hours
**Files Affected:**
- `package.json` (add ajv dependency)
- `src/utils/validators.js` (new file)
- `src/server.js`

#### 3.1.1 Narrative

The `/v1/messages` endpoint currently performs minimal validation:

```javascript
if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({...});
}
```

This leaves the API vulnerable to:
- **Type coercion attacks:** Passing objects where strings expected
- **Prototype pollution:** Malicious `__proto__` properties in JSON
- **Resource exhaustion:** Extremely large payloads or deeply nested structures
- **Injection:** Malformed tool schemas or system prompts

We'll implement comprehensive JSON Schema validation using AJV (Another JSON Validator), which is fast and supports JSON Schema draft-07.

#### 3.1.2 Step-by-Step Implementation

**Step 1:** Install AJV dependency.

```bash
cd /Users/studio/antigravity-claude-proxy
npm install ajv ajv-formats
```

**Step 2:** Create the validators module.

Create file `src/utils/validators.js`:

```javascript
/**
 * Request Validators
 *
 * JSON Schema validation for API requests using AJV.
 * Provides protection against malformed inputs, type coercion attacks,
 * and resource exhaustion via oversized payloads.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { logger } from './logger.js';

// Initialize AJV with security-focused options
const ajv = new Ajv({
    allErrors: true,           // Report all errors, not just first
    removeAdditional: true,    // Remove properties not in schema
    useDefaults: true,         // Apply default values
    coerceTypes: false,        // Don't auto-coerce types (security)
    strict: true,              // Strict mode for better error detection
    validateFormats: true      // Validate format keywords
});

// Add format validators (email, uri, date-time, etc.)
addFormats(ajv);

// =============================================================================
// ALLOWED VALUES
// =============================================================================

// Whitelist of allowed model names
const ALLOWED_MODELS = [
    // Claude models
    'claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking',
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
    'gemini-2.5-flash-lite[1m]',
    'gemini-3-flash[1m]',
    'gemini-3-pro-high[1m]'
];

// =============================================================================
// SCHEMAS
// =============================================================================

/**
 * Schema for individual content blocks
 */
const contentBlockSchema = {
    type: 'object',
    oneOf: [
        // Text block
        {
            type: 'object',
            properties: {
                type: { const: 'text' },
                text: { type: 'string', maxLength: 1000000 }  // 1MB max per block
            },
            required: ['type', 'text'],
            additionalProperties: false
        },
        // Image block
        {
            type: 'object',
            properties: {
                type: { const: 'image' },
                source: {
                    type: 'object',
                    properties: {
                        type: { enum: ['base64', 'url'] },
                        media_type: { type: 'string', pattern: '^image/(jpeg|png|gif|webp)$' },
                        data: { type: 'string', maxLength: 10000000 },  // 10MB max
                        url: { type: 'string', format: 'uri', maxLength: 2048 }
                    },
                    required: ['type'],
                    additionalProperties: false
                }
            },
            required: ['type', 'source'],
            additionalProperties: false
        },
        // Tool use block
        {
            type: 'object',
            properties: {
                type: { const: 'tool_use' },
                id: { type: 'string', maxLength: 128 },
                name: { type: 'string', maxLength: 256, pattern: '^[a-zA-Z0-9_-]+$' },
                input: { type: 'object' },
                thoughtSignature: { type: 'string' }  // For Gemini
            },
            required: ['type', 'id', 'name'],
            additionalProperties: false
        },
        // Tool result block
        {
            type: 'object',
            properties: {
                type: { const: 'tool_result' },
                tool_use_id: { type: 'string', maxLength: 128 },
                content: {
                    oneOf: [
                        { type: 'string', maxLength: 1000000 },
                        { type: 'array', items: { type: 'object' }, maxItems: 100 }
                    ]
                },
                is_error: { type: 'boolean' }
            },
            required: ['type', 'tool_use_id'],
            additionalProperties: false
        },
        // Thinking block
        {
            type: 'object',
            properties: {
                type: { const: 'thinking' },
                thinking: { type: 'string', maxLength: 500000 },
                signature: { type: 'string', maxLength: 10000 }
            },
            required: ['type', 'thinking'],
            additionalProperties: false
        }
    ]
};

/**
 * Schema for a single message
 */
const messageSchema = {
    type: 'object',
    properties: {
        role: { enum: ['user', 'assistant'] },
        content: {
            oneOf: [
                { type: 'string', maxLength: 2000000 },  // Simple text
                {
                    type: 'array',
                    items: contentBlockSchema,
                    maxItems: 1000  // Max blocks per message
                }
            ]
        }
    },
    required: ['role', 'content'],
    additionalProperties: false
};

/**
 * Schema for tool definitions
 */
const toolSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', maxLength: 256, pattern: '^[a-zA-Z0-9_-]+$' },
        description: { type: 'string', maxLength: 10000 },
        input_schema: { type: 'object' }  // JSON Schema
    },
    required: ['name'],
    additionalProperties: true  // Allow custom properties
};

/**
 * Main schema for /v1/messages request
 */
const messagesRequestSchema = {
    type: 'object',
    properties: {
        // Model - must be from whitelist
        model: {
            type: 'string',
            enum: ALLOWED_MODELS,
            errorMessage: 'Model must be one of the allowed models'
        },

        // Messages array - required
        messages: {
            type: 'array',
            items: messageSchema,
            minItems: 1,
            maxItems: 500  // Reasonable limit for conversation length
        },

        // Streaming flag
        stream: { type: 'boolean', default: false },

        // System prompt
        system: {
            oneOf: [
                { type: 'string', maxLength: 100000 },  // 100KB max system prompt
                {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            type: { const: 'text' },
                            text: { type: 'string', maxLength: 100000 }
                        }
                    },
                    maxItems: 10
                }
            ]
        },

        // Max tokens to generate
        max_tokens: {
            type: 'integer',
            minimum: 1,
            maximum: 200000,
            default: 4096
        },

        // Sampling parameters
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        top_p: { type: 'number', minimum: 0, maximum: 1 },
        top_k: { type: 'integer', minimum: 1, maximum: 500 },

        // Stop sequences
        stop_sequences: {
            type: 'array',
            items: { type: 'string', maxLength: 100 },
            maxItems: 10
        },

        // Tools
        tools: {
            type: 'array',
            items: toolSchema,
            maxItems: 100  // Max tools per request
        },

        // Tool choice
        tool_choice: {
            oneOf: [
                { const: 'auto' },
                { const: 'any' },
                { const: 'none' },
                {
                    type: 'object',
                    properties: {
                        type: { const: 'tool' },
                        name: { type: 'string', maxLength: 256 }
                    }
                }
            ]
        },

        // Thinking configuration
        thinking: {
            type: 'object',
            properties: {
                type: { const: 'enabled' },
                budget_tokens: { type: 'integer', minimum: 1000, maximum: 100000 }
            },
            additionalProperties: false
        }
    },
    required: ['messages'],
    additionalProperties: false
};

// Compile the schema
const validateMessagesRequest = ajv.compile(messagesRequestSchema);

/**
 * Validate a /v1/messages request
 *
 * @param {Object} body - Request body to validate
 * @returns {{ valid: boolean, errors: Array<string> | null }} Validation result
 */
export function validateMessages(body) {
    // Deep clone to prevent mutation
    const data = JSON.parse(JSON.stringify(body));

    // Check for prototype pollution attempts
    if (hasPrototypePollution(data)) {
        return {
            valid: false,
            errors: ['Prototype pollution attempt detected']
        };
    }

    const valid = validateMessagesRequest(data);

    if (!valid) {
        const errors = validateMessagesRequest.errors.map(err => {
            const path = err.instancePath || 'root';
            return `${path}: ${err.message}`;
        });
        return { valid: false, errors };
    }

    return { valid: true, errors: null, data };
}

/**
 * Check for prototype pollution attempts in an object
 *
 * @param {any} obj - Object to check
 * @param {Set} seen - Set of already seen objects (cycle detection)
 * @returns {boolean} True if pollution attempt detected
 */
function hasPrototypePollution(obj, seen = new Set()) {
    if (obj === null || typeof obj !== 'object') {
        return false;
    }

    // Cycle detection
    if (seen.has(obj)) {
        return false;
    }
    seen.add(obj);

    // Check for dangerous keys
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

    for (const key of Object.keys(obj)) {
        if (dangerousKeys.includes(key)) {
            logger.warn(`[Validator] Prototype pollution attempt detected: ${key}`);
            return true;
        }

        // Recursively check nested objects
        if (hasPrototypePollution(obj[key], seen)) {
            return true;
        }
    }

    return false;
}

/**
 * Get allowed models list (for error messages)
 * @returns {string[]}
 */
export function getAllowedModels() {
    return [...ALLOWED_MODELS];
}

/**
 * Check if a model is allowed
 * @param {string} model
 * @returns {boolean}
 */
export function isAllowedModel(model) {
    return ALLOWED_MODELS.includes(model);
}

export default {
    validateMessages,
    getAllowedModels,
    isAllowedModel
};
```

**Step 3:** Integrate validation into server.js.

In `src/server.js`, add the import and validation:

```javascript
// Add import at top
import { validateMessages, getAllowedModels } from './utils/validators.js';

// In the /v1/messages handler, replace the simple validation with:
app.post('/v1/messages', async (req, res) => {
    try {
        // Ensure account manager is initialized
        await ensureInitialized();

        // ===========================================
        // INPUT VALIDATION
        // ===========================================
        const validation = validateMessages(req.body);

        if (!validation.valid) {
            logger.warn('[API] Request validation failed:', validation.errors);
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: `Validation failed: ${validation.errors.join('; ')}`,
                    details: validation.errors
                }
            });
        }

        // Use validated/sanitized data
        const {
            model,
            messages,
            stream,
            system,
            max_tokens,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = validation.data || req.body;

        // ... rest of handler
```

#### 3.1.3 Verification

```bash
# Test 1: Valid request should work
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5-thinking","messages":[{"role":"user","content":"Hello"}]}'
# Expected: 200 OK

# Test 2: Invalid model should fail
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"evil-model","messages":[{"role":"user","content":"test"}]}'
# Expected: 400 with "Validation failed: model must be one of..."

# Test 3: Prototype pollution should fail
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test","__proto__":{"polluted":true}}]}'
# Expected: 400 with "Prototype pollution attempt detected"

# Test 4: Missing required field
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5-thinking"}'
# Expected: 400 with "messages is required"

# Test 5: Type mismatch
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"messages":"not an array"}'
# Expected: 400 with "messages must be array"
```

---

### 3.2 Sanitize Error Messages for Production

**Issue ID:** HIGH-002
**Severity:** HIGH
**Effort:** 1 hour
**Files Affected:** `src/server.js`, `src/utils/error-sanitizer.js` (new)

#### 3.2.1 Narrative

Error messages currently expose internal implementation details:
- Account emails in health check responses
- Token prefixes in refresh responses
- Endpoint URLs in error messages
- Stack traces in development mode

This information helps attackers understand the system architecture and craft targeted attacks.

#### 3.2.2 Step-by-Step Implementation

**Step 1:** Create error sanitizer utility.

Create file `src/utils/error-sanitizer.js`:

```javascript
/**
 * Error Sanitizer
 *
 * Sanitizes error messages and responses to prevent information leakage.
 * In production, removes internal details while preserving useful error info.
 */

import { logger } from './logger.js';

// Whether we're in production mode
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Patterns to redact from error messages
const REDACT_PATTERNS = [
    // Email addresses
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

    // IP addresses
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,

    // OAuth tokens (Bearer ...)
    /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,

    // API keys (common patterns)
    /[a-zA-Z0-9]{32,}/g,

    // URLs with tokens/keys in query params
    /\?[^"'\s]*(?:token|key|secret|password|auth)[^"'\s]*/gi,

    // Internal endpoint URLs
    /https?:\/\/(?:daily-cloudcode|cloudcode)-pa\.googleapis\.com[^\s]*/g,

    // File paths
    /\/(?:Users|home|var|etc)\/[^\s"']*/g,

    // Project IDs
    /projects?\/[a-zA-Z0-9-]+/g
];

// Generic replacements for known internal details
const REPLACEMENTS = {
    'daily-cloudcode-pa.googleapis.com': '[cloud-api]',
    'cloudcode-pa.googleapis.com': '[cloud-api]',
    'Antigravity': 'the service'
};

/**
 * Sanitize an error message for external consumption
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
    for (const pattern of REDACT_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
    }

    // Apply known replacements
    for (const [search, replace] of Object.entries(REPLACEMENTS)) {
        sanitized = sanitized.split(search).join(replace);
    }

    // Remove duplicate [REDACTED] markers
    sanitized = sanitized.replace(/(\[REDACTED\]\s*)+/g, '[REDACTED] ');

    // Trim and clean up
    sanitized = sanitized.trim();

    // If message is completely redacted, provide generic error
    if (sanitized === '[REDACTED]' || sanitized.length < 10) {
        sanitized = 'An error occurred while processing your request';
    }

    return sanitized;
}

/**
 * Sanitize an account object for API response
 *
 * @param {Object} account - Account object
 * @param {boolean} includeEmail - Whether to include email (default: false in production)
 * @returns {Object} Sanitized account
 */
export function sanitizeAccountForResponse(account, includeEmail = !IS_PRODUCTION) {
    if (!account) return null;

    const sanitized = {
        // Use hash of email instead of full email in production
        id: includeEmail ? account.email : hashEmail(account.email),
        displayName: includeEmail ? account.email : maskEmail(account.email),
        source: account.source,
        enabled: account.enabled !== false,
        isInvalid: account.isInvalid || false,
        lastUsed: account.lastUsed
    };

    // Include quota info but not sensitive details
    if (account.modelRateLimits) {
        sanitized.rateLimited = Object.keys(account.modelRateLimits).filter(
            modelId => account.modelRateLimits[modelId]?.isRateLimited
        );
    }

    return sanitized;
}

/**
 * Hash email for pseudonymous identification
 */
function hashEmail(email) {
    if (!email) return 'unknown';
    const crypto = require('crypto');
    return crypto.createHash('sha256')
        .update(email.toLowerCase())
        .digest('hex')
        .substring(0, 12);
}

/**
 * Mask email for display (show first letter and domain)
 */
function maskEmail(email) {
    if (!email || !email.includes('@')) return '***@***';
    const [local, domain] = email.split('@');
    return `${local[0]}***@${domain}`;
}

/**
 * Create a production-safe error response
 *
 * @param {Error} error - The original error
 * @param {Object} options - Options for error response
 * @returns {Object} Safe error response object
 */
export function createSafeErrorResponse(error, options = {}) {
    const { includeDetails = !IS_PRODUCTION } = options;

    // Log full error internally
    logger.error('[ErrorSanitizer] Original error:', error.message);
    if (error.stack && IS_PRODUCTION === false) {
        logger.debug('[ErrorSanitizer] Stack:', error.stack);
    }

    // Determine error type and code
    let errorType = 'api_error';
    let statusCode = 500;
    let userMessage = 'An internal error occurred';

    const msg = error.message || '';

    if (msg.includes('401') || msg.includes('UNAUTHENTICATED') || msg.includes('AUTH_INVALID')) {
        errorType = 'authentication_error';
        statusCode = 401;
        userMessage = 'Authentication failed. Please check your credentials.';
    } else if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('QUOTA')) {
        errorType = 'rate_limit_error';
        statusCode = 429;
        userMessage = 'Rate limit exceeded. Please try again later.';
    } else if (msg.includes('400') || msg.includes('INVALID_ARGUMENT') || msg.includes('invalid_request')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        userMessage = sanitizeErrorMessage(msg);
    } else if (msg.includes('timeout') || msg.includes('DEADLINE_EXCEEDED')) {
        errorType = 'timeout_error';
        statusCode = 504;
        userMessage = 'Request timed out. Please try again.';
    } else if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
        errorType = 'service_unavailable';
        statusCode = 503;
        userMessage = 'Service temporarily unavailable. Please try again later.';
    }

    const response = {
        type: 'error',
        error: {
            type: errorType,
            message: userMessage
        }
    };

    // Include additional details in non-production
    if (includeDetails) {
        response.error.internal_message = sanitizeErrorMessage(msg);
    }

    return { statusCode, response };
}

export default {
    sanitizeErrorMessage,
    sanitizeAccountForResponse,
    createSafeErrorResponse
};
```

**Step 2:** Update health endpoint to use sanitized account info.

In `src/server.js`, update the `/health` endpoint:

```javascript
// Add import
import { sanitizeAccountForResponse } from './utils/error-sanitizer.js';

// In the /health handler, update the account mapping:
const detailedAccounts = accountDetails.map((result, index) => {
    const acc = allAccounts[index];
    const baseData = result.status === 'fulfilled' ? result.value : {
        status: 'error',
        error: 'Failed to fetch details'
    };

    // Sanitize account info
    return {
        ...sanitizeAccountForResponse(acc),
        ...baseData
    };
});
```

**Step 3:** Update the parseError function in server.js:

```javascript
import { createSafeErrorResponse, sanitizeErrorMessage } from './utils/error-sanitizer.js';

// Replace parseError function with:
function parseError(error) {
    return createSafeErrorResponse(error);
}

// Then in error handlers, use:
const { statusCode, response } = parseError(error);
res.status(statusCode).json(response);
```

---

## 4. Phase 3: Code Quality Improvements

### 4.1 Extract Shared Retry Logic (DRY Refactoring)

**Issue ID:** MED-001
**Severity:** MEDIUM
**Effort:** 2 hours
**Files Affected:**
- `src/cloudcode/retry-handler.js` (new file)
- `src/cloudcode/message-handler.js`
- `src/cloudcode/streaming-handler.js`

#### 4.1.1 Narrative

Currently, `message-handler.js` and `streaming-handler.js` contain nearly identical code for:
- Account selection with sticky preference
- Rate limit waiting logic
- Endpoint failover
- Error classification and handling

This violates the DRY (Don't Repeat Yourself) principle and makes maintenance difficult. Any bug fix or improvement must be applied twice.

#### 4.1.2 Step-by-Step Implementation

**Step 1:** Create the shared retry handler module.

Create file `src/cloudcode/retry-handler.js`:

```javascript
/**
 * Retry Handler
 *
 * Provides shared retry/failover logic for Cloud Code operations.
 * Extracted from message-handler.js and streaming-handler.js to eliminate
 * code duplication and ensure consistent behavior.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MAX_RETRIES,
    MAX_WAIT_BEFORE_ERROR_MS
} from '../constants.js';
import { isRateLimitError, isAuthError } from '../errors.js';
import { formatDuration, sleep, isNetworkError } from '../utils/helpers.js';
import { isTimeoutError } from '../utils/fetch-with-timeout.js';
import { logger } from '../utils/logger.js';
import { parseResetTime } from './rate-limit-parser.js';
import { getFallbackModel } from '../fallback-config.js';

/**
 * @typedef {Object} RetryContext
 * @property {Object} account - The selected account
 * @property {string} token - OAuth access token
 * @property {string} project - Project ID
 * @property {string} endpoint - Current endpoint URL
 * @property {number} attempt - Current attempt number
 */

/**
 * @typedef {Object} RetryOptions
 * @property {string} model - Model name
 * @property {Object} accountManager - Account manager instance
 * @property {boolean} fallbackEnabled - Whether model fallback is enabled
 * @property {string} operationType - 'stream' or 'message' (for logging)
 */

/**
 * Execute an operation with retry and account failover
 *
 * This generator handles:
 * - Sticky account selection for cache continuity
 * - Waiting for short rate limits (<2 min)
 * - Switching accounts for long rate limits
 * - Endpoint failover (daily -> prod)
 * - Model fallback when all accounts exhausted
 *
 * @param {RetryOptions} options - Retry configuration
 * @param {Function} operation - Async operation to execute
 *   Receives (context: RetryContext) and should return result or throw
 * @yields {RetryContext} Context for each attempt (for streaming operations)
 * @returns {Promise<any>} Result from successful operation
 * @throws {Error} If all retries exhausted
 */
export async function* withRetry(options, operation) {
    const { model, accountManager, fallbackEnabled, operationType = 'request' } = options;

    // Calculate max attempts based on account count
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // === ACCOUNT SELECTION ===
        const { account, waitMs } = await selectAccount(model, accountManager, attempt);

        if (!account) {
            // Try fallback model if enabled
            if (fallbackEnabled) {
                const fallbackResult = yield* attemptFallback(model, accountManager, operation, operationType);
                if (fallbackResult !== null) {
                    return fallbackResult;
                }
            }
            throw new Error('No accounts available');
        }

        // === EXECUTE OPERATION ===
        try {
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);

            // Yield context for streaming operations to use
            const context = { account, token, project, attempt };

            // Try each endpoint
            for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                context.endpoint = endpoint;

                try {
                    const result = await operation(context);
                    return result;
                } catch (endpointError) {
                    const errorHandled = handleEndpointError(
                        endpointError,
                        endpoint,
                        account,
                        model,
                        accountManager
                    );

                    if (errorHandled.rethrow) {
                        throw errorHandled.error;
                    }
                    // Continue to next endpoint
                }
            }

            // All endpoints failed for this account
            throw new Error(`All endpoints failed for ${account.email}`);

        } catch (error) {
            const shouldContinue = handleAccountError(error, account, model, accountManager, operationType);
            if (shouldContinue) {
                continue;
            }
            throw error;
        }
    }

    // All retries exhausted - try fallback
    if (fallbackEnabled) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(`[Retry] All retries exhausted for ${model}. Attempting fallback to ${fallbackModel}`);
            // Caller should handle fallback by calling again with new model
            throw new Error(`FALLBACK_NEEDED:${fallbackModel}`);
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Select an account with sticky preference and rate limit handling
 */
async function selectAccount(model, accountManager, attempt) {
    const { account: stickyAccount, waitMs } = accountManager.pickStickyAccount(model);
    let account = stickyAccount;

    // Handle waiting for sticky account
    if (!account && waitMs > 0) {
        logger.info(`[Retry] Waiting ${formatDuration(waitMs)} for sticky account...`);
        await sleep(waitMs);
        accountManager.clearExpiredLimits();
        account = accountManager.getCurrentStickyAccount(model);
    }

    // Handle all accounts rate-limited
    if (!account && accountManager.isAllRateLimited(model)) {
        const allWaitMs = accountManager.getMinWaitTimeMs(model);
        const resetTime = new Date(Date.now() + allWaitMs).toISOString();

        // If wait time is too long (> 2 minutes), throw error immediately
        if (allWaitMs > MAX_WAIT_BEFORE_ERROR_MS) {
            throw new Error(
                `RESOURCE_EXHAUSTED: Rate limited on ${model}. ` +
                `Quota will reset after ${formatDuration(allWaitMs)}. ` +
                `Next available: ${resetTime}`
            );
        }

        // Wait for reset
        const accountCount = accountManager.getAccountCount();
        logger.warn(`[Retry] All ${accountCount} account(s) rate-limited. Waiting ${formatDuration(allWaitMs)}...`);
        await sleep(allWaitMs);
        await sleep(500); // Buffer
        accountManager.clearExpiredLimits();
        account = accountManager.pickNext(model);

        // Optimistic reset if still no account
        if (!account) {
            logger.warn('[Retry] No account available after wait, attempting optimistic reset...');
            accountManager.resetAllRateLimits();
            account = accountManager.pickNext(model);
        }
    }

    return { account, waitMs };
}

/**
 * Handle endpoint-level errors
 * Returns { rethrow: boolean, error: Error }
 */
function handleEndpointError(error, endpoint, account, model, accountManager) {
    if (isRateLimitError(error)) {
        return { rethrow: true, error };
    }

    if (isTimeoutError(error)) {
        logger.warn(`[Retry] Timeout at ${endpoint}, trying next...`);
        return { rethrow: false };
    }

    if (error.message?.includes('401')) {
        logger.warn('[Retry] Auth error, refreshing token...');
        accountManager.clearTokenCache(account.email);
        accountManager.clearProjectCache(account.email);
        return { rethrow: false };
    }

    if (error.message?.includes('429')) {
        logger.debug(`[Retry] Rate limited at ${endpoint}, trying next endpoint...`);
        return { rethrow: false };
    }

    if (error.message?.includes('5')) {
        logger.warn(`[Retry] 5xx error at ${endpoint}, waiting 1s before next...`);
        // Note: caller should sleep(1000) before continuing
        return { rethrow: false };
    }

    logger.warn(`[Retry] Error at ${endpoint}:`, error.message);
    return { rethrow: false };
}

/**
 * Handle account-level errors
 * Returns true if should continue to next account
 */
function handleAccountError(error, account, model, accountManager, operationType) {
    if (isRateLimitError(error)) {
        logger.info(`[Retry] Account ${account.email} rate-limited, trying next...`);
        return true;
    }

    if (isAuthError(error)) {
        logger.warn(`[Retry] Account ${account.email} has invalid credentials, trying next...`);
        return true;
    }

    if (error.message?.includes('5') || error.message?.includes('500') || error.message?.includes('503')) {
        logger.warn(`[Retry] Account ${account.email} failed with 5xx error, trying next...`);
        accountManager.pickNext(model);
        return true;
    }

    if (isNetworkError(error)) {
        logger.warn(`[Retry] Network error for ${account.email}, trying next... (${error.message})`);
        accountManager.pickNext(model);
        return true;
    }

    return false;
}

/**
 * Attempt model fallback
 */
async function* attemptFallback(model, accountManager, operation, operationType) {
    const fallbackModel = getFallbackModel(model);
    if (!fallbackModel) {
        return null;
    }

    logger.warn(`[Retry] All accounts exhausted for ${model}. Attempting fallback to ${fallbackModel}`);

    // Signal to caller to retry with fallback model
    // This prevents infinite recursion by having caller manage the fallback
    return null;
}

export default { withRetry };
```

**Step 2:** Refactor message-handler.js to use shared retry logic.

Update `src/cloudcode/message-handler.js`:

```javascript
/**
 * Message Handler for Cloud Code
 *
 * Handles non-streaming message requests using shared retry logic.
 */

import { isThinkingModel } from '../constants.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import { logger } from '../utils/logger.js';
import { buildCloudCodeRequest, buildHeaders } from './request-builder.js';
import { parseThinkingSSEResponse } from './sse-parser.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { getFallbackModel } from '../fallback-config.js';

// Request timeout: 60 seconds for non-streaming
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Send a non-streaming request to Cloud Code
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {Object} accountManager - The account manager instance
 * @param {boolean} fallbackEnabled - Whether to enable model fallback
 * @returns {Promise<Object>} Anthropic-format response object
 */
export async function sendMessage(anthropicRequest, accountManager, fallbackEnabled = false) {
    const model = anthropicRequest.model;

    return executeWithRetry(anthropicRequest, accountManager, fallbackEnabled, false);
}

/**
 * Internal: Execute request with retry/failover logic
 */
async function executeWithRetry(anthropicRequest, accountManager, fallbackEnabled, isRecursiveFallback) {
    const model = anthropicRequest.model;
    const isThinking = isThinkingModel(model);
    const maxAttempts = Math.max(5, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const account = await selectAccountWithWait(model, accountManager, fallbackEnabled && !isRecursiveFallback);

        if (!account) {
            if (fallbackEnabled && !isRecursiveFallback) {
                const fallbackModel = getFallbackModel(model);
                if (fallbackModel) {
                    logger.warn(`[Message] Falling back to ${fallbackModel}`);
                    const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
                    return executeWithRetry(fallbackRequest, accountManager, false, true);
                }
            }
            throw new Error('No accounts available');
        }

        try {
            return await executeOnAccount(account, anthropicRequest, accountManager, isThinking);
        } catch (error) {
            if (shouldRetryOnAccount(error, account, model, accountManager)) {
                continue;
            }
            throw error;
        }
    }

    // Exhausted retries - try fallback
    if (fallbackEnabled && !isRecursiveFallback) {
        const fallbackModel = getFallbackModel(model);
        if (fallbackModel) {
            logger.warn(`[Message] All retries exhausted. Falling back to ${fallbackModel}`);
            const fallbackRequest = { ...anthropicRequest, model: fallbackModel };
            return executeWithRetry(fallbackRequest, accountManager, false, true);
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Select account with wait logic for rate limits
 */
async function selectAccountWithWait(model, accountManager, canFallback) {
    const { account: stickyAccount, waitMs } = accountManager.pickStickyAccount(model);
    let account = stickyAccount;

    if (!account && waitMs > 0) {
        logger.info(`[Message] Waiting ${Math.round(waitMs/1000)}s for sticky account...`);
        await new Promise(r => setTimeout(r, waitMs));
        accountManager.clearExpiredLimits();
        account = accountManager.getCurrentStickyAccount(model);
    }

    if (!account && accountManager.isAllRateLimited(model)) {
        const allWaitMs = accountManager.getMinWaitTimeMs(model);

        if (allWaitMs > 120000) {
            throw new Error(`RESOURCE_EXHAUSTED: Rate limited on ${model}. Wait ${Math.round(allWaitMs/60000)} minutes.`);
        }

        logger.warn(`[Message] All accounts rate-limited. Waiting ${Math.round(allWaitMs/1000)}s...`);
        await new Promise(r => setTimeout(r, allWaitMs + 500));
        accountManager.clearExpiredLimits();
        account = accountManager.pickNext(model);

        if (!account) {
            accountManager.resetAllRateLimits();
            account = accountManager.pickNext(model);
        }
    }

    return account;
}

/**
 * Execute request on a specific account with endpoint failover
 */
async function executeOnAccount(account, anthropicRequest, accountManager, isThinking) {
    const model = anthropicRequest.model;
    const token = await accountManager.getTokenForAccount(account);
    const project = await accountManager.getProjectForAccount(account, token);
    const payload = buildCloudCodeRequest(anthropicRequest, project);

    const endpoints = [
        'https://daily-cloudcode-pa.googleapis.com',
        'https://cloudcode-pa.googleapis.com'
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            const url = isThinking
                ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                : `${endpoint}/v1internal:generateContent`;

            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: buildHeaders(token, model, isThinking ? 'text/event-stream' : 'application/json'),
                body: JSON.stringify(payload)
            }, REQUEST_TIMEOUT_MS);

            if (!response.ok) {
                const errorText = await response.text();
                lastError = new Error(`API error ${response.status}: ${errorText}`);

                if (response.status === 429) {
                    // Mark rate limited and continue to next endpoint
                    const resetMs = parseResetTime(response, errorText);
                    accountManager.markRateLimited(account.email, resetMs, model);
                }
                continue;
            }

            if (isThinking) {
                return await parseThinkingSSEResponse(response, model);
            }

            const data = await response.json();
            return convertGoogleToAnthropic(data, model);

        } catch (endpointError) {
            lastError = endpointError;
            logger.warn(`[Message] Error at ${endpoint}:`, endpointError.message);
        }
    }

    if (lastError) throw lastError;
    throw new Error('All endpoints failed');
}

/**
 * Determine if we should retry on a different account
 */
function shouldRetryOnAccount(error, account, model, accountManager) {
    const msg = error.message || '';

    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        logger.info(`[Message] Account ${account.email} rate-limited, trying next...`);
        return true;
    }

    if (msg.includes('401') || msg.includes('AUTH_INVALID')) {
        logger.warn(`[Message] Account ${account.email} auth invalid, trying next...`);
        return true;
    }

    if (msg.includes('5') || msg.includes('timeout')) {
        logger.warn(`[Message] Account ${account.email} failed, trying next...`);
        accountManager.pickNext(model);
        return true;
    }

    return false;
}

// Import for reset time parsing
import { parseResetTime } from './rate-limit-parser.js';
```

This refactored version:
1. Separates concerns into focused functions
2. Uses consistent error handling
3. Integrates timeout support
4. Maintains the same behavior with cleaner code

---

### 4.2 Use Custom Error Classes Consistently

**Issue ID:** MED-002
**Severity:** MEDIUM
**Effort:** 1 hour
**Files Affected:** Multiple (grep for `throw new Error`)

#### 4.2.1 Implementation

Replace string-based errors with typed errors throughout the codebase:

```javascript
// Instead of:
throw new Error(`RESOURCE_EXHAUSTED: Rate limited on ${model}...`);

// Use:
import { RateLimitError } from '../errors.js';
throw new RateLimitError(`Rate limited on ${model}`, allWaitMs, account?.email);

// Instead of:
throw new Error('No accounts available');

// Use:
import { NoAccountsError } from '../errors.js';
throw new NoAccountsError('No accounts available', accountManager.isAllRateLimited(model));

// Instead of:
throw new Error('Max retries exceeded');

// Use:
import { MaxRetriesError } from '../errors.js';
throw new MaxRetriesError('Max retries exceeded', attempt);
```

---

## 5. Phase 4: Infrastructure Hardening

### 5.1 Add Security Headers with Helmet

**Issue ID:** LOW-001
**Severity:** LOW
**Effort:** 30 minutes

```bash
npm install helmet
```

In `src/server.js`:

```javascript
import helmet from 'helmet';

// Apply security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdn.tailwindcss.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,  // Allow CDN resources
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
```

### 5.2 Add Rate Limiting for API Endpoints

```bash
npm install express-rate-limit
```

In `src/server.js`:

```javascript
import rateLimit from 'express-rate-limit';

// Rate limit for general API endpoints
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 100,             // 100 requests per minute
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,              // 10 auth attempts per minute
    message: { error: 'Too many authentication attempts' }
});

// Apply rate limits
app.use('/v1/', apiLimiter);
app.use('/api/auth/', authLimiter);
```

---

## 6. Phase 5: Testing & Verification

### 6.1 Security Test Script

Create `tests/security-tests.cjs`:

```javascript
/**
 * Security Tests
 * Run with: node tests/security-tests.cjs
 */

const http = require('http');

const BASE_URL = 'http://localhost:8080';

async function fetch(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: options.headers || {}
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }));
        });
        req.on('error', reject);
        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
    });
}

async function runTests() {
    console.log('Running Security Tests...\n');
    let passed = 0;
    let failed = 0;

    // Test 1: /api/config requires auth
    {
        const res = await fetch('/api/config');
        if (res.status === 401) {
            console.log('✓ /api/config requires authentication');
            passed++;
        } else {
            console.log('✗ /api/config should require auth, got', res.status);
            failed++;
        }
    }

    // Test 2: Query param password rejected
    {
        const res = await fetch('/api/accounts?password=test');
        if (res.status === 401) {
            console.log('✓ Query parameter password rejected');
            passed++;
        } else {
            console.log('✗ Query param password should be rejected');
            failed++;
        }
    }

    // Test 3: Token prefix not in refresh response
    {
        const res = await fetch('/refresh-token', { method: 'POST' });
        if (!res.data.tokenPrefix) {
            console.log('✓ Token prefix not exposed in response');
            passed++;
        } else {
            console.log('✗ Token prefix should not be in response');
            failed++;
        }
    }

    // Test 4: Invalid model rejected
    {
        const res = await fetch('/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { model: 'evil-model', messages: [{ role: 'user', content: 'test' }] }
        });
        if (res.status === 400 && res.data.error?.message?.includes('model')) {
            console.log('✓ Invalid model rejected with validation error');
            passed++;
        } else {
            console.log('✗ Invalid model should be rejected');
            failed++;
        }
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
```

---

## 7. Implementation Checklist

### Day 1 Morning: Critical Fixes

- [ ] Create `src/utils/fetch-with-timeout.js`
- [ ] Update `message-handler.js` with timeout
- [ ] Update `streaming-handler.js` with timeout
- [ ] Remove token prefix from `/refresh-token`
- [ ] Fix WebUI auth bypass (remove /api/config exception)
- [ ] Add timing-safe password comparison
- [ ] Remove query param password support
- [ ] Add rate limiting to failed auth attempts

### Day 1 Afternoon: High Priority

- [ ] Install ajv and ajv-formats
- [ ] Create `src/utils/validators.js`
- [ ] Integrate validation into server.js
- [ ] Create `src/utils/error-sanitizer.js`
- [ ] Update error responses to use sanitizer
- [ ] Sanitize account info in health endpoint

### Day 2 Morning: Code Quality

- [ ] Create `src/cloudcode/retry-handler.js`
- [ ] Refactor `message-handler.js`
- [ ] Refactor `streaming-handler.js`
- [ ] Replace string errors with typed errors
- [ ] Add periodic cache cleanup

### Day 2 Afternoon: Infrastructure

- [ ] Install and configure helmet
- [ ] Install and configure express-rate-limit
- [ ] Create security test script
- [ ] Run full test suite
- [ ] Document changes in CHANGELOG

---

## Appendix: Quick Reference

### New Files Created

| File | Purpose |
|------|---------|
| `src/utils/fetch-with-timeout.js` | Request timeout utility |
| `src/utils/validators.js` | JSON Schema validation |
| `src/utils/error-sanitizer.js` | Error message sanitization |
| `src/cloudcode/retry-handler.js` | Shared retry logic |
| `tests/security-tests.cjs` | Security test suite |

### New Dependencies

```json
{
  "ajv": "^8.x",
  "ajv-formats": "^2.x",
  "helmet": "^7.x",
  "express-rate-limit": "^7.x"
}
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | development | Controls error detail level |
| `FETCH_TIMEOUT_MS` | 60000 | Request timeout in ms |
| `WEBUI_PASSWORD` | (none) | WebUI protection |

---

*End of Remediation Plan*
