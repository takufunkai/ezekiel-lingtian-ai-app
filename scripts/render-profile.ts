#!/usr/bin/env tsx
/**
 * Renders a reconciled-profile document as one self-contained HTML page.
 *
 *   npm run render -- test/fixtures/renderer/founding-date-dispute.profile.json profile.html
 *   npm run render -- examples/reconciled-profile.example.json > profile.html
 *
 * The input is checked against `schema/claims.schema.json` first: a document that
 * does not satisfy the contract is reported and nothing is written. Rendering
 * itself is deterministic, so re-running over an unchanged input rewrites an
 * identical file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatSchemaErrors, tryReadJsonFile, validateProfile } from "../src/schema.js";
import { renderProfileHtml } from "../src/render.js";

const USAGE = [
  "Usage: npm run render -- <profile.json> [output.html]",
  "",
  "Renders a reconciled-profile document as one self-contained HTML page.",
  "Without an output path the page is written to stdout.",
].join("\n");

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// `npm run render -- a b` can forward the `--` separator itself on some npm
// versions, so drop it before reading positional arguments.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const inputArg = args[0];
const outputArg = args[1];

if (inputArg === "-h" || inputArg === "--help") {
  console.log(USAGE);
  process.exit(0);
}

if (inputArg === undefined) {
  console.error("render-profile: missing input path.\n");
  die(USAGE);
}

const inputPath = resolve(inputArg);
const parsed = tryReadJsonFile(inputPath);
if (!parsed.ok) {
  die(`render-profile: ${inputPath} is not valid JSON: ${parsed.error}`);
}

const result = validateProfile(parsed.data);
if (!result.valid) {
  console.error(`render-profile: ${inputPath} does not satisfy schema/claims.schema.json`);
  for (const line of formatSchemaErrors(result.errors)) {
    console.error(`  ${line}`);
  }
  die("\nNothing rendered.");
}

const html = renderProfileHtml(result.data);

if (outputArg === undefined) {
  process.stdout.write(html);
} else {
  const outputPath = resolve(outputArg);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, "utf8");
  const groups = result.data.groups;
  const disputed = groups.filter((group) => group.status === "disputed").length;
  console.log(`Wrote ${outputPath}`);
  console.log(`  ${result.data.claims.length} claims, ${groups.length} questions`);
  console.log(`  ${disputed} of them disputed, shown side by side`);
}
