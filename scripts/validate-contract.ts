#!/usr/bin/env tsx
/**
 * Proves the committed example documents validate against the committed schemas.
 *
 * Run with `npm run validate:contract`. Exits non-zero on the first failure so it
 * can be wired into CI.
 */

import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSchemaErrors,
  readJsonFile,
  validateProfile,
  validateSourceDocument,
  type SchemaResult,
} from "../src/schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");
const sourcesDir = join(examplesDir, "sources");

let failures = 0;

function report(path: string, result: SchemaResult<unknown>): void {
  const label = relative(repoRoot, path);
  if (result.valid) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}`);
  for (const line of formatSchemaErrors(result.errors)) {
    console.error(`          ${line}`);
  }
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
  report(path, validateSourceDocument(readJsonFile(path)));
}

console.log("reconciled profile  (schema/claims.schema.json)");
const profilePath = join(examplesDir, "reconciled-profile.example.json");
report(profilePath, validateProfile(readJsonFile(profilePath)));

if (failures > 0) {
  console.error(`\n${failures} document(s) failed schema validation.`);
  process.exit(1);
}

console.log("\nAll example documents validate against the committed schemas.");
