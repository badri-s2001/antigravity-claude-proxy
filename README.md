# Antigravity Claude Proxy

A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude models like `claude-sonnet-4-5-thinking` and `claude-opus-4-5-thinking` with **Claude Code CLI**.

## How It Works

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  Antigravity Cloud Code    │
│   (Anthropic     │     │  (Anthropic → Google│     │  (daily-cloudcode-pa.      │
│    API format)   │     │   Generative AI)    │     │   sandbox.googleapis.com)  │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format**
2. Uses OAuth tokens from added Google accounts (or Antigravity's local database)
3. Transforms to **Google Generative AI format** with Cloud Code wrapping
4. Sends to Antigravity's Cloud Code API
5. Converts responses back to **Anthropic format** with full thinking/streaming support

## Prerequisites

- **Node.js** 18 or later
- **Antigravity** installed (for single-account mode) OR Google account(s) for multi-account mode

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Add Account(s)

You have two options:

**Option A: Use Antigravity (Single Account)**

If you have Antigravity installed and logged in, the proxy will automatically extract your token. No additional setup needed.

**Option B: Add Google Accounts via OAuth (Recommended for Multi-Account)**

Add one or more Google accounts for round-robin load balancing:

```bash
npm run accounts:add
```

This opens your browser for Google OAuth. Sign in and authorize access. Repeat for multiple accounts.

Manage accounts:

```bash
# List all accounts
npm run accounts:list

# Verify accounts are working
npm run accounts:verify

# Interactive account management
npm run accounts
```

### 3. Start the Proxy Server

```bash
npm start
```

The server runs on `http://localhost:8080` by default.

### 4. Verify It's Working

```bash
# Health check
curl http://localhost:8080/health

# Check account status
curl http://localhost:8080/accounts
```

---

## Using with Claude Code CLI

### Configure Claude Code

Create or edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-5-thinking",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-opus-4-5-thinking"
  }
}
```

### Run Claude Code

```bash
# Make sure the proxy is running first
npm start

# In another terminal, run Claude Code
claude
```

---

## Available Models

| Model ID | Description |
|----------|-------------|
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with extended thinking |

Standard Anthropic model names are automatically mapped:
- `claude-sonnet-4-5-20250514` → `claude-sonnet-4-5-thinking`
- `claude-opus-4-5-20250514` → `claude-opus-4-5-thinking`

---

## Multi-Account Load Balancing

When you add multiple accounts, the proxy automatically:

- **Round-robin rotation**: Each request uses the next available account
- **Rate limit handling**: Automatically switches to next account on 429 errors
- **Smart cooldown**: Rate-limited accounts become available after cooldown expires
- **Invalid account detection**: Accounts needing re-authentication are marked and skipped

Check account status anytime:

```bash
curl http://localhost:8080/accounts
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/accounts` | GET | Account pool status |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/models` | GET | List available models |
| `/refresh-token` | POST | Force token refresh |

---

## Testing

Run the test suite (requires server running):

```bash
# Start server in one terminal
npm start

# Run tests in another terminal
npm test
```

Individual tests:

```bash
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
```

---

## Troubleshooting

### "Could not extract token from Antigravity"

If using single-account mode with Antigravity:
1. Make sure Antigravity app is installed and running
2. Ensure you're logged in to Antigravity

Or add accounts via OAuth instead: `npm run accounts:add`

### 401 Authentication Errors

The token might have expired. Try:
```bash
curl -X POST http://localhost:8080/refresh-token
```

Or re-authenticate the account:
```bash
npm run accounts
```

### Rate Limiting (429)

With multiple accounts, the proxy automatically switches to the next available account. With a single account, you'll need to wait for the rate limit to reset.

### Account Shows as "Invalid"

Re-authenticate the account:
```bash
npm run accounts
# Choose "Re-authenticate" for the invalid account
```

---

## Project Structure

```
src/
├── index.js            # Entry point
├── server.js           # Express server with Anthropic API endpoints
├── cloudcode-client.js # Cloud Code API client with retry/failover
├── format-converter.js # Anthropic ↔ Google format conversion
├── account-manager.js  # Multi-account management
├── accounts-cli.js     # Account management CLI
├── oauth.js            # Google OAuth implementation
├── constants.js        # Endpoints, headers, model mappings
└── token-extractor.js  # Legacy token extraction from Antigravity

tests/
├── run-all.cjs                           # Test runner
├── test-thinking-signatures.cjs          # Thinking block tests
├── test-multiturn-thinking-tools.cjs     # Multi-turn tests
├── test-multiturn-thinking-tools-streaming.cjs
├── test-interleaved-thinking.cjs
└── test-images.cjs
```

---

## Safety, Usage, and Risk Notices

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Not Suitable For

- Production application traffic
- High-volume automated extraction
- Any use that violates Acceptable Use Policies

### Warning (Assumption of Risk)

By using this software, you acknowledge and accept the following:

- **Terms of Service risk**: This approach may violate the Terms of Service of AI model providers (Anthropic, Google, etc.). You are solely responsible for ensuring compliance with all applicable terms and policies.

- **Account risk**: Providers may detect this usage pattern and take punitive action, including suspension, permanent ban, or loss of access to paid subscriptions.

- **No guarantees**: Providers may change APIs, authentication, or policies at any time, which can break this method without notice.

- **Assumption of risk**: You assume all legal, financial, and technical risks. The authors and contributors of this project bear no responsibility for any consequences arising from your use.

**Use at your own risk. Proceed only if you understand and accept these risks.**

---

## Legal

- **Not affiliated with Google or Anthropic.** This is an independent open-source project and is not endorsed by, sponsored by, or affiliated with Google LLC or Anthropic PBC.

- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.

- "Claude" and "Anthropic" are trademarks of Anthropic PBC.

- Software is provided "as is", without warranty. You are responsible for complying with all applicable Terms of Service and Acceptable Use Policies.

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT
