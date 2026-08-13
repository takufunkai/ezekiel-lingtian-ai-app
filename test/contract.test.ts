import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claimsSchema,
  fixtureCaseSchema,
  formatSchemaErrors,
  readJsonFile,
  sourceDocumentSchema,
  validateFixtureCase,
  validateProfile,
  validateSourceDocument,
} from "../src/schema.js";
import { SCHEMA_VERSION } from "../src/contract.js";
import type {
  CaseExpectation,
  Citation,
  Claim,
  ClaimGroup,
  Entity,
  ExpectedQuestion,
  FixtureCase,
  ReconciledProfile,
  SourceDocument,
  SourceRef,
} from "../src/contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");
const profilePath = join(examplesDir, "reconciled-profile.example.json");
const exampleProfile = readJsonFile(profilePath);

/**
 * Compile-time exhaustiveness helper: the array must list every key of `T`,
 * otherwise the call does not type-check.
 */
function exhaustiveKeys<T extends object>() {
  return <K extends readonly (keyof T)[]>(
    keys: K &
      ([keyof T] extends [K[number]]
        ? unknown
        : ["missing keys in list:", Exclude<keyof T, K[number]>]),
  ): readonly string[] => keys as readonly string[];
}

/** Reads the `properties` keys of a schema node. */
function schemaProps(node: unknown): string[] {
  const properties = (node as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).sort();
}

function defOf(name: string): unknown {
  const defs = (claimsSchema as { $defs?: Record<string, unknown> }).$defs ?? {};
  const node = defs[name];
  expect(node, `claims.schema.json is missing $defs.${name}`).toBeDefined();
  return node;
}

function caseDefOf(name: string): unknown {
  const defs = (fixtureCaseSchema as { $defs?: Record<string, unknown> }).$defs ?? {};
  const node = defs[name];
  expect(node, `fixture-case.schema.json is missing $defs.${name}`).toBeDefined();
  return node;
}

