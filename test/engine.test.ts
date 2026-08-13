import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/client.js";
import { parseArgs } from "../src/cli.js";
import { toModelInput } from "../src/contract.js";
import type { ReconciledProfile, SourceDocument } from "../src/contract.js";
import {
  CLAIMS_TRANSPORT_SCHEMA,
  DEFAULT_MAX_ATTEMPTS,
  loadCaseWithDocuments,
  reconcile,
  reconcileCaseFile,
  toTransportSchema,
  type ModelRequest,
} from "../src/engine.js";
import {
  DEFAULT_PROMPT_VERSION,
  PROMPT_VERSION_ENV_VAR,
  buildUserMessage,
  getPromptVersion,
  getSystemPrompt,
  promptPathFor,
} from "../src/prompt.js";
import { claimsSchema, readJsonFile, validateProfile } from "../src/schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");
const casePath = join(examplesDir, "case.example.json");

/** The hand-written example profile is known schema-valid — the canned "good" response. */
const validProfileJson = readFileSync(join(examplesDir, "reconciled-profile.example.json"), "utf8");

const exampleDocs = ["src-01.json", "src-02.json"].map(
  (name) => readJsonFile(join(examplesDir, "sources", name)) as SourceDocument,
);

/** A canned caller that always returns `responses[i]` for attempt i (last repeats). */
function cannedCaller(...responses: string[]) {
  const calls: ModelRequest[] = [];
  const caller = vi.fn(async (request: ModelRequest): Promise<string> => {
    calls.push(request);
    return responses[Math.min(calls.length, responses.length) - 1]!;
  });
  return { caller, calls };
}

function brokenProfileJson(): string {
  const broken = JSON.parse(validProfileJson) as ReconciledProfile;
  broken.claims[0]!.citations = []; // violates minItems: 1 — the exact failure the schema exists to catch
  return JSON.stringify(broken);
}

describe("model input is stripped to the allowed fields", () => {
  it("toModelInput keeps exactly id, date, title, text", () => {
    const doc: SourceDocument = {
      id: "src-99",
      date: "2024-01-01",
      title: "T",
      text: "body",
      notes: "SECRET-AUTHOR-NOTE",
    };
    const input = toModelInput(doc);
    expect(Object.keys(input).sort()).toEqual(["date", "id", "text", "title"]);
    expect(JSON.stringify(input)).not.toContain("SECRET-AUTHOR-NOTE");
  });

  it("the serialised user message contains no notes key and no notes text", () => {
    // The example documents both carry author notes.
    expect(exampleDocs.every((doc) => doc.notes)).toBe(true);

    const message = buildUserMessage(
      { name: "Nimbus Cartography Collective" },
      exampleDocs.map(toModelInput),
    );
    expect(message).not.toContain('"notes"');
    for (const doc of exampleDocs) {
      expect(message).not.toContain(doc.notes!);
    }
    // The documents themselves are in there.
    expect(message).toContain(exampleDocs[0]!.text);
    expect(message).toContain(exampleDocs[1]!.text);
  });
});

describe("the case manifest never reaches the model", () => {
  it("prompt payloads contain the documents but nothing from the answer key", async () => {
    const { caller, calls } = cannedCaller(validProfileJson);
    const outcome = await reconcileCaseFile(casePath, { callModel: caller, log: () => {} });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const payload = `${calls[0]!.system}\n${calls[0]!.userMessage}`;

    // Manifest keys must be absent…
    for (const key of ['"expect"', '"plantedFact"', '"scenario"', '"notes"', '"questions"']) {
      expect(payload).not.toContain(key);
    }
    // …and so must the answer key's distinctive values.
    expect(payload).not.toContain("Semantically the same question");
    expect(payload).not.toContain("Worked example of the fixture-case format");
    expect(payload).not.toContain("Format example only");

    // While the model inputs are present.
    expect(payload).toContain("Nimbus Cartography Collective");
    for (const doc of exampleDocs) {
      expect(payload).toContain(doc.text);
    }
  });
});

