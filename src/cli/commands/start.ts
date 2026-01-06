/**
 * start command
 *
 * Start the proxy server.
 */

import path from "path";
import os from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import app from "../../server.js";
import { DEFAULT_PORT } from "../../constants.js";
import { getLogger } from "../../utils/logger-new.js";
import { banner } from "../ui.js";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
const VERSION = packageJson.version;

/**
 * Command options for the start command.
 */
export interface StartCommandOptions {
  port?: number;
  fallback?: boolean;
  debug?: boolean;
}

/**
 * Execute the start command.
 *
 * Starts the Express server on the specified port.
 *
 * @param options - Command options
 */
export function startCommand(options: StartCommandOptions): void {
  const logger = getLogger();
  const port = options.port ?? DEFAULT_PORT;

  // Show banner
  console.log(banner("Antigravity Claude Proxy", VERSION));

  // Home directory for account storage (for logging)
  const configDir = path.join(os.homedir(), ".antigravity-claude-proxy");

  // Set environment variables for fallback mode if enabled
  if (options.fallback) {
    process.env.FALLBACK = "true";
  }

  app.listen(port, () => {
    // Log startup info with structured metadata
    logger.info({ port, configDir }, "Server started");

    if (options.debug) {
      logger.warn("Running in DEBUG mode - verbose logs enabled");
    }

    if (options.fallback) {
      logger.info("Model fallback enabled - will switch models on quota exhaustion");
    }

    // Log endpoints
    logger.info(
      {
        endpoints: ["POST /v1/messages - Anthropic Messages API", "GET  /v1/models - List available models", "GET  /health - Health check", "GET  /account-limits - Account status & quotas", "POST /refresh-token - Force token refresh"],
      },
      "Available endpoints",
    );

    // Log usage instructions
    logger.info(
      {
        env: {
          ANTHROPIC_BASE_URL: `http://localhost:${port}`,
          ANTHROPIC_API_KEY: "dummy",
        },
      },
      "Claude Code usage",
    );
  });
}
