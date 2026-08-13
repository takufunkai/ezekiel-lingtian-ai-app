#!/usr/bin/env tsx
/**
 * Renders a reconciled-profile JSON file to a self-contained HTML page.
 *
 *   npm run render -- <profile.json> --out <profile.html>
 *
 * The input must validate against `schema/claims.schema.json`; an invalid
 * profile is refused with a non-zero exit rather than rendered. Rendering only
 * blessed JSON keeps the pipeline honest — the renderer never papers over a
 * malformed engine output.
 */

import { writeFileSync } from "node:fs";
import { formatSchemaErrors, tryReadJsonFile, validateProfile } from "../src/schema.js";
import { renderProfileHtml } from "../src/render.js";

const USAGE = "usage: render <profile.json> --out <profile.html>";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { input: string; out: string } {
  let input: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--out") {
      out = argv[i + 1];
      if (out === undefined) die(`--out requires a value\n${USAGE}`);
      i += 1;
    } else if (arg.startsWith("-")) {
      die(`unknown option "${arg}"\n${USAGE}`);
    } else if (input === undefined) {
      input = arg;
    } else {
      die(`unexpected argument "${arg}"\n${USAGE}`);
    }
  }
  if (input === undefined || out === undefined) die(USAGE);
  return { input, out };
}

const { input, out } = parseArgs(process.argv.slice(2));

const parsed = tryReadJsonFile(input);
if (!parsed.ok) die(`${input} is not valid JSON: ${parsed.error}`);

const result = validateProfile(parsed.data);
if (!result.valid) {
  console.error(`${input} does not validate against schema/claims.schema.json:`);
  for (const line of formatSchemaErrors(result.errors)) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

writeFileSync(out, renderProfileHtml(result.data), "utf8");
console.log(`wrote ${out}`);
