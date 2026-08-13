import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readJsonFile, validateSourceDocument } from "../src/schema.js";
import {
  VIOLATION_CODES,
  formatViolations,
  validateOutput,
  type ValidateOutputOptions,
  type ValidationReport,
  type ViolationCode,
} from "../src/validate.js";
import type { ReconciledProfile, SourceDocument } from "../src/contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(repoRoot, "test", "fixtures", "validator");
const fixtureSourcesDir = join(fixturesDir, "sources");

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

function fixture(name: string): unknown {
  return readJsonFile(fixturePath(name));
}

/** The input set every fixture profile is validated against. */
const sources: SourceDocument[] = ["src-01.json", "src-02.json"].map(
  (name) => readJsonFile(join(fixtureSourcesDir, name)) as SourceDocument,
);

function validateFixture(name: string, options?: ValidateOutputOptions): ValidationReport {
  return validateOutput(fixture(name), sources, options);
}

function codesOf(report: ValidationReport): ViolationCode[] {
  return report.violations.map((violation) => violation.code);
}

/** Copies a fixture profile so a test can plant exactly one defect in it. */
function mutate(name: string, change: (profile: ReconciledProfile) => void): ReconciledProfile {
  const copy = structuredClone(fixture(name)) as ReconciledProfile;
  change(copy);
  return copy;
}

function mutateGood(change: (profile: ReconciledProfile) => void): ReconciledProfile {
  return mutate("good.profile.json", change);
}

describe("the fixtures themselves are sound", () => {
  it.each(["src-01.json", "src-02.json"])("source %s matches its schema", (name) => {
    expect(validateSourceDocument(readJsonFile(join(fixtureSourcesDir, name))).valid).toBe(true);
  });
});

