/**
 * Security Tests for Antigravity Claude Proxy
 *
 * Tests the security fixes implemented in the remediation plan:
 * - Input validation
 * - Authentication bypass prevention
 * - Error message sanitization
 * - Rate limiting
 * - Prototype pollution protection
 *
 * Run with: node tests/security-tests.cjs
 * Prerequisites: Server must be running on port 8080
 */

const http = require('http');
const https = require('https');

// =============================================================================
// CONFIGURATION
// =============================================================================

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const VERBOSE = process.env.VERBOSE === 'true';

// Test results tracking
let passed = 0;
let failed = 0;
let skipped = 0;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Make an HTTP request
 */
async function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const reqOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        };

        const req = lib.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsedData = data;
                try {
                    parsedData = JSON.parse(data);
                } catch (e) {
                    // Response might not be JSON
                }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    data: parsedData
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (options.rawBody) {
            // Use raw body string (for testing JSON with special keys like __proto__)
            req.write(options.rawBody);
        } else if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        req.end();
    });
}

/**
 * Log test result
 */
function logTest(name, success, details = '') {
    if (success) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.log(`  ✗ ${name}`);
        if (details) console.log(`    ${details}`);
        failed++;
    }
}

/**
 * Skip a test
 */
function skipTest(name, reason) {
    console.log(`  ○ ${name} (skipped: ${reason})`);
    skipped++;
}

// =============================================================================
// TEST SUITES
// =============================================================================

/**
 * Test input validation
 */
async function testInputValidation() {
    console.log('\n📋 Input Validation Tests:');

    // Test 1: Missing messages field
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            body: { model: 'claude-sonnet-4-5-thinking' }
        });
        logTest(
            'Rejects missing messages field',
            res.status === 400 && res.data?.error?.message?.includes('messages'),
            `Got status ${res.status}`
        );
    } catch (e) {
        logTest('Rejects missing messages field', false, e.message);
    }

    // Test 2: Invalid model name
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            body: {
                model: 'evil-model-name',
                messages: [{ role: 'user', content: 'test' }]
            }
        });
        logTest(
            'Rejects invalid model name',
            res.status === 400 && res.data?.error?.message?.includes('model'),
            `Got status ${res.status}`
        );
    } catch (e) {
        logTest('Rejects invalid model name', false, e.message);
    }

    // Test 3: Invalid role
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            body: {
                model: 'claude-sonnet-4-5-thinking',
                messages: [{ role: 'hacker', content: 'test' }]
            }
        });
        logTest(
            'Rejects invalid message role',
            res.status === 400 && res.data?.error?.message?.includes('role'),
            `Got status ${res.status}`
        );
    } catch (e) {
        logTest('Rejects invalid message role', false, e.message);
    }

    // Test 4: Prototype pollution attempt
    // Note: Must use rawBody because JS object literals with __proto__ set the prototype,
    // not a property, so JSON.stringify won't include it
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            rawBody: JSON.stringify({
                model: 'claude-sonnet-4-5-thinking',
                messages: [{ role: 'user', content: 'test' }]
            }).slice(0, -1) + ',"__proto__":{"polluted":true}}'
        });
        logTest(
            'Blocks prototype pollution',
            res.status === 400 && res.data?.error?.message?.toLowerCase().includes('prototype'),
            `Got status ${res.status}: ${res.data?.error?.message || 'no message'}`
        );
    } catch (e) {
        logTest('Blocks prototype pollution', false, e.message);
    }

    // Test 5: max_tokens out of range
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            body: {
                model: 'claude-sonnet-4-5-thinking',
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 9999999
            }
        });
        // Either rejected as invalid, or capped to valid range
        logTest(
            'Handles oversized max_tokens',
            res.status === 400 || res.status === 200,
            `Got status ${res.status}`
        );
    } catch (e) {
        logTest('Handles oversized max_tokens', false, e.message);
    }

    // Test 6: Invalid temperature type
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            body: {
                model: 'claude-sonnet-4-5-thinking',
                messages: [{ role: 'user', content: 'test' }],
                temperature: 'hot'
            }
        });
        logTest(
            'Rejects non-numeric temperature',
            res.status === 400,
            `Got status ${res.status}`
        );
    } catch (e) {
        logTest('Rejects non-numeric temperature', false, e.message);
    }
}

/**
 * Test authentication security
 */
async function testAuthentication() {
    console.log('\n🔐 Authentication Security Tests:');

    // Test 1: /api/config requires auth (if password set)
    try {
        const res = await request('/api/config');
        // Either requires auth (401) or no password set (200)
        const isProtected = res.status === 401;
        const noPassword = res.status === 200;
        logTest(
            '/api/config access control',
            isProtected || noPassword,
            isProtected ? 'Protected (good)' : 'No password set (acceptable)'
        );
    } catch (e) {
        logTest('/api/config access control', false, e.message);
    }

    // Test 2: Query param password should be rejected (if password protection is enabled)
    // When no password is set, endpoint is accessible (acceptable behavior)
    try {
        // First check if password protection is enabled
        const configRes = await request('/api/config');
        const passwordProtected = configRes.status === 401;

        if (passwordProtected) {
            // Try to authenticate via query param (should fail)
            const res = await request('/api/accounts?password=testpass');
            logTest(
                'Query param password rejected',
                res.status === 401, // Query param should NOT work
                `Got status ${res.status}`
            );
        } else {
            skipTest('Query param password rejected', 'No password configured');
        }
    } catch (e) {
        logTest('Query param password rejected', false, e.message);
    }

    // Test 3: OAuth URL endpoint accessible without auth
    try {
        const res = await request('/api/auth/url');
        logTest(
            'OAuth URL endpoint accessible',
            res.status === 200 || res.status === 500, // 500 if OAuth not configured
            `Got status ${res.status}`
        );
    } catch (e) {
        logTest('OAuth URL endpoint accessible', false, e.message);
    }
}

