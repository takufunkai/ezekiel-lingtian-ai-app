import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  MODEL,
  getBaseUrl,
  getClient,
  resetClient,
} from "../src/client.js";

describe("model provider client wrapper", () => {
  const originalKey = process.env[API_KEY_ENV_VAR];
  const originalBaseUrl = process.env[BASE_URL_ENV_VAR];

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeEach(() => {
    resetClient();
  });

  afterEach(() => {
    restore(API_KEY_ENV_VAR, originalKey);
    restore(BASE_URL_ENV_VAR, originalBaseUrl);
    resetClient();
  });

  it("pins the model in exactly one place", () => {
    expect(MODEL).toBe("claude-opus-5");
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThan(0);
  });

  it("authenticates with OPENCODE_API_KEY, not an Anthropic key", () => {
    expect(API_KEY_ENV_VAR).toBe("OPENCODE_API_KEY");
  });

  it("fails with an actionable message when the API key is missing", () => {
    delete process.env[API_KEY_ENV_VAR];
    expect(() => getClient()).toThrow(/OPENCODE_API_KEY is not set/);
  });

  it("defaults the gateway base URL and lets the env override it", () => {
    delete process.env[BASE_URL_ENV_VAR];
    expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);

    process.env[BASE_URL_ENV_VAR] = "https://gateway.internal/v1";
    expect(getBaseUrl()).toBe("https://gateway.internal/v1");
  });

  it("returns the same client instance on repeated calls", () => {
    process.env[API_KEY_ENV_VAR] = "test-key";
    expect(getClient()).toBe(getClient());
  });
});
