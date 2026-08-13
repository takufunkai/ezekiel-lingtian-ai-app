/**
 * The single place this project talks to the model provider.
 *
 * Everything provider-related is pinned here: the API key, the base URL, the model
 * id, and the token ceiling. No other module should construct a client or hard-code
 * a model string — import `getModel()` and `getClient()` instead.
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
 * Model ids verified to work with the exact request shape in
 * `src/model-caller.ts` (structured-outputs beta flag, top-level
 * `output_format`, `output_config.effort`, no sampling params). That shape is
 * model-specific, so `LLM_MODEL` is validated against this list rather than
 * passed through blindly — an unsupported model would otherwise surface as an
 * opaque schema-validation retry loop in the engine. Verify a new model with
 * `npm run smoke` before adding it here.
 */
export const SUPPORTED_MODELS = ["claude-opus-5", "minimax-m3"] as const;

/** A model id known to work with this project's request shape. */
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

/**
 * The fallback model when `LLM_MODEL` is not set in the environment.
 * Must be a model id the configured OpenCode gateway serves.
 */
export const MODEL: SupportedModel = "claude-opus-5";

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

/**
 * Loads `.env` into `process.env` once. Existing env vars win. Idempotent.
 * Exported so tests can snapshot/restore the environment without depending on
 * which accessor happens to trigger the one-shot load internally.
 */
export function ensureDotenv(): void {
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

/**
 * The model id in effect: `LLM_MODEL` from the env when set (trimmed;
 * whitespace-only counts as unset), else `MODEL`.
 *
 * @throws when `LLM_MODEL` names a model outside {@link SUPPORTED_MODELS} —
 * the request shape in `model-caller.ts` is model-specific, so an unvetted id
 * must fail loudly here rather than as an opaque retry loop downstream.
 */
export function getModel(): SupportedModel {
  ensureDotenv();
  const configured = process.env[MODEL_ENV_VAR]?.trim();
  if (!configured) {
    return MODEL;
  }
  if (!(SUPPORTED_MODELS as readonly string[]).includes(configured)) {
    throw new Error(
      `${MODEL_ENV_VAR}="${configured}" is not a supported model. This project's ` +
        `structured-output request shape is only verified against: ${SUPPORTED_MODELS.join(", ")}. ` +
        `Unset ${MODEL_ENV_VAR} in .env to use the default (${MODEL}), or verify the new ` +
        `model with \`npm run smoke\` and add it to SUPPORTED_MODELS in src/client.ts.`,
    );
  }
  return configured as SupportedModel;
}

/**
 * The gateway base URL in effect.
 *
 * A configured value ending in `/v1` (the convention OpenAI-style tooling
 * expects, e.g. `OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`) is stripped of
 * that suffix, because the Anthropic SDK appends `/v1/messages` itself. The
 * default applies after stripping, so a value that strips to nothing falls
 * back rather than producing an empty base URL.
 *
 * @throws when the configured value is not an absolute URL, or when
 * `OPENAI_BASE_URL` — a machine-wide var many unrelated tools set — points at
 * a non-https host. The latter guards against silently sending the OpenCode
 * key and the source corpus to an endpoint configured for some other tool.
 * `OPENCODE_BASE_URL` is project-owned and deliberate, so it carries no
 * scheme restriction.
 */
export function getBaseUrl(): string {
  ensureDotenv();
  const opencodeUrl = process.env[BASE_URL_ENV_VAR]?.trim();
  const openaiUrl = process.env[OPENAI_BASE_URL_ENV_VAR]?.trim();
  const sourceVar = opencodeUrl ? BASE_URL_ENV_VAR : OPENAI_BASE_URL_ENV_VAR;
  const configured = opencodeUrl || openaiUrl || DEFAULT_BASE_URL;
  const baseUrl = configured.replace(/\/v1\/?$/, "") || DEFAULT_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `${sourceVar}="${configured}" is not an absolute URL. Use a full URL such as ` +
        `${DEFAULT_BASE_URL} (check your .env).`,
    );
  }

  if (!opencodeUrl && openaiUrl && parsed.protocol !== "https:") {
    throw new Error(
      `${OPENAI_BASE_URL_ENV_VAR}="${openaiUrl}" is not https. Refusing to send the ` +
        `OpenCode key there: ${OPENAI_BASE_URL_ENV_VAR} is often set machine-wide for ` +
        `unrelated tools. If this gateway is intentional, set ${BASE_URL_ENV_VAR} instead.`,
    );
  }

  return baseUrl;
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
