#!/usr/bin/env tsx
/**
 * Validates a reconciled profile against the source documents it cites.
 *
 *   npm run validate:output -- <profile.json> <source.json|sources-dir>… [options]
 *
 * A source argument may be a single document or a directory, in which case every
 * `*.json` file directly inside it is loaded. Options:
 *
 *   --json     print the violation report as JSON instead of one line per violation
 *   --strict   treat warnings (an ungrouped claim) as failures too
 *
 * Exit codes: 0 clean, 1 violations found, 2 bad usage or unreadable input. The
 * distinction matters for CI — 2 means the check could not run, not that the
 * profile is wrong.
 *
 * This is the standalone entry point. Wiring the same `validateOutput` call into
 * the `reconcile` pipeline belongs to the engine epic (#3), which owns that command.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatSchemaErrors, tryReadJsonFile, validateSourceDocument } from "../src/schema.js";
import { formatViolations, validateOutput } from "../src/validate.js";
import type { SourceDocument } from "../src/contract.js";

const USAGE =
  "usage: tsx scripts/validate-output.ts <profile.json> <source.json|sources-dir>… [--json] [--strict]";

/** Input problems exit 2: the validator could not run, which is not a verdict. */
function die(message: string): never {
  console.error(message);
  process.exit(2);
}

const positionals: string[] = [];
let asJson = false;
let strict = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--json") {
    asJson = true;
  } else if (arg === "--strict") {
    strict = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith("-")) {
    die(`unknown option "${arg}"\n${USAGE}`);
  } else {
    positionals.push(arg);
  }
}

const [profilePath, ...sourceArgs] = positionals;
if (profilePath === undefined || sourceArgs.length === 0) die(USAGE);

/** Expands a source argument into the list of document files it names. */
function expand(target: string): string[] {
  if (!existsSync(target)) die(`no such file or directory: ${target}`);
  if (!statSync(target).isDirectory()) return [target];

  const files = readdirSync(target)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(target, name));
  if (files.length === 0) die(`no .json source documents in ${target}`);
  return files;
}

const sources: SourceDocument[] = [];
for (const path of sourceArgs.flatMap((target) => expand(target))) {
  const parsed = tryReadJsonFile(path);
  if (!parsed.ok) die(`${path} is not valid JSON: ${parsed.error}`);

  // The input set has to be trustworthy before it can be used as ground truth.
  const result = validateSourceDocument(parsed.data);
  if (!result.valid) {
    const lines = formatSchemaErrors(result.errors).map((line) => `  ${line}`);
    die([`${path} does not match source-document.schema.json:`, ...lines].join("\n"));
  }
  sources.push(result.data);
}

const profile = tryReadJsonFile(profilePath);
if (!profile.ok) die(`${profilePath} is not valid JSON: ${profile.error}`);

const report = validateOutput(profile.data, sources, { strict });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`profile  ${profilePath}`);
  console.log(`sources  ${sources.map((source) => source.id).join(", ")}`);
  for (const line of formatViolations(report)) {
    console.log(`  ${line}`);
  }
  if (report.ok && report.violations.length === 0) {
    console.log("\nOK — every claim is cited and every quote appears verbatim in its source.");
  } else if (report.ok) {
    console.log(`\nOK with ${report.warningCount} warning(s). Use --strict to fail on them.`);
  } else {
    console.log(`\nFAIL — ${report.errorCount} error(s), ${report.warningCount} warning(s).`);
  }
}

process.exit(report.ok ? 0 : 1);
