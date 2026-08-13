/**
 * The single place this project talks to the model provider.
 *
 * Everything provider-related is pinned here: the API key, the base URL, the model
 * id, and the token ceiling. No other module should construct a client or hard-code
 * a model string — import `MODEL` and `getClient()` instead.
 *
 * Auth uses **OpenCode** (`OPENCODE_API_KEY`), not a personal Anthropic key. The
 * Anthropic SDK is still the transport: it is pointed at the OpenCode gateway via
 * `baseURL`, so the Messages API surface is unchanged for callers.
 *
 * This module deliberately contains no prompt and no pipeline. The reconciliation
 * prompt and the call that uses it belong to the engine epic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";

/**
 * The pinned model. Change it here and nowhere else.
 * Must be a model id the configured OpenCode gateway serves.
 */
export const MODEL = "claude-opus-5" as const;

/**
 * Default output ceiling. 16k keeps non-streaming requests inside the SDK's HTTP
 * timeout; switch to `client.messages.stream()` before raising this much higher.
 */
export const DEFAULT_MAX_TOKENS = 16_000;

/** Default reasoning effort for reconciliation calls. */
export const DEFAULT_EFFORT = "high" as const;

/** Env var holding the OpenCode API key. Loaded from `.env`, which is gitignored. */
export const API_KEY_ENV_VAR = "OPENCODE_API_KEY";

/** Optional env var overriding the gateway base URL. */
export const BASE_URL_ENV_VAR = "OPENCODE_BASE_URL";

/** Gateway used when `OPENCODE_BASE_URL` is not set. */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

let dotenvLoaded = false;
let client: Anthropic | undefined;

/** Loads `.env` into `process.env` once. Existing env vars win. */
function ensureDotenv(): void {
  if (!dotenvLoaded) {
    loadDotenv({ quiet: true });
    dotenvLoaded = true;
  }
}

/** True when an API key is available. Lets tests and scripts skip live calls. */
export function hasApiKey(): boolean {
  ensureDotenv();
  return Boolean(process.env[API_KEY_ENV_VAR]);
}

/** The gateway base URL in effect. */
export function getBaseUrl(): string {
  ensureDotenv();
  return process.env[BASE_URL_ENV_VAR] || DEFAULT_BASE_URL;
}

/**
 * Returns the shared, configured client.
 *
 * @throws if `OPENCODE_API_KEY` is not set — with a message that says how to fix it.
 */
export function getClient(): Anthropic {
  ensureDotenv();

  const apiKey = process.env[API_KEY_ENV_VAR];
  if (!apiKey) {
    throw new Error(
      `${API_KEY_ENV_VAR} is not set. Copy .env.example to .env and add your OpenCode ` +
        `key (see README.md → Setup). Never commit the .env file.`,
    );
  }

  client ??= new Anthropic({ apiKey, baseURL: getBaseUrl() });
  return client;
}

/** Resets the memoised client. Test-only. */
export function resetClient(): void {
  client = undefined;
}
