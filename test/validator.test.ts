import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readJsonFile } from "../src/schema.js";
import {
  loadSourceDocuments,
  validate,
  validateFiles,
  type ValidationReport,
  type Violation,
  type ViolationCode,
} from "../src/validator.js";
import type { ReconciledProfile, SourceDocument } from "../src/contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");
const profilePath = join(examplesDir, "reconciled-profile.example.json");
const sourcesDir = join(examplesDir, "sources");
const casePath = join(examplesDir, "case.example.json");

const exampleProfile = readJsonFile(profilePath) as ReconciledProfile;
const exampleSources = readdirSync(sourcesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => readJsonFile(join(sourcesDir, name)) as SourceDocument);

function mutate(change: (profile: ReconciledProfile) => void): unknown {
  const copy = structuredClone(exampleProfile);
  change(copy);
  return copy;
}

function codes(report: ValidationReport): ViolationCode[] {
  return report.violations.map((violation) => violation.code);
}

function only(report: ValidationReport, code: ViolationCode): Violation {
  const matches = report.violations.filter((violation) => violation.code === code);
  expect(matches, `expected exactly one "${code}" violation`).toHaveLength(1);
  return matches[0]!;
}

describe("validate() — clean pass", () => {
  it("passes the committed example profile against the committed sources", () => {
    const report = validate(exampleProfile, exampleSources);
    expect(report.violations).toEqual([]);
    expect(report.valid).toBe(true);
  });
});

