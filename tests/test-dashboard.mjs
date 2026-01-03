/**
 * Dashboard Verification Test
 * Tests /dashboard static serving and /api/dashboard/status endpoint
 */

import { createServer } from 'http';
import app from '../src/server.js';
import { logger } from '../src/utils/logger.js';

// Suppress logs during test
logger.level = 'silent';

const PORT = 8081; // Use different port than default
const BASE_URL = `http://localhost:${PORT}`;

const server = createServer(app);

async function runTest() {
    console.log('Starting server for dashboard test...');

    await new Promise(resolve => server.listen(PORT, resolve));
    console.log(`Server listening on ${PORT}`);

    try {
        // Test 1: Static File Serving
        console.log('Testing /dashboard...');
        const staticRes = await fetch(`${BASE_URL}/dashboard`);
        if (staticRes.status === 200) {
            const text = await staticRes.text();
            if (text.includes('<title>Antigravity Proxy Dashboard</title>')) {
                console.log('✅ PASS: Dashboard HTML served');
            } else {
                console.log('❌ FAIL: Dashboard HTML content mismatch');
                process.exit(1);
            }
        } else {
            console.log(`❌ FAIL: Static file returned ${staticRes.status}`);
            process.exit(1);
        }

        // Test 2: API Status Endpoint
        console.log('Testing /api/dashboard/status...');
        const apiRes = await fetch(`${BASE_URL}/api/dashboard/status`);
        if (apiRes.status === 200) {
            const data = await apiRes.json();

            // Validate schema
            const hasVersion = !!data.version;
            const hasUptime = typeof data.uptime === 'number';
            const hasAccounts = data.accounts && Array.isArray(data.accounts.list);

            if (hasVersion && hasUptime && hasAccounts) {
                console.log(`✅ PASS: API status returned valid JSON (Version: ${data.version})`);
                console.log(`   Accounts available: ${data.accounts.available}/${data.accounts.total}`);
            } else {
                console.log('❌ FAIL: API JSON schema invalid', data);
                process.exit(1);
            }
        } else {
            console.log(`❌ FAIL: API endpoint returned ${apiRes.status}`);
            process.exit(1);
        }

        console.log('\nALL DASHBOARD TESTS PASSED');

    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    } finally {
        server.close();
        process.exit(0);
    }
}

runTest();
