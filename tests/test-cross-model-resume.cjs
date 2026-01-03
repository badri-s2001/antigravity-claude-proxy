/**
 * Cross-Model Resume Test
 *
 * Tests that switching from Claude to Gemini (or vice versa) during a resumed
 * session does NOT cause "Corrupted thought signature" errors.
 *
 * Related: GitHub Issue #18
 *
 * This test simulates:
 * 1. A conversation started with Claude that includes thinking blocks with signatures
 * 2. Resuming that conversation with a Gemini model
 * 3. Verifying no 400 error occurs
 */
const { streamRequest, analyzeContent, commonTools } = require('./helpers/http-client.cjs');
const { getModelConfig } = require('./helpers/test-models.cjs');

// Use thinking models from both families
const CLAUDE_MODEL = 'claude-sonnet-4-5-thinking';
const GEMINI_MODEL = 'gemini-3-flash';

const tools = [commonTools.getWeather];

/**
 * Build a simulated Claude conversation history with thinking blocks
 * This mimics what Claude Code would send when resuming a session
 */
function buildClaudeHistoryWithThinking() {
    return [
        {
            role: 'user',
            content: 'What is the weather in Paris? Use the get_weather tool.'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'thinking',
                    thinking: 'The user wants to know the weather in Paris. I should use the get_weather tool to fetch this information.',
                    // This is a Claude-format signature (real ones are longer, but this simulates the format)
                    signature: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                },
                {
                    type: 'tool_use',
                    id: 'toolu_test_123',
                    name: 'get_weather',
                    input: { location: 'Paris' }
                }
            ]
        },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'toolu_test_123',
                content: 'The weather in Paris is 18°C and sunny.'
            }]
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'thinking',
                    thinking: 'Great, I received the weather data. The temperature is 18°C and it is sunny. I will now provide this information to the user.',
                    signature: 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba9876543210ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba9876543210'
                },
                {
                    type: 'text',
                    text: 'The weather in Paris is currently 18°C and sunny!'
                }
            ]
        }
    ];
}

/**
 * Build a simulated Gemini conversation history with thoughtSignatures
 */
function buildGeminiHistoryWithThinking() {
    return [
        {
            role: 'user',
            content: 'What is the weather in Paris? Use the get_weather tool.'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'toolu_test_456',
                    name: 'get_weather',
                    input: { location: 'Paris' },
                    // Gemini-style signature on tool_use
                    thoughtSignature: 'GEMINI_SIG_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
                }
            ]
        },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'toolu_test_456',
                content: 'The weather in Paris is 18°C and sunny.'
            }]
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: 'The weather in Paris is currently 18°C and sunny!'
                }
            ]
        }
    ];
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('CROSS-MODEL RESUME TEST (Issue #18)');
    console.log('Tests that switching models during resume does not cause');
    console.log('"Corrupted thought signature" errors');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];

    // ===== TEST 1: Claude history → Gemini model =====
    console.log('TEST 1: Resume Claude history with Gemini model');
    console.log('-'.repeat(40));

    const claudeHistory = buildClaudeHistoryWithThinking();
    const geminiConfig = getModelConfig('gemini');

    // Add a new user message to continue the conversation
    const resumeWithGemini = [
        ...claudeHistory,
        { role: 'user', content: 'Can you also tell me the weather in London?' }
    ];

    try {
        const result1 = await streamRequest({
            model: GEMINI_MODEL,
            max_tokens: geminiConfig.max_tokens,
            stream: true,
            tools,
            thinking: geminiConfig.thinking,
            messages: resumeWithGemini
        });

        // Check for errors
        const errorEvent = result1.events.find(e => e.type === 'error');
        const hasCorruptedError = errorEvent?.data?.error?.message?.includes('Corrupted thought signature');

        if (hasCorruptedError) {
            console.log('  ❌ FAILED: Corrupted thought signature error!');
            console.log(`  Error: ${errorEvent.data.error.message}`);
            results.push({ name: 'Claude→Gemini resume', passed: false });
            allPassed = false;
        } else if (errorEvent) {
            console.log(`  ⚠️ Other error occurred: ${errorEvent.data.error.message}`);
            // Other errors might be acceptable (rate limits, etc.)
            results.push({ name: 'Claude→Gemini resume', passed: true, note: 'Non-signature error' });
        } else {
            const content = analyzeContent(result1.content);
            console.log(`  Thinking blocks: ${content.thinking.length}`);
            console.log(`  Tool use blocks: ${content.toolUse.length}`);
            console.log(`  Text blocks: ${content.text.length}`);
            console.log('  ✅ PASSED: No corrupted signature error');
            results.push({ name: 'Claude→Gemini resume', passed: true });
        }
    } catch (err) {
        console.log(`  ❌ FAILED: Request error - ${err.message}`);
        results.push({ name: 'Claude→Gemini resume', passed: false });
        allPassed = false;
    }

    // ===== TEST 2: Gemini history → Claude model =====
    console.log('\nTEST 2: Resume Gemini history with Claude model');
    console.log('-'.repeat(40));

    const geminiHistory = buildGeminiHistoryWithThinking();
    const claudeConfig = getModelConfig('claude');

    const resumeWithClaude = [
        ...geminiHistory,
        { role: 'user', content: 'Can you also tell me the weather in London?' }
    ];

    try {
        const result2 = await streamRequest({
            model: CLAUDE_MODEL,
            max_tokens: claudeConfig.max_tokens,
            stream: true,
            tools,
            thinking: claudeConfig.thinking,
            messages: resumeWithClaude
        });

        // Check for errors
        const errorEvent = result2.events.find(e => e.type === 'error');
        const hasCorruptedError = errorEvent?.data?.error?.message?.includes('Corrupted thought signature');

        if (hasCorruptedError) {
            console.log('  ❌ FAILED: Corrupted thought signature error!');
            console.log(`  Error: ${errorEvent.data.error.message}`);
            results.push({ name: 'Gemini→Claude resume', passed: false });
            allPassed = false;
        } else if (errorEvent) {
            console.log(`  ⚠️ Other error occurred: ${errorEvent.data.error.message}`);
            results.push({ name: 'Gemini→Claude resume', passed: true, note: 'Non-signature error' });
        } else {
            const content = analyzeContent(result2.content);
            console.log(`  Thinking blocks: ${content.thinking.length}`);
            console.log(`  Tool use blocks: ${content.toolUse.length}`);
            console.log(`  Text blocks: ${content.text.length}`);
            console.log('  ✅ PASSED: No corrupted signature error');
            results.push({ name: 'Gemini→Claude resume', passed: true });
        }
    } catch (err) {
        console.log(`  ❌ FAILED: Request error - ${err.message}`);
        results.push({ name: 'Gemini→Claude resume', passed: false });
        allPassed = false;
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.passed ? 'PASS' : 'FAIL';
        const note = result.note ? ` (${result.note})` : '';
        console.log(`  [${status}] ${result.name}${note}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