describe("validate() — each seeded violation is caught with its specific code", () => {
  it("catches a fabricated citation sourceId", () => {
    const broken = mutate((profile) => {
      profile.claims[0]!.citations[0]!.sourceId = "src-99";
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    const manifestViolation = only(report, "citation-source-not-in-manifest");
    expect(manifestViolation.sourceId).toBe("src-99");
    expect(manifestViolation.claimId).toBe("c1");
    expect(manifestViolation.path).toBe("/claims/0/citations/0");
    expect(codes(report)).toContain("citation-source-not-in-input");
  });

  it("catches a citation whose source is in the manifest but not the input set", () => {
    // Same profile, but the run received only src-01 as input.
    const inputSubset = exampleSources.filter((doc) => doc.id === "src-01");
    const report = validate(exampleProfile, inputSubset);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("citation-source-not-in-input");
    expect(codes(report)).toContain("manifest-source-not-in-input");
    expect(codes(report)).not.toContain("citation-source-not-in-manifest");
  });

  it("catches an altered (non-verbatim) quote", () => {
    const broken = mutate((profile) => {
      profile.claims[0]!.citations[0]!.quote = "was founded in 2013";
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    const violation = only(report, "quote-not-verbatim");
    expect(violation.path).toBe("/claims/0/citations/0/quote");
    expect(violation.sourceId).toBe("src-01");
    expect(violation.claimId).toBe("c1");
  });

  it("catches an uncited claim as a violation instead of dying on the schema failure", () => {
    const broken = mutate((profile) => {
      profile.claims[0]!.citations = [];
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    const violation = only(report, "claim-uncited");
    expect(violation.claimId).toBe("c1");
    // The schema catches it too; both reports surface.
    expect(codes(report)).toContain("schema");
  });

  it("catches a group claimId that resolves to no claim", () => {
    const broken = mutate((profile) => {
      profile.groups[2]!.claimIds = ["c-ghost"];
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    const violation = only(report, "group-unknown-claim");
    expect(violation.groupId).toBe("g3");
    expect(violation.claimId).toBe("c-ghost");
    // c4 lost its only group along the way.
    expect(only(report, "claim-ungrouped").claimId).toBe("c4");
  });

  it("catches a disputed group whose claims cite only one distinct source", () => {
    const broken = mutate((profile) => {
      // g1 (disputed, c1 + c2): point c2's citation at src-01 too, with a
      // verbatim src-01 quote so only the dispute rule fires.
      profile.claims[1]!.citations = [{ sourceId: "src-01", quote: "was founded in 2011" }];
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    const violation = only(report, "disputed-group-single-source");
    expect(violation.groupId).toBe("g1");
    expect(codes(report)).not.toContain("quote-not-verbatim");
  });

  it("catches a claim left out of every group", () => {
    const broken = mutate((profile) => {
      profile.claims.push({
        id: "c5",
        text: "The collective is headquartered in Rotterdam.",
        citations: [{ sourceId: "src-02", quote: "is headquartered in Rotterdam" }],
      });
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    expect(only(report, "claim-ungrouped").claimId).toBe("c5");
  });

  it("catches a claim assigned to two groups", () => {
    const broken = mutate((profile) => {
      profile.groups[1]!.claimIds.push("c4");
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    expect(only(report, "claim-in-multiple-groups").claimId).toBe("c4");
  });

  it("catches a duplicated claim id", () => {
    const broken = mutate((profile) => {
      profile.claims.push(structuredClone(profile.claims[0]!));
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    expect(only(report, "duplicate-id").claimId).toBe("c1");
  });

  it("catches a manifest entry that is not among the input documents", () => {
    const broken = mutate((profile) => {
      profile.sources.push({ id: "src-03", date: "2023-01-01", title: "Fabricated" });
    });
    const report = validate(broken, exampleSources);
    expect(report.valid).toBe(false);
    const violation = only(report, "manifest-source-not-in-input");
    expect(violation.sourceId).toBe("src-03");
  });

  it("reports schema violations without crashing on a structurally alien document", () => {
    const report = validate({ schemaVersion: "1.0.0", claims: "not-an-array" }, exampleSources);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("schema");
  });
});

describe("loadSourceDocuments()", () => {
  it("loads every source document from a directory", () => {
    const loaded = loadSourceDocuments(sourcesDir);
    expect(loaded.violations).toEqual([]);
    expect(loaded.documents.map((doc) => doc.id)).toEqual(["src-01", "src-02"]);
  });

  it("loads the documents referenced by a fixture-case file", () => {
    const loaded = loadSourceDocuments(casePath);
    expect(loaded.violations).toEqual([]);
    expect(loaded.documents.map((doc) => doc.id)).toEqual(["src-01", "src-02"]);
  });

  it("reports a missing sources path instead of throwing", () => {
    const loaded = loadSourceDocuments(join(examplesDir, "no-such-dir"));
    expect(loaded.violations.map((violation) => violation.code)).toEqual(["input-missing"]);
  });

  it("reports a file that is neither JSON nor a fixture case", () => {
    const loaded = loadSourceDocuments(join(repoRoot, "README.md"));
    expect(loaded.violations.map((violation) => violation.code)).toEqual(["input-not-json"]);
  });
});

describe("validateFiles() and the CLI", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "validator-test-"));
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTemp(name: string, content: string): string {
    const path = join(tempDir, name);
    writeFileSync(path, content);
    return path;
  }

  function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const script = join(repoRoot, "scripts", "validate.ts");
    const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("passes the committed example end to end (sources directory)", () => {
    const report = validateFiles(profilePath, sourcesDir);
    expect(report.violations).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("reports a malformed profile file as a violation, not a stack trace", () => {
    const badProfile = writeTemp("malformed.json", "{ this is not JSON");
    const report = validateFiles(badProfile, sourcesDir);
    expect(report.valid).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(["input-not-json"]);
  });

  it("CLI exits 0 and prints a clean report for the committed example", () => {
    const run = runCli("--profile", profilePath, "--sources", sourcesDir);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as ValidationReport;
    expect(report).toEqual({ valid: true, violations: [] });
  });

  it("CLI accepts a fixture-case file as the sources argument", () => {
    const run = runCli("--profile", profilePath, "--sources", casePath);
    expect(run.status).toBe(0);
  });

  it("CLI exits non-zero and reports the specific violation for a seeded bad output", () => {
    const broken = mutate((profile) => {
      profile.claims[0]!.citations[0]!.sourceId = "src-99";
    });
    const brokenPath = writeTemp("broken-profile.json", JSON.stringify(broken));
    const run = runCli("--profile", brokenPath, "--sources", sourcesDir);
    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout) as ValidationReport;
    expect(report.valid).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain(
      "citation-source-not-in-manifest",
    );
  });

  it("CLI exits 2 on missing arguments", () => {
    const run = runCli("--profile", profilePath);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage:");
  });
});