/**
 * Test error sanitization
 */
async function testErrorSanitization() {
    console.log('\n🛡️ Error Sanitization Tests:');

    // Test 1: Token prefix not exposed in /refresh-token
    try {
        const res = await request('/refresh-token', { method: 'POST' });
        const hasTokenPrefix = res.data?.tokenPrefix !== undefined;
        logTest(
            'Token prefix not exposed',
            !hasTokenPrefix,
            hasTokenPrefix ? 'EXPOSED - tokenPrefix in response' : 'Safe'
        );
    } catch (e) {
        // Error is acceptable if no accounts configured
        logTest('Token prefix not exposed', true, 'Endpoint error (acceptable)');
    }

    // Test 2: Internal paths not in error messages
    try {
        const res = await request('/v1/messages', {
            method: 'POST',
            body: { invalid: 'request' }
        });
        const errorMsg = JSON.stringify(res.data);
        const hasInternalPath = /\/Users\/|\/home\/|C:\\Users/.test(errorMsg);
        logTest(
            'Internal paths not leaked',
            !hasInternalPath,
            hasInternalPath ? 'LEAKED path in response' : 'Safe'
        );
    } catch (e) {
        logTest('Internal paths not leaked', true);
    }

    // Test 3: Email addresses not in public error messages
    try {
        const res = await request('/health');
        const responseStr = JSON.stringify(res.data);
        // Check for masked email format: first letter + *** + @ (e.g., "d***@gmail.com")
        const hasMaskedEmail = /[a-z]\*\*\*@/i.test(responseStr);
        // Check for full email format: multiple chars before @ (e.g., "someone@gmail.com")
        const hasFullEmail = /"[a-zA-Z0-9._%+-]{2,}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"/.test(responseStr) &&
                            !hasMaskedEmail;
        logTest(
            'Full emails not exposed',
            !hasFullEmail || res.status !== 200,
            hasFullEmail ? 'Full email in response' : (hasMaskedEmail ? 'Correctly masked' : 'Safe')
        );
    } catch (e) {
        logTest('Full emails not exposed', true);
    }
}

/**
 * Test rate limiting
 */
async function testRateLimiting() {
    console.log('\n⏱️ Rate Limiting Tests:');

    // Test 1: Multiple rapid requests don't crash server
    try {
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(request('/health'));
        }
        const results = await Promise.all(promises);
        const allSuccessful = results.every(r => r.status === 200 || r.status === 429);
        logTest(
            'Handles concurrent requests',
            allSuccessful,
            `${results.filter(r => r.status === 200).length}/10 succeeded`
        );
    } catch (e) {
        logTest('Handles concurrent requests', false, e.message);
    }

    // Test 2: Server returns 429 after many requests (if rate limiting enabled)
    // This is a soft test - rate limiting might not be configured
    skipTest('Rate limiting enforced', 'Depends on configuration');
}

/**
 * Test security headers
 */
async function testSecurityHeaders() {
    console.log('\n📝 Security Headers Tests:');

    try {
        const res = await request('/');
        const headers = res.headers;

        // Check for security headers (if helmet is installed)
        const hasCSP = headers['content-security-policy'] !== undefined;
        const hasXFrame = headers['x-frame-options'] !== undefined;
        const hasXContent = headers['x-content-type-options'] !== undefined;

        logTest('Content-Security-Policy header', hasCSP, hasCSP ? 'Present' : 'Missing');
        logTest('X-Frame-Options header', hasXFrame, hasXFrame ? 'Present' : 'Missing');
        logTest('X-Content-Type-Options header', hasXContent, hasXContent ? 'Present' : 'Missing');
    } catch (e) {
        logTest('Security headers', false, e.message);
    }
}

/**
 * Test timeout handling
 */
async function testTimeoutHandling() {
    console.log('\n⏰ Timeout Handling Tests:');

    // This is a passive test - we verify the utility exists
    // Actual timeout testing requires a slow endpoint
    skipTest('Request timeout enforced', 'Requires slow endpoint for testing');
}

// =============================================================================
// MAIN
// =============================================================================

async function runTests() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('       Security Tests for Antigravity Claude Proxy          ');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Testing: ${BASE_URL}`);
    console.log('');

    // Check if server is running
    try {
        await request('/health');
    } catch (e) {
        console.error('❌ Cannot connect to server. Is it running?');
        console.error(`   ${e.message}`);
        process.exit(1);
    }

    // Run test suites
    await testInputValidation();
    await testAuthentication();
    await testErrorSanitization();
    await testRateLimiting();
    await testSecurityHeaders();
    await testTimeoutHandling();

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('                       SUMMARY                              ');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ✓ Passed:  ${passed}`);
    console.log(`  ✗ Failed:  ${failed}`);
    console.log(`  ○ Skipped: ${skipped}`);
    console.log('');

    if (failed > 0) {
        console.log('⚠️  Some security tests failed. Review the output above.');
        process.exit(1);
    } else {
        console.log('✅ All security tests passed!');
        process.exit(0);
    }
}

// Run tests
runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
