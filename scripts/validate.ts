#!/usr/bin/env tsx
/**
 * Deterministic validation of one reconciliation output against its inputs.
 *
 *   npm run validate -- --profile <out.json> --sources <dir-or-case.json>
 *
 * `--sources` is either a directory of source-document JSON files or a
 * fixture-case file whose `documents` are resolved relative to it.
 *
 * Prints a JSON violation report to stdout. Exits 0 on a clean pass, 1 when any
 * violation is found (including unreadable input files), 2 on bad usage.
 */

import { parseArgs } from "node:util";
import { validateFiles } from "../src/validator.js";

const USAGE = "usage: npm run validate -- --profile <out.json> --sources <dir-or-case.json>";

let profile: string | undefined;
let sources: string | undefined;
try {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      sources: { type: "string" },
    },
  });
  profile = values.profile;
  sources = values.sources;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exit(2);
}

if (profile === undefined || sources === undefined) {
  console.error(USAGE);
  process.exit(2);
}

const report = validateFiles(profile, sources);
console.log(JSON.stringify(report, null, 2));
process.exit(report.valid ? 0 : 1);