describe("a clean profile passes", () => {
  it("reports nothing for the hand-written good fixture", () => {
    const report = validateFixture("good.profile.json");
    expect(formatViolations(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  // Acceptance criterion: the committed example document from #1 must stay green.
  it("reports nothing for examples/reconciled-profile.example.json", () => {
    const examplesDir = join(repoRoot, "examples");
    const exampleSources = readdirSync(join(examplesDir, "sources"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readJsonFile(join(examplesDir, "sources", name)) as SourceDocument);
    const profile = readJsonFile(join(examplesDir, "reconciled-profile.example.json"));

    const report = validateOutput(profile, exampleSources);
    expect(formatViolations(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("seeded bad outputs are each caught by a specific violation", () => {
  it("catches a fabricated source id", () => {
    const report = validateFixture("bad-fabricated-source.profile.json");
    expect(codesOf(report)).toEqual(["UNKNOWN_SOURCE_ID"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]).toEqual({
      code: "UNKNOWN_SOURCE_ID",
      severity: "error",
      message: 'claim c4 cites "src-99", which is not one of the 2 input source document(s)',
      path: "/claims/3/citations/0/sourceId",
      subjectId: "c4",
    });
  });

  it("catches an altered quote", () => {
    const report = validateFixture("bad-altered-quote.profile.json");
    expect(codesOf(report)).toEqual(["QUOTE_NOT_VERBATIM"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.path).toBe("/claims/0/citations/0/quote");
    expect(report.violations[0]?.subjectId).toBe("c1");
    expect(report.violations[0]?.message).toContain("not a verbatim substring of src-01");
  });

  it("catches an uncited claim, as both a schema and a citation violation", () => {
    const report = validateFixture("bad-uncited-claim.profile.json");
    expect(codesOf(report)).toContain("CLAIM_NO_CITATIONS");
    // The semantic pass runs even on a schema-invalid document, so the specific
    // violation is reported next to the generic "does not match the schema".
    expect(codesOf(report)).toContain("SCHEMA_INVALID");
    expect(report.ok).toBe(false);

    const uncited = report.violations.find((violation) => violation.code === "CLAIM_NO_CITATIONS");
    expect(uncited?.path).toBe("/claims/2/citations");
    expect(uncited?.subjectId).toBe("c3");
  });

  it("catches a group member id that resolves to no claim", () => {
    const report = validateFixture("bad-unresolved-claim-id.profile.json");
    expect(codesOf(report)).toEqual(["UNRESOLVED_CLAIM_ID"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.path).toBe("/groups/1/claimIds/1");
    expect(report.violations[0]?.subjectId).toBe("g2");
    expect(report.violations[0]?.message).toContain('"c9"');
  });

  it("catches a disputed group whose claims all rest on one source", () => {
    const report = validateFixture("bad-disputed-single-source.profile.json");
    expect(codesOf(report)).toEqual(["DISPUTED_GROUP_UNDER_SOURCED"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.path).toBe("/groups/0/claimIds");
    expect(report.violations[0]?.subjectId).toBe("g1");
  });

  it("counts only real sources towards a dispute, so a fabricated id cannot prop one up", () => {
    const broken = mutateGood((profile) => {
      profile.claims[1]!.citations[0]!.sourceId = "src-99";
    });
    const report = validateOutput(broken, sources);
    expect(codesOf(report)).toEqual(["UNKNOWN_SOURCE_ID", "DISPUTED_GROUP_UNDER_SOURCED"]);
  });

  it("catches a schema violation the cross-document checks cannot see", () => {
    const broken = mutateGood((profile) => {
      (profile as unknown as Record<string, unknown>).confidence = 0.9;
    });
    const report = validateOutput(broken, sources);
    expect(codesOf(report)).toEqual(["SCHEMA_INVALID"]);
    expect(report.violations[0]?.message).toContain("claims.schema.json");
  });
});

describe("the sources manifest and the input set must agree", () => {
  // The crossover case that motivated these checks: the renderer (#5) resolves
  // citation markers through `profile.sources`, so a citation the manifest omits
  // renders as an unresolvable marker. Without this the validator called such a
  // profile clean and the renderer shipped the broken page.
  it("catches a citation to an input document the manifest omits", () => {
    const report = validateFixture("bad-source-not-in-manifest.profile.json");
    expect(codesOf(report)).toEqual(["SOURCE_NOT_IN_MANIFEST", "SOURCE_NOT_IN_MANIFEST"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.path).toBe("/claims/1/citations/0/sourceId");
    expect(report.violations[0]?.subjectId).toBe("c2");
    expect(report.violations[0]?.message).toContain("src-02");
    expect(report.violations[1]?.path).toBe("/claims/3/citations/0/sourceId");
  });

  it("does not mistake a manifest gap for a fabricated source", () => {
    const report = validateFixture("bad-source-not-in-manifest.profile.json");
    expect(codesOf(report)).not.toContain("UNKNOWN_SOURCE_ID");
  });

  it("still checks the quote of a citation the manifest omits", () => {
    const broken = mutate("bad-source-not-in-manifest.profile.json", (profile) => {
      profile.claims[1]!.citations[0]!.quote = "founding of Harrow Tin Works in 1952";
    });
    expect(codesOf(validateOutput(broken, sources))).toEqual([
      "SOURCE_NOT_IN_MANIFEST",
      "QUOTE_NOT_VERBATIM",
      "SOURCE_NOT_IN_MANIFEST",
    ]);
  });

  const invented = { id: "src-03", date: "2011-01-01", title: "Not an input" };

  it("catches a manifest entry for a document nobody supplied", () => {
    const broken = mutateGood((profile) => {
      profile.sources.push({ ...invented });
    });
    const report = validateOutput(broken, sources);
    expect(codesOf(report)).toEqual(["MANIFEST_SOURCE_NOT_IN_INPUT"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.path).toBe("/sources/2/id");
    expect(report.violations[0]?.subjectId).toBe("src-03");
  });

  it("reports both angles when a claim cites an invented manifest entry", () => {
    const broken = mutateGood((profile) => {
      profile.sources.push({ ...invented });
      profile.claims[3]!.citations[0]!.sourceId = "src-03";
    });
    expect(codesOf(validateOutput(broken, sources))).toEqual([
      "MANIFEST_SOURCE_NOT_IN_INPUT",
      "UNKNOWN_SOURCE_ID",
    ]);
  });
});

describe("duplicate claim ids cannot soften the dispute check", () => {
  // `claims.schema.json` puts no uniqueness constraint on claim ids, so nothing
  // upstream of this module rejects a document with two claims called "c2".
  const duplicateOfC2 = {
    id: "c2",
    text: "Harrow Tin Works was founded in 1951.",
    citations: [{ sourceId: "src-02", quote: "founding of Harrow Tin Works in 1951" }],
  };

  it("catches two claims sharing an id", () => {
    const broken = mutateGood((profile) => {
      profile.claims.push({ ...duplicateOfC2 });
    });
    const report = validateOutput(broken, sources);
    expect(codesOf(report)).toEqual(["DUPLICATE_CLAIM_ID"]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.path).toBe("/claims/4/id");
    expect(report.violations[0]?.subjectId).toBe("c2");
  });

  it("reports every claim after the first that reuses an id", () => {
    const broken = mutateGood((profile) => {
      profile.claims.push({ ...duplicateOfC2 }, { ...duplicateOfC2 });
    });
    const report = validateOutput(broken, sources);
    expect(codesOf(report)).toEqual(["DUPLICATE_CLAIM_ID", "DUPLICATE_CLAIM_ID"]);
    expect(report.violations.map((violation) => violation.path)).toEqual([
      "/claims/4/id",
      "/claims/5/id",
    ]);
  });

  it("does not pool a duplicate id's sources into a group's spread", () => {
    // Both halves of the disputed g1 now rest on src-01, and a second claim also
    // called "c2" cites src-02. Pooling by id would credit g1 with two sources and
    // hide the single-sourced dispute.
    const broken = mutateGood((profile) => {
      profile.claims[1]!.citations[0]!.sourceId = "src-01";
      profile.claims[1]!.citations[0]!.quote = "on the north bank of the Mersey";
      profile.claims.push({ ...duplicateOfC2 });
    });
    expect(codesOf(validateOutput(broken, sources))).toEqual([
      "DUPLICATE_CLAIM_ID",
      "DISPUTED_GROUP_UNDER_SOURCED",
    ]);
  });
});

describe("the quote check is exact substring matching, nothing more", () => {
  function quoteReport(quote: string): ValidationReport {
    const broken = mutateGood((profile) => {
      profile.claims[0]!.citations[0]!.quote = quote;
    });
    return validateOutput(broken, sources);
  }

  it("accepts any substring, even one that starts mid-word", () => {
    expect(codesOf(quoteReport("pened its doors in 194"))).toEqual([]);
  });

  it("rejects a quote that differs only in letter case", () => {
    const report = quoteReport("Opened Its Doors In 1948");
    expect(codesOf(report)).toEqual(["QUOTE_NOT_VERBATIM"]);
    expect(report.violations[0]?.message).toContain("differs only in letter case");
  });

  it("rejects a quote whose whitespace was reflowed", () => {
    const report = quoteReport("opened its  doors\nin 1948");
    expect(codesOf(report)).toEqual(["QUOTE_NOT_VERBATIM"]);
    expect(report.violations[0]?.message).toContain("differs only in whitespace");
  });

  it("rejects an elided quote joined with an ellipsis", () => {
    const report = quoteReport("opened its doors … on the north bank");
    expect(codesOf(report)).toEqual(["QUOTE_NOT_VERBATIM"]);
    expect(report.violations[0]?.message).not.toContain("differs only");
  });

  it("truncates a very long quote in the message rather than dumping it", () => {
    const report = quoteReport(`fabricated span ${"x".repeat(200)}`);
    expect(codesOf(report)).toEqual(["QUOTE_NOT_VERBATIM"]);
    expect(report.violations[0]?.message).toContain("…");
    expect(report.violations[0]!.message.length).toBeLessThan(200);
  });
});

describe("a claim in no group is a warning, not a failure", () => {
  it("warns but still passes by default", () => {
    const report = validateFixture("ungrouped-claim.profile.json");
    expect(codesOf(report)).toEqual(["CLAIM_NOT_GROUPED"]);
    expect(report.violations[0]?.severity).toBe("warning");
    expect(report.violations[0]?.subjectId).toBe("c5");
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(1);
    expect(report.ok).toBe(true);
  });

  it("fails under --strict", () => {
    const report = validateFixture("ungrouped-claim.profile.json", { strict: true });
    expect(report.ok).toBe(false);
    // The severity in the report stays honest; only the verdict changes.
    expect(report.violations[0]?.severity).toBe("warning");
    expect(report.warningCount).toBe(1);
  });
});

describe("the report is machine-readable and deterministic", () => {
  it("only ever emits declared codes", () => {
    const names = [
      "good.profile.json",
      "bad-fabricated-source.profile.json",
      "bad-altered-quote.profile.json",
      "bad-uncited-claim.profile.json",
      "bad-unresolved-claim-id.profile.json",
      "bad-disputed-single-source.profile.json",
      "bad-source-not-in-manifest.profile.json",
      "ungrouped-claim.profile.json",
    ];
    for (const name of names) {
      for (const code of codesOf(validateFixture(name))) {
        expect(VIOLATION_CODES).toContain(code);
      }
    }
  });

  it("survives a JSON round trip, so it can be written to a file", () => {
    const report = validateFixture("bad-fabricated-source.profile.json");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("returns the same report for the same input", () => {
    const first = validateFixture("bad-uncited-claim.profile.json");
    const second = validateFixture("bad-uncited-claim.profile.json");
    expect(second).toEqual(first);
  });

  it("never throws on input that is not a profile at all", () => {
    for (const junk of [null, 42, "a string", [], {}]) {
      const report = validateOutput(junk, sources);
      expect(report.ok).toBe(false);
      expect(report.errorCount).toBeGreaterThan(0);
    }
  });

  it("formats each violation as one printable line", () => {
    const lines = formatViolations(validateFixture("bad-altered-quote.profile.json"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("error");
    expect(lines[0]).toContain("QUOTE_NOT_VERBATIM");
    expect(lines[0]).toContain("/claims/0/citations/0/quote");
  });
});

// Proves the exit-code contract end to end. Skipped rather than failed when the
// tsx binary is not where we expect it, so a dependency layout change cannot turn
// this into a mystery failure elsewhere.
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliScript = join(repoRoot, "scripts", "validate-output.ts");

describe.skipIf(!existsSync(tsxCli))("the CLI entry point", () => {
  function run(...args: string[]): { status: number | null; stdout: string } {
    const result = spawnSync(process.execPath, [tsxCli, cliScript, ...args], {
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout };
  }

  it("exits 0 on a clean profile", () => {
    const result = run(fixturePath("good.profile.json"), fixtureSourcesDir);
    expect(result.stdout).toContain("OK");
    expect(result.status).toBe(0);
  }, 30_000);

  it("exits non-zero and prints the report as JSON", () => {
    const args = [fixturePath("bad-altered-quote.profile.json"), fixtureSourcesDir, "--json"];
    const result = run(...args);
    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as ValidationReport;
    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(["QUOTE_NOT_VERBATIM"]);
  }, 30_000);

  it("exits 2 when the input cannot be read, rather than reporting a false verdict", () => {
    const result = run(fixturePath("no-such-profile.json"), fixtureSourcesDir);
    expect(result.status).toBe(2);
  }, 30_000);
});
