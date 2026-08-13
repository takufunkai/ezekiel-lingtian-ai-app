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
 * The fallback model when `LLM_MODEL` is not set in the environment.
 * Must be a model id the configured OpenCode gateway serves.
 */
export const MODEL = "claude-opus-5" as const;

/** Env var selecting the model id. Loaded from `.env`, which is gitignored. */
export const MODEL_ENV_VAR = "LLM_MODEL";

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

/** Also honored (OpenAI-style tooling convention), after `OPENCODE_BASE_URL`. */
export const OPENAI_BASE_URL_ENV_VAR = "OPENAI_BASE_URL";

/**
 * Gateway used when no base-URL env var is set.
 *
 * No `/v1` suffix: the Anthropic SDK appends `/v1/messages` itself, which is
 * why the previous default (`https://opencode.ai/zen/v1`) 404'd — requests
 * went to `/zen/v1/v1/messages`.
 */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen";

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

/** The model id in effect: `LLM_MODEL` from the env when set, else `MODEL`. */
export function getModel(): string {
  ensureDotenv();
  return process.env[MODEL_ENV_VAR] || MODEL;
}

/**
 * The gateway base URL in effect.
 *
 * A configured value ending in `/v1` (the convention OpenAI-style tooling
 * expects, e.g. `OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`) is stripped of
 * that suffix, because the Anthropic SDK appends `/v1/messages` itself.
 */
export function getBaseUrl(): string {
  ensureDotenv();
  const configured =
    process.env[BASE_URL_ENV_VAR] || process.env[OPENAI_BASE_URL_ENV_VAR] || DEFAULT_BASE_URL;
  return configured.replace(/\/v1\/?$/, "");
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
