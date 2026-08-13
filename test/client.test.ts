import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  MODEL,
  MODEL_ENV_VAR,
  OPENAI_BASE_URL_ENV_VAR,
  SUPPORTED_MODELS,
  ensureDotenv,
  getBaseUrl,
  getClient,
  getModel,
  resetClient,
} from "../src/client.js";
import { callLiveModel } from "../src/model-caller.js";

// Load .env BEFORE snapshotting, so vars that exist only in a developer's
// local .env are captured and restored — not deleted forever by afterEach.
ensureDotenv();

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
    // so every managed var starts each test unset. The module-scope
    // ensureDotenv() above already latched the one-shot load, so nothing can
    // re-introduce the developer's values after these deletions.
    for (const name of managedVars) delete process.env[name];
  });

  afterEach(() => {
    for (const name of managedVars) restore(name, originals.get(name));
    resetClient();
    vi.restoreAllMocks();
  });

  it("falls back to a pinned model that is on the supported-models allowlist", () => {
    expect(MODEL).toBe("claude-opus-5");
    expect(SUPPORTED_MODELS).toContain(MODEL);
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThan(0);
  });

  it("uses LLM_MODEL from the env, falling back to the pinned model", () => {
    expect(getModel()).toBe(MODEL);

    process.env[MODEL_ENV_VAR] = "minimax-m3";
    expect(getModel()).toBe("minimax-m3");
  });

  it("treats a whitespace-only LLM_MODEL as unset", () => {
    process.env[MODEL_ENV_VAR] = "   ";
    expect(getModel()).toBe(MODEL);
  });

  it("rejects a model outside the allowlist with an actionable error", () => {
    process.env[MODEL_ENV_VAR] = "gpt-6";
    expect(() => getModel()).toThrow(/LLM_MODEL="gpt-6" is not a supported model/);
    expect(() => getModel()).toThrow(/npm run smoke/);
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

  it("ships a default base URL that is an absolute URL", () => {
    expect(() => new URL(DEFAULT_BASE_URL)).not.toThrow();
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

  it("applies the default after stripping, so a value that strips to nothing falls back", () => {
    process.env[BASE_URL_ENV_VAR] = "/v1";
    expect(getBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it("rejects a base URL that is not absolute, naming the env var", () => {
    process.env[BASE_URL_ENV_VAR] = "opencode.ai/zen";
    expect(() => getBaseUrl()).toThrow(
      /OPENCODE_BASE_URL="opencode\.ai\/zen" is not an absolute URL/,
    );
  });

  it("refuses a non-https OPENAI_BASE_URL, but allows it via OPENCODE_BASE_URL", () => {
    // OPENAI_BASE_URL is set machine-wide by unrelated tools; silently sending
    // the key to a plaintext endpoint it names would be a hijack, not config.
    process.env[OPENAI_BASE_URL_ENV_VAR] = "http://localhost:4000/v1";
    expect(() => getBaseUrl()).toThrow(/OPENAI_BASE_URL.*is not https/);

    // The project-owned var is deliberate, so it may point anywhere.
    process.env[BASE_URL_ENV_VAR] = "http://localhost:4000/v1";
    expect(getBaseUrl()).toBe("http://localhost:4000");
  });

  it("returns the same client instance on repeated calls", () => {
    process.env[API_KEY_ENV_VAR] = "test-key";
    expect(getClient()).toBe(getClient());
  });

  it("puts the configured model on the wire in the live model caller", async () => {
    process.env[API_KEY_ENV_VAR] = "test-key";
    process.env[MODEL_ENV_VAR] = "minimax-m3";

    const create = vi.spyOn(getClient().beta.messages, "create").mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"ok":true}' }],
    } as never);

    await callLiveModel({ system: "s", userMessage: "u", outputSchema: { type: "object" } });

    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![0];
    expect(body.model).toBe("minimax-m3");
    expect(body.model).toBe(getModel());
  });
});
