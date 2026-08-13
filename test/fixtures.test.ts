/**
 * Scenario invariants for the fixture corpus in `fixtures/` (issue #2).
 *
 * `scripts/validate-contract.ts` already guards schema conformance and
 * referential integrity in CI; these tests assert what makes each set its
 * scenario — Set A is all agreement, Set B carries the planted contradiction,
 * Set C excludes the impostor — so an edit cannot quietly defang a case.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatSchemaErrors,
  readJsonFile,
  validateFixtureCase,
  validateSourceDocument,
} from "../src/schema.js";
import type { FixtureCase, SourceDocument } from "../src/contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(repoRoot, "fixtures");

const SET_IDS = ["set-a-agreement", "set-b-contradiction", "set-c-poisoned"] as const;

function loadCase(setId: string): FixtureCase {
  const result = validateFixtureCase(readJsonFile(join(fixturesDir, setId, `${setId}.case.json`)));
  expect(formatSchemaErrors(result.errors)).toEqual([]);
  expect(result.valid).toBe(true);
  return result.data as FixtureCase;
}

function loadDocuments(setId: string, fixtureCase: FixtureCase): SourceDocument[] {
  return fixtureCase.documents.map((ref) => {
    const result = validateSourceDocument(readJsonFile(join(fixturesDir, setId, ref)));
    expect(formatSchemaErrors(result.errors), `${setId}/${ref}`).toEqual([]);
    expect(result.valid).toBe(true);
    return result.data as SourceDocument;
  });
}

const cases = new Map(SET_IDS.map((setId) => [setId, loadCase(setId)] as const));
const documents = new Map(
  SET_IDS.map((setId) => [setId, loadDocuments(setId, cases.get(setId)!)] as const),
);

describe("the fixture corpus", () => {
  it("holds exactly the three canonical sets", () => {
    expect(readdirSync(fixturesDir).sort()).toEqual([...SET_IDS]);
  });

  it("profiles one entity across all three sets", () => {
    const names = new Set(SET_IDS.map((setId) => cases.get(setId)!.entity.name));
    expect([...names]).toEqual(["Fernhaven Seed Library"]);
  });

  describe.each(SET_IDS)("%s", (setId) => {
    const fixtureCase = () => cases.get(setId)!;
    const docs = () => documents.get(setId)!;

    it("uses its directory name as the case id and matches its scenario", () => {
      expect(fixtureCase().id).toBe(setId);
      const scenarioBySet = {
        "set-a-agreement": "agreement",
        "set-b-contradiction": "contradiction",
        "set-c-poisoned": "poisoned",
      } as const;
      expect(fixtureCase().scenario).toBe(scenarioBySet[setId]);
    });

    it("supplies four to six source documents with unique ids", () => {
      expect(docs().length).toBeGreaterThanOrEqual(4);
      expect(docs().length).toBeLessThanOrEqual(6);
      expect(new Set(docs().map((doc) => doc.id)).size).toBe(docs().length);
    });

    it("accounts for every document in the answer key (required or excluded)", () => {
      const required = fixtureCase().expect.requiredSourceIds ?? [];
      const excluded = fixtureCase().expect.excludedSourceIds ?? [];
      expect([...required, ...excluded].sort()).toEqual(
        docs()
          .map((doc) => doc.id)
          .sort(),
      );
    });

    it("documents every disputed question's planted fact", () => {
      for (const question of fixtureCase().expect.questions) {
        if (question.status === "disputed") {
          expect(question.plantedFact, question.id).toBeTruthy();
        }
      }
    });
  });

  it("set-a-agreement expects no dispute and excludes nothing", () => {
    const fixtureCase = cases.get("set-a-agreement")!;
    expect(fixtureCase.expect.questions.every((q) => q.status === "agreed")).toBe(true);
    expect(fixtureCase.expect.excludedSourceIds ?? []).toEqual([]);
  });

  it("set-b-contradiction plants the three-way founding dispute among agreed questions", () => {
    const fixtureCase = cases.get("set-b-contradiction")!;
    const disputed = fixtureCase.expect.questions.filter((q) => q.status === "disputed");
    expect(disputed).toHaveLength(1);
    expect(disputed[0]!.sourceIds.sort()).toEqual([
      "carrow-almanac-2021",
      "charity-register-2020",
      "harbour-courier-2016",
    ]);
    expect(fixtureCase.expect.questions.some((q) => q.status === "agreed")).toBe(true);
    expect(fixtureCase.expect.excludedSourceIds ?? []).toEqual([]);
  });

  it("set-c-poisoned feeds the impostor to the model but bans it from the profile", () => {
    const fixtureCase = cases.get("set-c-poisoned")!;
    const excluded = fixtureCase.expect.excludedSourceIds ?? [];
    expect(excluded).toEqual(["dunmore-ledger-2022"]);

    const docIds = documents.get("set-c-poisoned")!.map((doc) => doc.id);
    expect(docIds).toContain("dunmore-ledger-2022");

    for (const question of fixtureCase.expect.questions) {
      expect(question.status, question.id).toBe("agreed");
      expect(question.sourceIds, question.id).not.toContain("dunmore-ledger-2022");
    }
    expect(fixtureCase.expect.requiredSourceIds ?? []).not.toContain("dunmore-ledger-2022");
  });
});
