/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

import app from "./server.js";
import { DEFAULT_PORT } from "./constants.js";
import { initLogger, getLogger } from "./utils/logger-new.js";
import { banner } from "./cli/ui.js";
import path from "path";
import os from "os";

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes("--debug") || process.env.DEBUG === "true";
const isFallbackEnabled = args.includes("--fallback") || process.env.FALLBACK === "true";

// Initialize logger with appropriate level
initLogger({ level: isDebug ? "debug" : "info" });
const logger = getLogger();

if (isDebug) {
  logger.debug("Debug mode enabled");
}

if (isFallbackEnabled) {
  logger.info("Model fallback mode enabled");
}

// Export fallback flag for server to use
export const FALLBACK_ENABLED = isFallbackEnabled;

const PORT = process.env.PORT ?? DEFAULT_PORT;

// Home directory for account storage
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, ".antigravity-claude-proxy");

// Read version from package.json
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
const VERSION = packageJson.version;

app.listen(PORT, () => {
  // Clear console for a clean start
  console.clear();

  // Show startup banner
  console.log(banner("Antigravity Claude Proxy", VERSION));
  console.log();

  // Log startup info with structured metadata
  logger.info({ port: PORT, configDir: CONFIG_DIR }, "Server started");

  if (isDebug) {
    logger.warn("Running in DEBUG mode - verbose logs enabled");
  }

  if (isFallbackEnabled) {
    logger.info("Model fallback enabled - will switch models on quota exhaustion");
  }

  // Log endpoints
  logger.info({ endpoints: ["POST /v1/messages - Anthropic Messages API", "GET  /v1/models - List available models", "GET  /health - Health check", "GET  /account-limits - Account status & quotas", "POST /refresh-token - Force token refresh"] }, "Available endpoints");

  // Log usage instructions
  logger.info(
    {
      env: {
        ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
        ANTHROPIC_API_KEY: "dummy",
      },
    },
    "Claude Code usage",
  );
});
