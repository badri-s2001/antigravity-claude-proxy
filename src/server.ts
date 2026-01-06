/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 */

import express, { type Request, type Response, type NextFunction, type Application } from "express";
import cors from "cors";
import { sendMessage, sendMessageStream, listModels, getModelQuotas } from "./cloudcode/index.js";
import { forceRefresh } from "./auth/token-extractor.js";
import { REQUEST_BODY_LIMIT } from "./constants.js";
import { AccountManager } from "./account-manager/index.js";
import { formatDuration } from "./utils/helpers.js";
import { getLogger } from "./utils/logger-new.js";
import type { AnthropicRequest } from "./format/types.js";

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);
const FALLBACK_ENABLED = args.includes("--fallback") || process.env.FALLBACK === "true";

// Get logger instance
const logger = getLogger();

const app: Application = express();

// Initialize account manager (will be fully initialized on first request or startup)
const accountManager = new AccountManager();

// Track initialization status
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Account source type
 */
type AccountSource = "oauth" | "database" | "manual";

/**
 * Account with model rate limits
 */
interface AccountWithRateLimits {
  email: string;
  source: AccountSource;
  lastUsed: number | null;
  modelRateLimits: Record<string, { isRateLimited: boolean; resetTime: number | null }>;
  isInvalid?: boolean | undefined;
  invalidReason?: string | null | undefined;
}

/**
 * Model quota information
 */
interface ModelQuota {
  remainingFraction: number | null;
  resetTime?: string | null;
}

/**
 * Parsed error response
 */
interface ParsedError {
  errorType: string;
  statusCode: number;
  errorMessage: string;
}

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized(): Promise<void> {
  if (isInitialized) return;

  // If initialization is already in progress, wait for it
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await accountManager.initialize();
      isInitialized = true;
      const status = accountManager.getStatus();
      logger.info({ accounts: status.summary }, "[Server] Account pool initialized");
    } catch (error) {
      initPromise = null; // Allow retry on failure
      logger.error({ error: (error as Error).message }, "[Server] Failed to initialize account manager");
      throw error;
    }
  })();

  return initPromise;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error: Error): ParsedError {
  let errorType = "api_error";
  let statusCode = 500;
  let errorMessage = error.message;

  if (error.message.includes("401") || error.message.includes("UNAUTHENTICATED")) {
    errorType = "authentication_error";
    statusCode = 401;
    errorMessage = "Authentication failed. Make sure Antigravity is running with a valid token.";
  } else if (error.message.includes("429") || error.message.includes("RESOURCE_EXHAUSTED") || error.message.includes("QUOTA_EXHAUSTED")) {
    errorType = "invalid_request_error"; // Use invalid_request_error to force client to purge/stop
    statusCode = 400; // Use 400 to ensure client does not retry (429 and 529 trigger retries)

    // Try to extract the quota reset time from the error
    const resetMatch = /quota will reset after ([\dh\dm\ds]+)/i.exec(error.message);
    // Try to extract model from our error format "Rate limited on <model>" or JSON format
    const modelMatch = /Rate limited on ([^.]+)\./.exec(error.message) ?? /"model":\s*"([^"]+)"/.exec(error.message);
    const model = modelMatch ? modelMatch[1] : "the model";

    if (resetMatch) {
      errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
    } else {
      errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
    }
  } else if (error.message.includes("invalid_request_error") || error.message.includes("INVALID_ARGUMENT")) {
    errorType = "invalid_request_error";
    statusCode = 400;
    const msgMatch = /"message":"([^"]+)"/.exec(error.message);
    if (msgMatch) errorMessage = msgMatch[1];
  } else if (error.message.includes("All endpoints failed")) {
    errorType = "api_error";
    statusCode = 503;
    errorMessage = "Unable to connect to Claude API. Check that Antigravity is running.";
  } else if (error.message.includes("PERMISSION_DENIED")) {
    errorType = "permission_error";
    statusCode = 403;
    errorMessage = "Permission denied. Check your Antigravity license.";
  }

  return { errorType, statusCode, errorMessage };
}

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  // Skip logging for event logging batch unless in debug mode
  if (req.path === "/api/event_logging/batch") {
    if (logger.isLevelEnabled("debug")) {
      logger.debug(`[${req.method}] ${req.path}`);
    }
  } else {
    logger.info(`[${req.method}] ${req.path}`);
  }
  next();
});