describe("committed examples validate against the committed schemas", () => {
  const sourceFiles = readdirSync(join(examplesDir, "sources"))
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("ships at least one example source document", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)("source document %s matches source-document.schema.json", (name) => {
    const result = validateSourceDocument(readJsonFile(join(examplesDir, "sources", name)));
    expect(formatSchemaErrors(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("the hand-written example profile matches claims.schema.json", () => {
    const result = validateProfile(exampleProfile);
    expect(formatSchemaErrors(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("the schema rejects the violations it exists to catch", () => {
  function mutate(change: (profile: ReconciledProfile) => void): unknown {
    const copy = structuredClone(exampleProfile) as ReconciledProfile;
    change(copy);
    return copy;
  }

  it("rejects a claim with no citations", () => {
    const broken = mutate((profile) => {
      profile.claims[0]!.citations = [];
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects a claim missing the citations field entirely", () => {
    const broken = mutate((profile) => {
      delete (profile.claims[0] as Partial<Claim>).citations;
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects a citation without a quote span", () => {
    const broken = mutate((profile) => {
      delete (profile.claims[0]!.citations[0] as Partial<Citation>).quote;
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects an unknown group status", () => {
    const broken = mutate((profile) => {
      (profile.groups[0] as { status: string }).status = "uncertain";
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects a disputed group holding only one claim", () => {
    const broken = mutate((profile) => {
      profile.groups[0]!.claimIds = ["c1"];
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("accepts an agreed group holding only one claim", () => {
    const ok = mutate((profile) => {
      profile.groups[0]!.status = "agreed";
      profile.groups[0]!.claimIds = ["c1"];
    });
    expect(validateProfile(ok).valid).toBe(true);
  });

  it("rejects an undeclared extra property instead of silently tolerating it", () => {
    const broken = mutate((profile) => {
      (profile as unknown as Record<string, unknown>).confidence = 0.9;
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects an extra property on a claim", () => {
    const broken = mutate((profile) => {
      (profile.claims[0] as unknown as Record<string, unknown>).sourceId = "src-01";
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects a mismatched schemaVersion", () => {
    const broken = mutate((profile) => {
      (profile as { schemaVersion: string }).schemaVersion = "0.9.0";
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects a malformed generatedAt", () => {
    const broken = mutate((profile) => {
      profile.generatedAt = "last Tuesday";
    });
    expect(validateProfile(broken).valid).toBe(false);
  });

  it("rejects a source document missing its text", () => {
    const broken: Partial<SourceDocument> = {
      id: "src-99",
      date: "2024-01-01",
      title: "No body",
    };
    expect(validateSourceDocument(broken).valid).toBe(false);
  });

  it("rejects a source document with a non-ISO date", () => {
    const broken: SourceDocument = {
      id: "src-99",
      date: "14 March 2021",
      title: "Bad date",
      text: "body",
    };
    expect(validateSourceDocument(broken).valid).toBe(false);
  });
});

describe("TypeScript types stay in sync with the JSON Schemas", () => {
  // Each list must name every key of the matching type (enforced by the compiler)
  // and must equal the schema's declared properties (enforced at run time).
  it("ReconciledProfile", () => {
    const keys = exhaustiveKeys<ReconciledProfile>()([
      "schemaVersion",
      "entity",
      "generatedAt",
      "model",
      "sources",
      "claims",
      "groups",
    ]);
    expect([...keys].sort()).toEqual(schemaProps(claimsSchema));
  });

  it("Entity", () => {
    const keys = exhaustiveKeys<Entity>()(["name", "aliases"]);
    expect([...keys].sort()).toEqual(schemaProps(defOf("entity")));
  });

  it("SourceRef", () => {
    const keys = exhaustiveKeys<SourceRef>()(["id", "date", "title"]);
    expect([...keys].sort()).toEqual(schemaProps(defOf("sourceRef")));
  });

  it("Citation", () => {
    const keys = exhaustiveKeys<Citation>()(["sourceId", "quote"]);
    expect([...keys].sort()).toEqual(schemaProps(defOf("citation")));
  });

  it("Claim", () => {
    const keys = exhaustiveKeys<Claim>()(["id", "text", "citations"]);
    expect([...keys].sort()).toEqual(schemaProps(defOf("claim")));
  });

  it("ClaimGroup", () => {
    const keys = exhaustiveKeys<ClaimGroup>()(["id", "question", "status", "claimIds"]);
    expect([...keys].sort()).toEqual(schemaProps(defOf("group")));
  });

  it("SourceDocument", () => {
    const keys = exhaustiveKeys<SourceDocument>()(["id", "date", "title", "text", "notes"]);
    expect([...keys].sort()).toEqual(schemaProps(sourceDocumentSchema));
  });

  it("FixtureCase", () => {
    const keys = exhaustiveKeys<FixtureCase>()([
      "schemaVersion",
      "id",
      "title",
      "scenario",
      "entity",
      "documents",
      "expect",
      "notes",
    ]);
    expect([...keys].sort()).toEqual(schemaProps(fixtureCaseSchema));
  });

  it("CaseExpectation", () => {
    const keys = exhaustiveKeys<CaseExpectation>()([
      "questions",
      "requiredSourceIds",
      "excludedSourceIds",
    ]);
    expect([...keys].sort()).toEqual(schemaProps(caseDefOf("expectation")));
  });

  it("ExpectedQuestion", () => {
    const keys = exhaustiveKeys<ExpectedQuestion>()([
      "id",
      "question",
      "status",
      "sourceIds",
      "plantedFact",
    ]);
    expect([...keys].sort()).toEqual(schemaProps(caseDefOf("expectedQuestion")));
  });

  // The version constant is the one field the key-name comparison above cannot
  // catch: both sides can keep the same shape while drifting in value.
  it("SCHEMA_VERSION matches the value pinned in both schemas", () => {
    const constOf = (schema: unknown): unknown =>
      (schema as { properties: { schemaVersion: { const: unknown } } }).properties.schemaVersion
        .const;
    expect(constOf(claimsSchema)).toBe(SCHEMA_VERSION);
    expect(constOf(fixtureCaseSchema)).toBe(SCHEMA_VERSION);
  });
});

describe("the example fixture case", () => {
  const examplePath = join(examplesDir, "case.example.json");
  const exampleCase = readJsonFile(examplePath);

  it("matches fixture-case.schema.json", () => {
    const result = validateFixtureCase(exampleCase);
    expect(formatSchemaErrors(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  function mutate(change: (fixtureCase: FixtureCase) => void): unknown {
    const copy = structuredClone(exampleCase) as FixtureCase;
    change(copy);
    return copy;
  }

  it("rejects a disputed question answered by a single source", () => {
    const broken = mutate((fixtureCase) => {
      const disputed = fixtureCase.expect.questions.find((q) => q.status === "disputed")!;
      disputed.sourceIds = ["src-01"];
    });
    expect(validateFixtureCase(broken).valid).toBe(false);
  });

  it("accepts an agreed question answered by a single source", () => {
    const ok = mutate((fixtureCase) => {
      fixtureCase.expect.questions.forEach((q) => {
        q.status = "agreed";
        q.sourceIds = ["src-01"];
      });
    });
    expect(validateFixtureCase(ok).valid).toBe(true);
  });

  it("rejects an unknown scenario", () => {
    const broken = mutate((fixtureCase) => {
      (fixtureCase as { scenario: string }).scenario = "ambiguous";
    });
    expect(validateFixtureCase(broken).valid).toBe(false);
  });

  it("rejects an absolute document path", () => {
    const broken = mutate((fixtureCase) => {
      fixtureCase.documents = ["/etc/passwd.json"];
    });
    expect(validateFixtureCase(broken).valid).toBe(false);
  });

  it("rejects a case with no expectations", () => {
    const broken = mutate((fixtureCase) => {
      fixtureCase.expect.questions = [];
    });
    expect(validateFixtureCase(broken).valid).toBe(false);
  });
});
