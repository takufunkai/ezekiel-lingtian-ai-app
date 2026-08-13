/**
 * The reconcile CLI: the pinned fixture-case path, and the added gathered-set
 * path, both with an injected `ModelCaller` so no key and no network is needed.
 *
 * The first describe block exists to pin behaviour that must not change: adding
 * `--sources` must leave `reconcile <case.json> --out <out.json>` exactly as it
 * was, down to the parsed shape and the prompt bytes.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isCaseArgs, parseArgs, run } from "../src/cli.js";
import { MODEL } from "../src/client.js";
import type { ReconciledProfile } from "../src/contract.js";
import { caseToModelInput, loadCaseWithDocuments, type ModelRequest } from "../src/engine.js";
import { buildUserMessage, SYSTEM_PROMPT } from "../src/prompt.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");
const casePath = join(examplesDir, "case.example.json");
const validProfileJson = readFileSync(join(examplesDir, "reconciled-profile.example.json"), "utf8");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cli-test-"));
}

/** A canned caller, recording the requests it was given. */
function cannedCaller(response: string) {
  const calls: ModelRequest[] = [];
  const caller = vi.fn(async (request: ModelRequest): Promise<string> => {
    calls.push(request);
    return response;
  });
  return { caller, calls };
}

/**
 * Lays out a gathered set the way `npm run gather` does, reusing the two format
 * -example documents so a known-good profile can be the canned model output.
 */
