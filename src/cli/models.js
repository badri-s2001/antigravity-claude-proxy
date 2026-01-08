#!/usr/bin/env node

/**
 * Model Chain Configuration CLI
 *
 * Interactive CLI for configuring model priority chain
 * for the Antigravity Claude Proxy.
 *
 * Usage:
 *   node src/cli/models.js          # Interactive mode
 *   node src/cli/models.js list     # List current chain
 *   node src/cli/models.js reset    # Reset to default chain
 */

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { UNIVERSAL_FALLBACK_CHAIN } from '../constants.js';

// Config path for model chain settings
const MODEL_CHAIN_CONFIG_PATH = join(
    homedir(),
    '.config/antigravity-proxy/model-chain.json'
);

// Available models to choose from
const AVAILABLE_MODELS = [
    { id: 'claude-opus-4-5-thinking', name: 'Claude Opus 4.5 (Thinking)', tier: 'opus' },
    { id: 'claude-sonnet-4-thinking', name: 'Claude Sonnet 4 (Thinking)', tier: 'sonnet' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', tier: 'sonnet' },
    { id: 'gemini-3-pro-high', name: 'Gemini 3 Pro High', tier: 'pro' },
    { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image', tier: 'pro' },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', tier: 'flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'flash' }
];

/**
 * Create readline interface
 */
function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

/**
 * Load current model chain config
 */
function loadConfig() {
    try {
        if (existsSync(MODEL_CHAIN_CONFIG_PATH)) {
            const data = readFileSync(MODEL_CHAIN_CONFIG_PATH, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading config:', error.message);
    }
    return {
        enabled: false,
        chain: [...UNIVERSAL_FALLBACK_CHAIN]
    };
}

/**
 * Save model chain config
 */
function saveConfig(config) {
    try {
        const dir = dirname(MODEL_CHAIN_CONFIG_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(MODEL_CHAIN_CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log(`\n\x1b[32m✓ Configuration saved to ${MODEL_CHAIN_CONFIG_PATH}\x1b[0m`);
    } catch (error) {
        console.error('Error saving config:', error.message);
        throw error;
    }
}

/**
 * Display current chain
 */
function displayChain(chain, enabled) {
    console.log('\n\x1b[36m╔════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m║         Model Priority Chain           ║\x1b[0m');
    console.log('\x1b[36m╚════════════════════════════════════════╝\x1b[0m');

    const status = enabled
        ? '\x1b[32m● ENABLED\x1b[0m (use --models flag to activate)'
        : '\x1b[33m○ DISABLED\x1b[0m';
    console.log(`\nStatus: ${status}`);

    console.log('\nCurrent chain (highest to lowest priority):');
    chain.forEach((model, i) => {
        const info = AVAILABLE_MODELS.find(m => m.id === model);
        const name = info ? info.name : model;
        console.log(`  ${i + 1}. ${name} \x1b[90m(${model})\x1b[0m`);
    });
}

/**
 * Display available models for selection
 */
function displayAvailableModels(excludeIds = []) {
    console.log('\nAvailable models:');
    const available = AVAILABLE_MODELS.filter(m => !excludeIds.includes(m.id));
    available.forEach((model, i) => {
        console.log(`  ${i + 1}. ${model.name} \x1b[90m(${model.id})\x1b[0m`);
    });
    return available;
}

/**
 * Interactive chain builder
 */
async function buildChain(rl) {
    const chain = [];
    console.log('\n\x1b[33mBuild your model priority chain\x1b[0m');
    console.log('Models are tried in order. When one is rate-limited, the next is used.');
    console.log('Enter 0 or "done" when finished.\n');

    while (chain.length < AVAILABLE_MODELS.length) {
        const available = displayAvailableModels(chain);

        if (available.length === 0) {
            console.log('\nNo more models available.');
            break;
        }

        const answer = await rl.question(`\nAdd model #${chain.length + 1} (1-${available.length}, or 0 to finish): `);

        if (answer === '0' || answer.toLowerCase() === 'done') {
            if (chain.length === 0) {
                console.log('\n\x1b[31mError: Chain must have at least one model.\x1b[0m');
                continue;
            }
            break;
        }

        const index = parseInt(answer, 10) - 1;
        if (isNaN(index) || index < 0 || index >= available.length) {
            console.log('\x1b[31mInvalid selection.\x1b[0m');
            continue;
        }

        const selected = available[index];
        chain.push(selected.id);
        console.log(`\x1b[32m✓ Added: ${selected.name}\x1b[0m`);
    }

    return chain;
}

/**
 * Interactive reorder chain
 */
async function reorderChain(rl, currentChain) {
    console.log('\n\x1b[33mReorder model chain\x1b[0m');
    console.log('Enter new position for each model.\n');

    const newChain = [...currentChain];

    console.log('Current order:');
    newChain.forEach((model, i) => {
        const info = AVAILABLE_MODELS.find(m => m.id === model);
        console.log(`  ${i + 1}. ${info?.name || model}`);
    });

    const answer = await rl.question('\nEnter model number to move: ');
    const fromIndex = parseInt(answer, 10) - 1;

    if (isNaN(fromIndex) || fromIndex < 0 || fromIndex >= newChain.length) {
        console.log('\x1b[31mInvalid selection.\x1b[0m');
        return currentChain;
    }

    const toAnswer = await rl.question(`Move "${AVAILABLE_MODELS.find(m => m.id === newChain[fromIndex])?.name}" to position (1-${newChain.length}): `);
    const toIndex = parseInt(toAnswer, 10) - 1;

    if (isNaN(toIndex) || toIndex < 0 || toIndex >= newChain.length) {
        console.log('\x1b[31mInvalid position.\x1b[0m');
        return currentChain;
    }

    // Reorder
    const [model] = newChain.splice(fromIndex, 1);
    newChain.splice(toIndex, 0, model);

    console.log('\n\x1b[32m✓ Chain reordered\x1b[0m');
    return newChain;
}

/**
 * Main interactive menu
 */
async function interactiveMenu(rl) {
    let config = loadConfig();

    while (true) {
        displayChain(config.chain, config.enabled);

        console.log('\n\x1b[36mOptions:\x1b[0m');
        console.log('  1. Enable/Disable model chain');
        console.log('  2. Build new chain');
        console.log('  3. Reorder chain');
        console.log('  4. Reset to default');
        console.log('  5. Save and exit');
        console.log('  6. Exit without saving');

        const choice = await rl.question('\nSelect option (1-6): ');

        switch (choice) {
            case '1':
                config.enabled = !config.enabled;
                console.log(`\n\x1b[32m✓ Model chain ${config.enabled ? 'ENABLED' : 'DISABLED'}\x1b[0m`);
                break;

            case '2':
                const newChain = await buildChain(rl);
                if (newChain.length > 0) {
                    config.chain = newChain;
                }
                break;

            case '3':
                config.chain = await reorderChain(rl, config.chain);
                break;

            case '4':
                config.chain = [...UNIVERSAL_FALLBACK_CHAIN];
                console.log('\n\x1b[32m✓ Chain reset to default\x1b[0m');
                break;

            case '5':
                saveConfig(config);
                console.log('\nTo use model chain mode, start the server with:');
                console.log('  \x1b[33mantigravity-claude-proxy start --models\x1b[0m\n');
                return;

            case '6':
                console.log('\nExiting without saving...');
                return;

            default:
                console.log('\n\x1b[31mInvalid option.\x1b[0m');
        }
    }
}

/**
 * List current chain (non-interactive)
 */
function listChain() {
    const config = loadConfig();
    displayChain(config.chain, config.enabled);
    console.log(`\nConfig file: ${MODEL_CHAIN_CONFIG_PATH}`);
}

/**
 * Reset to default chain
 */
function resetChain() {
    const config = {
        enabled: false,
        chain: [...UNIVERSAL_FALLBACK_CHAIN]
    };
    saveConfig(config);
    console.log('\n\x1b[32m✓ Model chain reset to default\x1b[0m');
    displayChain(config.chain, config.enabled);
}

/**
 * Main CLI entry point
 */
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'menu';

    console.log('\x1b[36m╔════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m║   Model Chain Configuration Manager   ║\x1b[0m');
    console.log('\x1b[36m╚════════════════════════════════════════╝\x1b[0m');

    const rl = createRL();

    try {
        switch (command) {
            case 'menu':
            case 'configure':
                await interactiveMenu(rl);
                break;

            case 'list':
                listChain();
                break;

            case 'reset':
                resetChain();
                break;

            case 'help':
                console.log('\nUsage:');
                console.log('  antigravity-claude-proxy models          Interactive configuration');
                console.log('  antigravity-claude-proxy models list     Show current chain');
                console.log('  antigravity-claude-proxy models reset    Reset to default chain');
                console.log('\nThe model chain determines fallback order when models are rate-limited.');
                console.log('Start server with --models flag to enable chain mode.');
                break;

            default:
                console.log(`Unknown command: ${command}`);
                console.log('Run "antigravity-claude-proxy models help" for usage.');
        }
    } finally {
        rl.close();
        process.exit(0);
    }
}

main().catch(console.error);