/**
 * Health check endpoint - Detailed status
 * Returns status of all accounts including rate limits and model quotas
 */
app.get("/health", async (_req: Request, res: Response) => {
  try {
    await ensureInitialized();
    const start = Date.now();

    // Get high-level status first
    const status = accountManager.getStatus();
    const allAccounts = accountManager.getAllAccounts() as AccountWithRateLimits[];

    // Fetch quotas for each account in parallel to get detailed model info
    const accountDetails = await Promise.allSettled(
      allAccounts.map(async (account) => {
        // Check model-specific rate limits
        const activeModelLimits = Object.entries(account.modelRateLimits ?? {}).filter(([, limit]) => limit.isRateLimited && limit.resetTime !== null && limit.resetTime > Date.now());
        const isRateLimited = activeModelLimits.length > 0;
        const soonestReset = activeModelLimits.length > 0 ? Math.min(...activeModelLimits.map(([, l]) => l.resetTime!)) : null;

        const baseInfo = {
          email: account.email,
          lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
          modelRateLimits: account.modelRateLimits ?? {},
          rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0,
        };

        // Skip invalid accounts for quota check
        if (account.isInvalid) {
          return {
            ...baseInfo,
            status: "invalid" as const,
            error: account.invalidReason,
            models: {},
          };
        }

        try {
          const token = await accountManager.getTokenForAccount(account);
          const quotas = (await getModelQuotas(token)) as Record<string, ModelQuota>;

          // Format quotas for readability
          const formattedQuotas: Record<string, { remaining: string; remainingFraction: number | null; resetTime: string | null }> = {};
          for (const [modelId, info] of Object.entries(quotas)) {
            formattedQuotas[modelId] = {
              remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : "N/A",
              remainingFraction: info.remainingFraction,
              resetTime: info.resetTime ?? null,
            };
          }

          return {
            ...baseInfo,
            status: isRateLimited ? ("rate-limited" as const) : ("ok" as const),
            models: formattedQuotas,
          };
        } catch (error) {
          return {
            ...baseInfo,
            status: "error" as const,
            error: (error as Error).message,
            models: {},
          };
        }
      }),
    );

    // Process results
    const detailedAccounts = accountDetails.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        const acc = allAccounts[index];
        return {
          email: acc.email,
          status: "error" as const,
          error: (result.reason as Error | undefined)?.message ?? "Unknown error",
          modelRateLimits: acc.modelRateLimits ?? {},
        };
      }
    });

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - start,
      summary: status.summary,
      counts: {
        total: status.total,
        available: status.available,
        rateLimited: status.rateLimited,
        invalid: status.invalid,
      },
      accounts: detailedAccounts,
    });
  } catch (error) {
    logger.error({ err: error }, "[API] Health check failed");
    res.status(503).json({
      status: "error",
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Account limits endpoint - fetch quota/limits for all accounts x all models
 * Returns a table showing remaining quota and reset time for each combination
 * Use ?format=table for ASCII table output, default is JSON
 */
app.get("/account-limits", async (req: Request, res: Response) => {
  try {
    await ensureInitialized();
    const allAccounts = accountManager.getAllAccounts() as AccountWithRateLimits[];
    const format = (req.query.format as string) ?? "json";

    // Fetch quotas for each account in parallel
    const results = await Promise.allSettled(
      allAccounts.map(async (account) => {
        // Skip invalid accounts
        if (account.isInvalid) {
          return {
            email: account.email,
            status: "invalid" as const,
            error: account.invalidReason,
            models: {} as Record<string, ModelQuota>,
          };
        }

        try {
          const token = await accountManager.getTokenForAccount(account);
          const quotas = (await getModelQuotas(token)) as Record<string, ModelQuota>;

          return {
            email: account.email,
            status: "ok" as const,
            models: quotas,
          };
        } catch (error) {
          return {
            email: account.email,
            status: "error" as const,
            error: (error as Error).message,
            models: {} as Record<string, ModelQuota>,
          };
        }
      }),
    );

    // Process results
    interface AccountLimit {
      email: string;
      status: string;
      error?: string | null;
      models: Record<string, ModelQuota>;
    }
    const accountLimits: AccountLimit[] = results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        return {
          email: allAccounts[index].email,
          status: "error",
          error: (result.reason as Error | undefined)?.message ?? "Unknown error",
          models: {},
        };
      }
    });

    // Collect all unique model IDs
    const allModelIds = new Set<string>();
    for (const account of accountLimits) {
      for (const modelId of Object.keys(account.models ?? {})) {
        allModelIds.add(modelId);
      }
    }

    const sortedModels = Array.from(allModelIds).sort();

    // Return ASCII table format
    if (format === "table") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");

      // Build table
      const lines: string[] = [];
      const timestamp = new Date().toLocaleString();
      lines.push(`Account Limits (${timestamp})`);

      // Get account status info
      const status = accountManager.getStatus();
      lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
      lines.push("");

      // Table 1: Account status
      const accColWidth = 25;
      const statusColWidth = 15;
      const lastUsedColWidth = 25;
      const resetColWidth = 25;

      const accHeader = "Account".padEnd(accColWidth) + "Status".padEnd(statusColWidth) + "Last Used".padEnd(lastUsedColWidth) + "Quota Reset";
      lines.push(accHeader);
      lines.push("\u2500".repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

      for (const acc of status.accounts) {
        const shortEmail = acc.email.split("@")[0]?.slice(0, 22) ?? "";
        const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : "never";

        // Get status and error from accountLimits
        const accLimit = accountLimits.find((a) => a.email === acc.email);
        let accStatus: string;
        if (acc.isInvalid) {
          accStatus = "invalid";
        } else if (accLimit?.status === "error") {
          accStatus = "error";
        } else {
          // Count exhausted models (0% or null remaining)
          const models = accLimit?.models ?? {};
          const modelCount = Object.keys(models).length;
          const exhaustedCount = Object.values(models).filter((q) => q.remainingFraction === 0 || q.remainingFraction === null).length;

          if (exhaustedCount === 0) {
            accStatus = "ok";
          } else {
            accStatus = `(${exhaustedCount}/${modelCount}) limited`;
          }
        }

        // Get reset time from quota API
        const claudeModel = sortedModels.find((m) => m.includes("claude"));
        const quota = claudeModel ? accLimit?.models?.[claudeModel] : undefined;
        const resetTime = quota && typeof quota === "object" && quota.resetTime ? new Date(quota.resetTime).toLocaleString() : "-";

        const row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

        // Add error on next line if present
        if (accLimit?.error) {
          lines.push(row);
          lines.push("  \u2514\u2500 " + accLimit.error);
        } else {
          lines.push(row);
        }
      }
      lines.push("");

      // Calculate column widths - need more space for reset time info
      const modelColWidth = Math.max(28, ...sortedModels.map((m) => m.length)) + 2;
      const accountColWidth = 30;

      // Header row
      let header = "Model".padEnd(modelColWidth);
      for (const acc of accountLimits) {
        const shortEmail = acc.email.split("@")[0]?.slice(0, 26) ?? "";
        header += shortEmail.padEnd(accountColWidth);
      }
      lines.push(header);
      lines.push("\u2500".repeat(modelColWidth + accountLimits.length * accountColWidth));

      // Data rows
      for (const modelId of sortedModels) {
        let row = modelId.padEnd(modelColWidth);
        for (const acc of accountLimits) {
          const quota = acc.models?.[modelId];
          let cell: string;
          if (acc.status !== "ok" && acc.status !== "rate-limited") {
            cell = `[${acc.status}]`;
          } else if (!quota) {
            cell = "-";
          } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
            // Show reset time for exhausted models
            if (quota.resetTime) {
              const resetMs = new Date(quota.resetTime).getTime() - Date.now();
              if (resetMs > 0) {
                cell = `0% (wait ${formatDuration(resetMs)})`;
              } else {
                cell = "0% (resetting...)";
              }
            } else {
              cell = "0% (exhausted)";
            }
          } else {
            const pct = Math.round(quota.remainingFraction * 100);
            cell = `${pct}%`;
          }
          row += cell.padEnd(accountColWidth);
        }
        lines.push(row);
      }

      return res.send(lines.join("\n"));
    }

    // Default: JSON format
    res.json({
      timestamp: new Date().toLocaleString(),
      totalAccounts: allAccounts.length,
      models: sortedModels,
      accounts: accountLimits.map((acc) => ({
        email: acc.email,
        status: acc.status,
        error: acc.error ?? null,
        limits: Object.fromEntries(
          sortedModels.map((modelId) => {
            const quota = acc.models?.[modelId];
            if (!quota) {
              return [modelId, null];
            }
            return [
              modelId,
              {
                remaining: quota.remainingFraction !== null ? `${Math.round(quota.remainingFraction * 100)}%` : "N/A",
                remainingFraction: quota.remainingFraction,
                resetTime: quota.resetTime ?? null,
              },
            ];
          }),
        ),
      })),
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: (error as Error).message,
    });
  }
});

