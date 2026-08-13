#!/usr/bin/env tsx
/**
 * Proves the committed example documents validate against the committed schemas.
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

console.log("fixture cases  (schema/fixture-case.schema.json)");
const caseFiles = readdirSync(examplesDir)
  .filter((name) => name.endsWith("case.example.json") || name.endsWith(".case.json"))
  .sort();
for (const name of caseFiles) {
  const path = join(examplesDir, name);
  const data = load(path);
  if (data === undefined) continue;

  const result = validateFixtureCase(data);
  report(path, result);
  if (!result.valid) continue;

  // Cross-file checks the schema cannot express: the referenced documents must
  // exist, and every source id named in the expectations must be one of them.
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
    declaredIds.add((doc.data as SourceDocument).id);
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

  if (problems.length > 0) fail(path, problems);
}

if (failures > 0) {
  console.error(`\n${failures} document(s) failed schema validation.`);
  process.exit(1);
}

console.log("\nAll example documents validate against the committed schemas.");