describe("end-to-end run on the example case with a canned response", () => {
  it("produces schema-valid JSON with the configured model stamped on it", async () => {
    const { caller } = cannedCaller(validProfileJson);
    const outcome = await reconcileCaseFile(casePath, { callModel: caller, log: () => {} });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.attempts).toBe(1);
    const check = validateProfile(outcome.profile);
    expect(check.valid).toBe(true);
    expect(outcome.profile.model).toBe(getModel());
  });

  it("every claim carries at least one source id and a verbatim quote", async () => {
    const { caller } = cannedCaller(validProfileJson);
    const outcome = await reconcileCaseFile(casePath, { callModel: caller, log: () => {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const textById = new Map(exampleDocs.map((doc) => [doc.id, doc.text]));
    expect(outcome.profile.claims.length).toBeGreaterThan(0);
    for (const claim of outcome.profile.claims) {
      expect(claim.citations.length).toBeGreaterThanOrEqual(1);
      for (const citation of claim.citations) {
        const sourceText = textById.get(citation.sourceId);
        expect(
          sourceText,
          `claim ${claim.id} cites unknown source ${citation.sourceId}`,
        ).toBeDefined();
        // Verbatim: the quote is an exact substring of the source text.
        expect(sourceText!).toContain(citation.quote);
      }
    }
  });
});

describe("schema violations are rejected and retried, never patched", () => {
  it("fails hard after the bounded number of attempts, with logged reasons", async () => {
    const { caller } = cannedCaller(brokenProfileJson());
    const log = vi.fn();
    const loaded = loadCaseWithDocuments(casePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const outcome = await reconcile(loaded.value, { callModel: caller, log });

    expect(outcome.ok).toBe(false);
    expect(caller).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
    expect(outcome.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(outcome.failures).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    for (const failure of outcome.failures) {
      expect(failure.reasons.join("\n")).toMatch(/schema violation/);
    }
    // Reasons are logged, and the run announces the hard failure.
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toMatch(/giving up/);
  });

  it("a rejected response is retried and the later valid response wins unmodified", async () => {
    const { caller } = cannedCaller(brokenProfileJson(), validProfileJson);
    const loaded = loadCaseWithDocuments(casePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const outcome = await reconcile(loaded.value, { callModel: caller, log: () => {} });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.failures).toHaveLength(1);

    // The result is exactly the valid canned response (plus the model stamp) —
    // nothing was salvaged from the rejected first attempt.
    const expected = JSON.parse(validProfileJson) as ReconciledProfile;
    expect(outcome.profile).toEqual({ ...expected, model: getModel() });
  });

  it("malformed JSON from the model is a rejection, not a crash", async () => {
    const { caller } = cannedCaller("this is not json {");
    const loaded = loadCaseWithDocuments(casePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const outcome = await reconcile(loaded.value, {
      callModel: caller,
      log: () => {},
      maxAttempts: 2,
    });
    expect(outcome.ok).toBe(false);
    expect(caller).toHaveBeenCalledTimes(2);
    expect(outcome.failures[0]!.reasons[0]).toMatch(/not valid JSON/);
  });

  it("a throwing model call (refusal, transport error) is recorded and retried", async () => {
    const caller = vi.fn(async (): Promise<string> => {
      throw new Error("model declined the request (stop_reason: refusal)");
    });
    const loaded = loadCaseWithDocuments(casePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const outcome = await reconcile(loaded.value, {
      callModel: caller,
      log: () => {},
      maxAttempts: 2,
    });
    expect(outcome.ok).toBe(false);
    expect(caller).toHaveBeenCalledTimes(2);
    expect(outcome.failures[0]!.reasons[0]).toMatch(/model call failed: .*refusal/);
  });

  it("respects a maxAttempts override", async () => {
    const { caller } = cannedCaller(brokenProfileJson());
    const loaded = loadCaseWithDocuments(casePath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const outcome = await reconcile(loaded.value, {
      callModel: caller,
      log: () => {},
      maxAttempts: 1,
    });
    expect(outcome.ok).toBe(false);
    expect(caller).toHaveBeenCalledTimes(1);
  });
});

describe("loading a case", () => {
  it("reports a missing case file instead of throwing", () => {
    const result = loadCaseWithDocuments(join(examplesDir, "no-such-case.json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/case file/);
  });

  it("reports a case whose documents are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
    const fixtureCase = readJsonFile(casePath) as Record<string, unknown>;
    writeFileSync(join(dir, "case.json"), JSON.stringify(fixtureCase));
    const result = loadCaseWithDocuments(join(dir, "case.json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/document "sources\/src-01.json"/);
  });

  it("reports a schema-invalid case file", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
    writeFileSync(join(dir, "case.json"), JSON.stringify({ id: "nope" }));
    const result = loadCaseWithDocuments(join(dir, "case.json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/case file/);
  });
});

describe("the transport schema", () => {
  it("strips keywords structured outputs rejects, keeps the enforcing core", () => {
    const wire = JSON.stringify(toTransportSchema(claimsSchema));
    for (const keyword of [
      '"$schema":',
      '"$id":',
      '"pattern":',
      '"minLength":',
      '"maxLength":',
      '"minItems":',
      '"maxItems":',
      '"uniqueItems":',
      '"allOf":',
      '"if":',
      '"then":',
    ]) {
      expect(wire).not.toContain(keyword);
    }
    expect(wire).toContain('"additionalProperties":false');
    expect(wire).toContain('"required":');
    expect(wire).toContain('"$defs":');
    expect(wire).toContain('"format":');
  });

  it("never strips property names, only keywords", () => {
    const wire = toTransportSchema({
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: { pattern: { type: "string", pattern: "^x$" } },
    });
    const properties = wire.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["pattern"]);
    expect(properties.pattern).toEqual({ type: "string" });
  });

  it("is what reconciliation requests carry", async () => {
    const { caller, calls } = cannedCaller(validProfileJson);
    await reconcileCaseFile(casePath, { callModel: caller, log: () => {} });
    expect(calls[0]!.outputSchema).toEqual(CLAIMS_TRANSPORT_SCHEMA);
  });
});

describe("the prompt is versioned and selected by PROMPT_VERSION", () => {
  afterEach(() => {
    delete process.env[PROMPT_VERSION_ENV_VAR];
  });

  it("defaults to the recorded best version when the env var is unset", () => {
    delete process.env[PROMPT_VERSION_ENV_VAR];
    expect(getPromptVersion()).toBe(DEFAULT_PROMPT_VERSION);
    expect(getSystemPrompt().length).toBeGreaterThan(0);
  });

  it("keeps v1 frozen: its file still exists and demands verbatim quotes", () => {
    process.env[PROMPT_VERSION_ENV_VAR] = "v1";
    expect(getPromptVersion()).toBe("v1");
    expect(promptPathFor("v1").endsWith(join("prompts", "reconcile.v1.md"))).toBe(true);
    expect(getSystemPrompt()).toContain("verbatim");
  });

  it("rejects a malformed version tag instead of guessing", () => {
    process.env[PROMPT_VERSION_ENV_VAR] = "latest";
    expect(() => getPromptVersion()).toThrow(/prompt version/);
  });
});

describe("CLI argument parsing", () => {
  it("accepts `<case> --out <file>` in either order", () => {
    expect(parseArgs(["case.json", "--out", "out.json"])).toEqual({
      ok: true,
      args: { casePath: "case.json", outPath: "out.json" },
    });
    expect(parseArgs(["--out", "out.json", "case.json"])).toEqual({
      ok: true,
      args: { casePath: "case.json", outPath: "out.json" },
    });
  });

  it("rejects missing or malformed arguments", () => {
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(["case.json"]).ok).toBe(false);
    expect(parseArgs(["--out", "out.json"]).ok).toBe(false);
    expect(parseArgs(["case.json", "--out"]).ok).toBe(false);
    expect(parseArgs(["case.json", "--out", "o.json", "extra"]).ok).toBe(false);
    expect(parseArgs(["case.json", "--out", "o.json", "--bogus"]).ok).toBe(false);
  });
});