/**
 * Force token refresh endpoint
 */
app.post("/refresh-token", async (_req: Request, res: Response) => {
  try {
    await ensureInitialized();
    // Clear all caches
    accountManager.clearTokenCache();
    accountManager.clearProjectCache();
    // Force refresh default token
    const token = await forceRefresh();
    res.json({
      status: "ok",
      message: "Token caches cleared and refreshed",
      tokenPrefix: token.substring(0, 10) + "...",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: (error as Error).message,
    });
  }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get("/v1/models", async (_req: Request, res: Response) => {
  try {
    await ensureInitialized();
    const account = accountManager.pickNext();
    if (!account) {
      return res.status(503).json({
        type: "error",
        error: {
          type: "api_error",
          message: "No accounts available",
        },
      });
    }
    const token = await accountManager.getTokenForAccount(account);
    const models = await listModels(token);
    res.json(models);
  } catch (error) {
    logger.error({ err: error }, "[API] Error listing models");
    res.status(500).json({
      type: "error",
      error: {
        type: "api_error",
        message: (error as Error).message,
      },
    });
  }
});

/**
 * Count tokens endpoint (not supported)
 */
app.post("/v1/messages/count_tokens", (_req: Request, res: Response) => {
  res.status(501).json({
    type: "error",
    error: {
      type: "not_implemented",
      message: "Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.",
    },
  });
});

/**
 * Request body for /v1/messages endpoint
 */
interface MessagesRequestBody {
  model?: string;
  messages?: {
    role: string;
    content: string | { type: string; [key: string]: unknown }[];
  }[];
  max_tokens?: number;
  stream?: boolean;
  system?: string | { type: string; text: string }[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: { type?: string; budget_tokens?: number };
  top_p?: number;
  top_k?: number;
  temperature?: number;
}

/**
 * Extended Response type with flush method for streaming
 */
interface FlushableResponse extends Response {
  flush?: () => void;
}

/**
 * Anthropic-compatible Messages API
 * POST /v1/messages
 */
app.post("/v1/messages", async (req: Request<object, unknown, MessagesRequestBody>, res: FlushableResponse) => {
  try {
    // Ensure account manager is initialized
    await ensureInitialized();

    const { model, messages, max_tokens, stream, system, tools, tool_choice, thinking, top_p, top_k, temperature } = req.body;

    // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
    // If we have some available accounts, we try them first.
    const modelId = model ?? "claude-3-5-sonnet-20241022";
    if (accountManager.isAllRateLimited(modelId)) {
      logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
      accountManager.resetAllRateLimits();
    }

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages is required and must be an array",
        },
      });
    }

    // Build the request object
    const request: AnthropicRequest = {
      model: model ?? "claude-3-5-sonnet-20241022",
      messages: messages as AnthropicRequest["messages"],
      max_tokens: max_tokens ?? 4096,
      stream,
      system: system as AnthropicRequest["system"],
      tools: tools as AnthropicRequest["tools"],
      tool_choice: tool_choice,
      thinking,
      top_p,
      top_k,
      temperature,
    };

    logger.info({ model: request.model, stream: !!stream }, "[API] Request received");

    // Debug: Log message structure to diagnose tool_use/tool_result ordering
    if (logger.isLevelEnabled("debug")) {
      logger.debug("[API] Message structure:");
      messages.forEach((msg, i) => {
        const contentTypes = Array.isArray(msg.content) ? msg.content.map((c) => c.type ?? "text").join(", ") : typeof msg.content === "string" ? "text" : "unknown";
        logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
      });
    }

    if (stream) {
      // Handle streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // Flush headers immediately to start the stream
      res.flushHeaders();

      try {
        // Use the streaming generator with account manager
        for await (const event of sendMessageStream(request, accountManager, FALLBACK_ENABLED)) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          // Flush after each event for real-time streaming
          if (res.flush) res.flush();
        }
        res.end();
      } catch (streamError) {
        logger.error({ err: streamError }, "[API] Stream error");

        const { errorType, errorMessage } = parseError(streamError as Error);

        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: errorType, message: errorMessage },
          })}\n\n`,
        );
        res.end();
      }
    } else {
      // Handle non-streaming response
      const response = await sendMessage(request, accountManager, FALLBACK_ENABLED);
      res.json(response);
    }
  } catch (error) {
    logger.error({ err: error }, "[API] Error");

    const { errorType, statusCode, errorMessage: initialErrorMessage } = parseError(error as Error);
    let errorMessage = initialErrorMessage;

    // For auth errors, try to refresh token
    if (errorType === "authentication_error") {
      logger.warn("[API] Token might be expired, attempting refresh...");
      try {
        accountManager.clearProjectCache();
        accountManager.clearTokenCache();
        await forceRefresh();
        errorMessage = "Token was expired and has been refreshed. Please retry your request.";
      } catch {
        errorMessage = "Could not refresh token. Make sure Antigravity is running.";
      }
    }

    logger.warn({ statusCode, errorType, errorMessage }, "[API] Returning error response");

    // Check if headers have already been sent (for streaming that failed mid-way)
    if (res.headersSent) {
      logger.warn("[API] Headers already sent, writing error as SSE event");
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: errorType, message: errorMessage },
        })}\n\n`,
      );
      res.end();
    } else {
      res.status(statusCode).json({
        type: "error",
        error: {
          type: errorType,
          message: errorMessage,
        },
      });
    }
  }
});

/**
 * Catch-all for unsupported endpoints
 */
app.use("*", (req: Request, res: Response) => {
  if (logger.isLevelEnabled("debug")) {
    logger.debug({ method: req.method, url: req.originalUrl }, "[API] 404 Not Found");
  }
  res.status(404).json({
    type: "error",
    error: {
      type: "not_found_error",
      message: `Endpoint ${req.method} ${req.originalUrl} not found`,
    },
  });
});

export default app;
