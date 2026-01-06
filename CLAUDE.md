# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Antigravity Claude Proxy is a Node.js proxy server that exposes an Anthropic-compatible API backed by Antigravity's Cloud Code service. It enables using Claude and Gemini models with Claude Code CLI.

## CLI Commands Reference

**IMPORTANT**: Always use these npm scripts instead of raw commands. They ensure correct paths and configuration.

### Development

```bash
npm run build              # Compile TypeScript to dist/
npm run dev                # Watch mode with auto-reload
npm run typecheck          # Type check without emitting
npm run lint               # ESLint check
npm run lint:fix           # ESLint auto-fix
```

### Server

```bash
npm start                              # Start server (port 8080)
npm start -- --port 3000               # Custom port
npm start -- --fallback                # Enable model fallback on quota exhaustion
npm start -- --debug                   # Debug logging
npm start -- --log-level debug         # Log level: silent|error|warn|info|debug|trace
npm start -- --log-file proxy.log      # Log to file
npm start -- --json-logs               # JSON output for parsing
npm start -- --silent                  # Suppress output except errors
npm run start:prod                     # Production mode (from dist/)
```

### Account Management

```bash
npm run init               # Interactive setup wizard
npm run accounts           # Interactive account menu
npm run accounts:add       # Add account (OAuth or refresh token)
npm run accounts:add -- --no-browser      # Headless OAuth (manual URL)
npm run accounts:add -- --refresh-token   # Use refresh token directly
npm run accounts:list      # List all accounts
npm run accounts:remove    # Remove account interactively
npm run accounts:verify    # Verify all account tokens
npm run accounts:clear     # Remove all accounts

# With environment variable
REFRESH_TOKEN=1//xxx npm run accounts:add -- --refresh-token
```

### Testing

#### Unit Tests (Vitest)

```bash
npm test                               # Run all unit tests
npm test -- path/to/file.test.ts       # Run single test file
npm test -- --grep "pattern"           # Run tests matching pattern
npm run test:watch                     # Watch mode
npm run test:coverage                  # With coverage report (opens html)
npm run test:bench                     # Performance benchmarks
```

#### Integration Tests (require running server)

```bash
# Start server first: npm start
npm run test:integration     # All integration tests
npm run test:signatures      # Thinking signature validation
npm run test:multiturn       # Multi-turn tool conversations
npm run test:streaming       # SSE streaming tests
npm run test:interleaved     # Interleaved thinking blocks
npm run test:images          # Image/document support
npm run test:caching         # Prompt caching
npm run test:crossmodel      # Cross-model thinking compatibility
npm run test:oauth           # OAuth no-browser flow
```

### Debugging

```bash
npm start -- --debug                   # Enable debug mode
npm start -- --log-level trace         # Maximum verbosity
npm test -- --reporter=verbose         # Verbose test output
npm test -- --no-coverage              # Skip coverage for faster runs
```

## Test Strategy

### Current Test Types

| Type        | Location             | Purpose                               | Command                    |
| ----------- | -------------------- | ------------------------------------- | -------------------------- |
| Unit        | `tests/unit/`        | Individual functions, mocked deps     | `npm test`                 |
| Fuzz        | `tests/fuzz/`        | Random input, edge cases (fast-check) | `npm test`                 |
| Contract    | `tests/contract/`    | API schema validation                 | `npm test`                 |
| Benchmark   | `tests/bench/`       | Performance regression                | `npm run test:bench`       |
| Integration | `tests/integration/` | End-to-end with real server           | `npm run test:integration` |

### Test Types to Implement (Regression Prevention Roadmap)

#### Priority 1: Critical

| Test Type             | Purpose                                         | Tools            |
| --------------------- | ----------------------------------------------- | ---------------- |
| **Snapshot Tests**    | Detect unintended format changes                | Vitest snapshots |
| **Golden File Tests** | Known good request/response pairs               | Custom harness   |
| **Chaos/Fault Tests** | Network failures, timeouts, malformed responses | Custom + nock    |
| **API Compatibility** | Version matrix, backward compat                 | Custom harness   |

