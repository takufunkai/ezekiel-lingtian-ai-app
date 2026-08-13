#!/usr/bin/env tsx
/**
 * Proves the committed example documents and the fixture corpus validate against
 * the committed schemas.
 *
 * Run with `npm run validate:contract`. Exits non-zero on the first failure so it
 * can be wired into CI.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSchemaErrors,
  tryReadJsonFile,
  validateFixtureCase,
  validateProfile,
  validateSourceDocument,
  type SchemaResult,
} from "../src/schema.js";
import type { FixtureCase, SourceDocument } from "../src/contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");
const sourcesDir = join(examplesDir, "sources");
const fixturesDir = join(repoRoot, "fixtures");

let failures = 0;

function fail(path: string, lines: string[]): void {
  failures += 1;
  console.error(`  FAIL  ${relative(repoRoot, path)}`);
  for (const line of lines) {
    console.error(`          ${line}`);
  }
}

function report(path: string, result: SchemaResult<unknown>): void {
  if (result.valid) {
    console.log(`  ok    ${relative(repoRoot, path)}`);
    return;
  }
  fail(path, formatSchemaErrors(result.errors));
}

/** Parses a file, reporting malformed JSON as a failure rather than throwing. */
function load(path: string): unknown | undefined {
  const parsed = tryReadJsonFile(path);
  if (!parsed.ok) {
    fail(path, [`is not valid JSON: ${parsed.error}`]);
    return undefined;
  }
  return parsed.data;
}

console.log("source documents  (schema/source-document.schema.json)");
const sourceFiles = readdirSync(sourcesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();
if (sourceFiles.length === 0) {
  console.error("  FAIL  no example source documents found");
  failures += 1;
}
for (const name of sourceFiles) {
  const path = join(sourcesDir, name);
  const data = load(path);
  if (data !== undefined) report(path, validateSourceDocument(data));
}

console.log("reconciled profile  (schema/claims.schema.json)");
const profilePath = join(examplesDir, "reconciled-profile.example.json");
const profileData = load(profilePath);
if (profileData !== undefined) report(profilePath, validateProfile(profileData));

/**
 * Checks one fixture case file: schema validation plus the cross-file checks the
 * schema cannot express — every referenced document must exist, parse, satisfy
 * the source-document schema, and carry a unique id; every source id named in
 * the expectations must belong to one of the case's documents.
 */
function checkFixtureCase(path: string): void {
  const data = load(path);
  if (data === undefined) return;

  const result = validateFixtureCase(data);
  if (!result.valid) {
    report(path, result);
    return;
  }

  const fixtureCase: FixtureCase = result.data;
  const caseDir = dirname(path);
  const problems: string[] = [];
  const declaredIds = new Set<string>();

  for (const ref of fixtureCase.documents) {
    const docPath = join(caseDir, ref);
    if (!existsSync(docPath)) {
      problems.push(`documents: "${ref}" does not exist`);
      continue;
    }
    const doc = tryReadJsonFile(docPath);
    if (!doc.ok) {
      problems.push(`documents: "${ref}" is not valid JSON: ${doc.error}`);
      continue;
    }
    const docResult = validateSourceDocument(doc.data);
    if (!docResult.valid) {
      problems.push(
        `documents: "${ref}" fails the source-document schema:`,
        ...formatSchemaErrors(docResult.errors).map((line) => `  ${line}`),
      );
      continue;
    }
    const docId = (doc.data as SourceDocument).id;
    if (declaredIds.has(docId)) {
      problems.push(`documents: "${ref}" reuses id "${docId}" already used by another document`);
    }
    declaredIds.add(docId);
  }

  const cited = [
    ...fixtureCase.expect.questions.flatMap((question) =>
      question.sourceIds.map((id) => [`expect.questions.${question.id}`, id] as const),
    ),
    ...(fixtureCase.expect.requiredSourceIds ?? []).map(
      (id) => ["expect.requiredSourceIds", id] as const,
    ),
    ...(fixtureCase.expect.excludedSourceIds ?? []).map(
      (id) => ["expect.excludedSourceIds", id] as const,
    ),
  ];
  for (const [where, id] of cited) {
    if (!declaredIds.has(id)) {
      problems.push(`${where}: "${id}" is not among the case's documents`);
    }
  }

  if (problems.length > 0) {
    fail(path, problems);
  } else {
    report(path, result);
  }
}

console.log("fixture cases  (schema/fixture-case.schema.json)");
const caseFiles = readdirSync(examplesDir)
  .filter((name) => name.endsWith("case.example.json") || name.endsWith(".case.json"))
  .sort();
for (const name of caseFiles) {
  checkFixtureCase(join(examplesDir, name));
}

// The fixture corpus (issue #2) is what the engine is tested and demoed against,
// so CI guards it with the same schema and cross-file checks as the examples.
console.log("fixture corpus  (fixtures/**/*.case.json)");
const fixtureCaseFiles = existsSync(fixturesDir)
  ? readdirSync(fixturesDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".case.json"))
      .sort()
  : [];
if (fixtureCaseFiles.length === 0) {
  console.error("  FAIL  no fixture cases found under fixtures/");
  failures += 1;
}
for (const name of fixtureCaseFiles) {
  checkFixtureCase(join(fixturesDir, name));
}

if (failures > 0) {
  console.error(`\n${failures} document(s) failed schema validation.`);
  process.exit(1);
}

console.log("\nAll example and fixture documents validate against the committed schemas.");
