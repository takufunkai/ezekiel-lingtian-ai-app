import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  MODEL,
  MODEL_ENV_VAR,
  OPENAI_BASE_URL_ENV_VAR,
  getBaseUrl,
  getClient,
  getModel,
  resetClient,
} from "../src/client.js";

describe("model provider client wrapper", () => {
  const managedVars = [
    API_KEY_ENV_VAR,
    BASE_URL_ENV_VAR,
    OPENAI_BASE_URL_ENV_VAR,
    MODEL_ENV_VAR,
  ] as const;
  const originals = new Map(managedVars.map((name) => [name, process.env[name]]));

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeEach(() => {
    resetClient();
    // Tests must behave identically with and without a developer's local .env,
    // so every managed var starts each test unset. The .env load is lazy and
    // one-time — trigger it first, or the first accessor called below would
    // re-introduce the developer's values after the deletions.
    getBaseUrl();
    for (const name of managedVars) delete process.env[name];
  });

  afterEach(() => {
    for (const name of managedVars) restore(name, originals.get(name));
    resetClient();
  });

  it("pins the fallback model in exactly one place", () => {
    expect(MODEL).toBe("claude-opus-5");
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThan(0);
  });

  it("uses LLM_MODEL from the env, falling back to the pinned model", () => {
    expect(getModel()).toBe(MODEL);

    process.env[MODEL_ENV_VAR] = "minimax-m3";
    expect(getModel()).toBe("minimax-m3");
  });

  it("authenticates with OPENCODE_API_KEY, not an Anthropic key", () => {
    expect(API_KEY_ENV_VAR).toBe("OPENCODE_API_KEY");
  });

  it("fails with an actionable message when the API key is missing", () => {
    delete process.env[API_KEY_ENV_VAR];
    expect(() => getClient()).toThrow(/OPENCODE_API_KEY is not set/);
  });

  it("defaults the gateway base URL and lets the env override it", () => {
    expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);

    process.env[BASE_URL_ENV_VAR] = "https://gateway.internal";
    expect(getBaseUrl()).toBe("https://gateway.internal");
  });

  it("honors OPENAI_BASE_URL when OPENCODE_BASE_URL is not set", () => {
    process.env[OPENAI_BASE_URL_ENV_VAR] = "https://opencode.ai/zen/go/v1";
    expect(getBaseUrl()).toBe("https://opencode.ai/zen/go");

    process.env[BASE_URL_ENV_VAR] = "https://gateway.internal";
    expect(getBaseUrl()).toBe("https://gateway.internal");
  });

  it("strips a trailing /v1 because the SDK appends /v1/messages itself", () => {
    process.env[BASE_URL_ENV_VAR] = "https://gateway.internal/v1/";
    expect(getBaseUrl()).toBe("https://gateway.internal");

    process.env[BASE_URL_ENV_VAR] = "https://gateway.internal/v1";
    expect(getBaseUrl()).toBe("https://gateway.internal");
  });

  it("returns the same client instance on repeated calls", () => {
    process.env[API_KEY_ENV_VAR] = "test-key";
    expect(getClient()).toBe(getClient());
  });
});