#### Priority 2: Important

| Test Type             | Purpose                                | Tools              |
| --------------------- | -------------------------------------- | ------------------ |
| **Mutation Testing**  | Verify test quality, not just coverage | Stryker            |
| **Stress/Load Tests** | Concurrent handling, memory leaks      | autocannon, clinic |
| **Security Tests**    | Input sanitization, token handling     | Custom + OWASP ZAP |
| **Type Tests**        | Exported types correctness             | expect-type        |

#### Priority 3: Nice to Have

| Test Type             | Purpose                                | Tools                         |
| --------------------- | -------------------------------------- | ----------------------------- |
| **E2E with Real API** | Canary/smoke tests (gated, expensive)  | Custom harness                |
| **Cross-Platform**    | Win/Linux/Mac, Node versions           | GitHub Actions matrix         |
| **Memory Profiling**  | Heap snapshots, long-running stability | clinic, memwatch              |
| **Visual CLI Tests**  | Terminal output consistency            | jest-snapshot-serializer-ansi |

### Test File Naming Conventions

```
tests/unit/**/*.test.ts           # Unit tests
tests/fuzz/**/*.fuzz.test.ts      # Fuzz/property tests
tests/contract/**/*.contract.test.ts  # Contract tests
tests/bench/**/*.bench.ts         # Benchmarks
tests/integration/*.cjs           # Integration tests
tests/snapshot/**/*.snap.test.ts  # Snapshot tests (future)
tests/e2e/**/*.e2e.test.ts        # E2E tests (future)
```

## Project Structure

```
src/
├── cli/              # Commander CLI commands
├── auth/             # OAuth, token extraction
├── account-manager/  # Multi-account management
├── cloudcode/        # Google Cloud Code API
├── format/           # Anthropic <-> Google converters
├── utils/            # Helpers, logging
├── server.ts         # Express server
└── constants.ts      # Configuration

tests/
├── unit/             # Vitest unit tests
├── fuzz/             # Property-based tests
├── contract/         # API contract tests
├── bench/            # Benchmarks
├── integration/      # Integration tests (.cjs)
├── fixtures/         # Test data files
├── snapshots/        # Snapshot files
└── helpers/          # Test utilities
```

## Refresh Token Authentication

Add accounts using only a refresh token (no OAuth flow needed).

### Where to Find Refresh Tokens

| Source                    | Location                                             |
| ------------------------- | ---------------------------------------------------- |
| Gemini CLI                | `~/.gemini/oauth_creds.json` (`refresh_token` field) |
| opencode-antigravity-auth | `~/.config/opencode/`                                |

### Token Format

- **Refresh tokens**: Start with `1//`, long-lived
- **Access tokens**: Start with `ya29.`, ~1 hour expiry

## OAuth Error Reference

| Error                | Cause                 | Solution                |
| -------------------- | --------------------- | ----------------------- |
| `invalid_grant`      | Token revoked/expired | Re-authenticate         |
| `invalid_client`     | Wrong OAuth client    | Use correct credentials |
| `RESOURCE_EXHAUSTED` | Rate limit            | Wait or switch accounts |
| `401 Unauthorized`   | Access token expired  | Auto-refreshed          |

## Related Projects

- **opencode-antigravity-auth** - https://github.com/NoeFabris/opencode-antigravity-auth
- **Antigravity-Manager** - https://github.com/lbjlaq/Antigravity-Manager
- **CLIProxyAPI** - https://github.com/router-for-me/CLIProxyAPI

### Gemini CLI OAuth

Token location: `~/.gemini/oauth_creds.json`
Endpoint: `https://cloudcode-pa.googleapis.com`

### Claude Code OAuth (different system)

Token location: `~/.claude/.credentials.json`

- Access tokens: `sk-ant-oat01-*` (8 hour expiry)
- Refresh tokens: `sk-ant-ort01-*`
- API endpoint: `https://api.anthropic.com/v1/messages`