function gatheredSet(options: { topicEntity?: string; malformedTopic?: boolean } = {}): string {
  const dir = join(tempDir(), "nimbus-cartography-collective");
  const sourcesDir = join(dir, "sources");
  mkdirSync(sourcesDir, { recursive: true });
  for (const name of ["src-01.json", "src-02.json"]) {
    copyFileSync(join(examplesDir, "sources", name), join(sourcesDir, name));
  }
  if (options.malformedTopic) {
    writeFileSync(join(dir, "topic.json"), "{ not json\n");
  } else {
    writeFileSync(
      join(dir, "topic.json"),
      `${JSON.stringify(
        {
          topic: "Nimbus Cartography Collective",
          entity: { name: options.topicEntity ?? "Nimbus Cartography Collective" },
          gatheredAt: "2026-08-13T12:00:00.000Z",
          sources: [
            { id: "src-01", url: "https://example.org/nimbus/history", title: "A Brief History" },
            { id: "src-02", url: "https://news.example.com/nimbus", title: "Profile" },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

describe("the fixture-case path is unchanged", () => {
  it("parses `<case> --out <file>` into exactly the shape it always did", () => {
    // Deep-strict: no new keys may appear on the case-mode args object.
    expect(parseArgs(["case.json", "--out", "out.json"])).toStrictEqual({
      ok: true,
      args: { casePath: "case.json", outPath: "out.json" },
    });
    expect(parseArgs(["--out", "out.json", "case.json"])).toStrictEqual({
      ok: true,
      args: { casePath: "case.json", outPath: "out.json" },
    });
    const parsed = parseArgs(["case.json", "--out", "out.json"]);
    expect(parsed.ok && isCaseArgs(parsed.args)).toBe(true);
  });

  it("still rejects the same malformed argument lists", () => {
    for (const argv of [
      [],
      ["case.json"],
      ["--out", "out.json"],
      ["case.json", "--out"],
      ["case.json", "--out", "o.json", "extra"],
      ["case.json", "--out", "o.json", "--bogus"],
      ["case.json", "--out", "o.json", "--entity", "N"],
      ["case.json", "--sources", "d", "--out", "o.json"],
      ["--sources", "d"],
    ]) {
      expect(parseArgs(argv).ok, argv.join(" ")).toBe(false);
    }
  });

  it("runs a case end to end with the same prompt bytes and the same output", async () => {
    const outPath = join(tempDir(), "out.json");
    const { caller, calls } = cannedCaller(validProfileJson);
    const lines: string[] = [];

    const code = await run({ casePath, outPath }, { callModel: caller, log: (l) => lines.push(l) });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const loaded = loadCaseWithDocuments(casePath);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const { entity, documents } = caseToModelInput(loaded.value);
      expect(calls[0]?.system).toBe(SYSTEM_PROMPT);
      expect(calls[0]?.userMessage).toBe(buildUserMessage(entity, documents));
      // The answer key stayed behind the boundary.
      expect(calls[0]?.userMessage).not.toContain("plantedFact");
    }

    const written = JSON.parse(readFileSync(outPath, "utf8")) as ReconciledProfile;
    expect(written.model).toBe(MODEL);
    expect(lines.join("\n")).toMatch(/ok — wrote .*out\.json \(schema-valid, validated/);
  });

  it("reports an unloadable case as a load failure and writes nothing", async () => {
    const outPath = join(tempDir(), "out.json");
    const { caller } = cannedCaller(validProfileJson);
    const lines: string[] = [];

    const code = await run(
      { casePath: join(examplesDir, "does-not-exist.case.json"), outPath },
      { callModel: caller, log: (l) => lines.push(l) },
    );

    expect(code).toBe(1);
    expect(caller).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/the case could not be loaded/);
    expect(() => readFileSync(outPath, "utf8")).toThrow();
  });
});

describe("the gathered-set path (--sources, no case file)", () => {
  it("reconciles a gathered set and validates it, with no case file anywhere", async () => {
    const dir = gatheredSet();
    const outPath = join(tempDir(), "out.json");
    const { caller, calls } = cannedCaller(validProfileJson);
    const lines: string[] = [];

    const code = await run(
      { sourcesDir: dir, outPath },
      { callModel: caller, log: (l) => lines.push(l) },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    // Same prompt assembly as the case path: the frozen system prompt, and a
    // user message built from the entity plus the stripped documents.
    expect(calls[0]?.system).toBe(SYSTEM_PROMPT);
    expect(calls[0]?.userMessage).toContain('"entity"');
    expect(calls[0]?.userMessage).toContain("Nimbus Cartography Collective");
    // `notes` — where gather records the source URL — never reaches the model.
    expect(calls[0]?.userMessage).not.toContain('"notes"');

    const written = JSON.parse(readFileSync(outPath, "utf8")) as ReconciledProfile;
    expect(written.model).toBe(MODEL);
    expect(lines.join("\n")).toMatch(/schema-valid, validated/);
  });

  it("takes the entity from topic.json, and lets --entity override it", async () => {
    const dir = gatheredSet({ topicEntity: "Nimbus Collective (from topic.json)" });
    const outPath = join(tempDir(), "out.json");

    const fromTopic = cannedCaller(validProfileJson);
    expect(
      await run({ sourcesDir: dir, outPath }, { callModel: fromTopic.caller, log: () => {} }),
    ).toBe(0);
    expect(fromTopic.calls[0]?.userMessage).toContain("Nimbus Collective (from topic.json)");

    const overridden = cannedCaller(validProfileJson);
    expect(
      await run(
        { sourcesDir: dir, entityName: "Explicit Entity", outPath },
        { callModel: overridden.caller, log: () => {} },
      ),
    ).toBe(0);
    expect(overridden.calls[0]?.userMessage).toContain("Explicit Entity");
    expect(overridden.calls[0]?.userMessage).not.toContain("from topic.json");
  });

  it("accepts either the set root or its sources/ directory", async () => {
    const dir = gatheredSet();
    const outPath = join(tempDir(), "out.json");
    const { caller } = cannedCaller(validProfileJson);
    expect(
      await run(
        { sourcesDir: join(dir, "sources"), outPath },
        { callModel: caller, log: () => {} },
      ),
    ).toBe(0);
  });

  it("keeps the mandatory validation step: a bad quote fails the run but still writes evidence", async () => {
    const tampered = JSON.parse(validProfileJson) as ReconciledProfile;
    tampered.claims[0]!.citations[0]!.quote = "a span that appears in no source document";

    const dir = gatheredSet();
    const outPath = join(tempDir(), "out.json");
    const { caller } = cannedCaller(JSON.stringify(tampered));
    const lines: string[] = [];

    const code = await run(
      { sourcesDir: dir, outPath },
      { callModel: caller, log: (l) => lines.push(l) },
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/validation error/);
    // Written anyway: it is the evidence prompt iteration works from.
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toBeTruthy();
  });

  it("fails the run when the model never produces schema-valid output", async () => {
    const dir = gatheredSet();
    const outPath = join(tempDir(), "out.json");
    const { caller } = cannedCaller("{ not a profile }");
    const lines: string[] = [];

    const code = await run(
      { sourcesDir: dir, outPath },
      { callModel: caller, log: (l) => lines.push(l) },
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/never produced schema-valid output/);
    expect(() => readFileSync(outPath, "utf8")).toThrow();
  });

  it("refuses a set whose documents are unusable, before calling the model", async () => {
    const outPath = join(tempDir(), "out.json");

    const emptyDir = tempDir();
    const noDocs = cannedCaller(validProfileJson);
    expect(
      await run({ sourcesDir: emptyDir, outPath }, { callModel: noDocs.caller, log: () => {} }),
    ).toBe(1);
    expect(noDocs.caller).not.toHaveBeenCalled();

    const missing = cannedCaller(validProfileJson);
    const lines: string[] = [];
    expect(
      await run(
        { sourcesDir: join(emptyDir, "nope"), outPath },
        { callModel: missing.caller, log: (l) => lines.push(l) },
      ),
    ).toBe(1);
    expect(lines.join("\n")).toMatch(/is not a directory/);

    const invalid = gatheredSet();
    writeFileSync(join(invalid, "sources", "src-03.json"), `${JSON.stringify({ id: "src-03" })}\n`);
    const badDoc = cannedCaller(validProfileJson);
    const badLines: string[] = [];
    expect(
      await run(
        { sourcesDir: invalid, outPath },
        { callModel: badDoc.caller, log: (l) => badLines.push(l) },
      ),
    ).toBe(1);
    expect(badLines.join("\n")).toMatch(/document "src-03\.json"/);
    expect(badDoc.caller).not.toHaveBeenCalled();
  });

  it("refuses two documents sharing an id, which would make citations ambiguous", async () => {
    const dir = gatheredSet();
    const duplicate = JSON.parse(
      readFileSync(join(dir, "sources", "src-01.json"), "utf8"),
    ) as unknown;
    writeFileSync(join(dir, "sources", "src-01-copy.json"), `${JSON.stringify(duplicate)}\n`);

    const lines: string[] = [];
    const { caller } = cannedCaller(validProfileJson);
    const code = await run(
      { sourcesDir: dir, outPath: join(tempDir(), "out.json") },
      { callModel: caller, log: (l) => lines.push(l) },
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/duplicate source id "src-01"/);
    expect(caller).not.toHaveBeenCalled();
  });

  it("asks for --entity when there is no usable topic.json", async () => {
    const dir = gatheredSet({ malformedTopic: true });
    const lines: string[] = [];
    const { caller } = cannedCaller(validProfileJson);

    const code = await run(
      { sourcesDir: dir, outPath: join(tempDir(), "out.json") },
      { callModel: caller, log: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/pass --entity/);

    // With the name supplied, the same set runs.
    const { caller: named } = cannedCaller(validProfileJson);
    expect(
      await run(
        {
          sourcesDir: dir,
          entityName: "Nimbus Cartography Collective",
          outPath: join(tempDir(), "out.json"),
        },
        { callModel: named, log: () => {} },
      ),
    ).toBe(0);
  });
});
