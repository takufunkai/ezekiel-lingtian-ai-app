/**
 * CLI entrypoint: `reconcile <path-to-case.json> --out <out.json>`.
 *
 * Runs the engine against a fixture case with the live model caller, validates
 * the result deterministically, and writes the profile to `--out`. Exit codes:
 * 0 success, 1 run failure (unloadable case, the model never produced
 * schema-valid output within the retry bound, or the output failed
 * validation), 2 usage error.
 *
 * Validation is a mandatory step, not an option: schema-valid output can still
 * cite a source that was never supplied or quote a span that appears nowhere in
 * it, and those are the failures this project exists to catch. A profile that
 * fails is still written, because it is the evidence prompt iteration works
 * from — the non-zero exit is what says it is not a result.
 *
 * Run via `npm run reconcile -- <case.json> --out <out.json>`.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { API_KEY_ENV_VAR, MODEL, hasApiKey } from "./client.js";
import { loadCaseWithDocuments, reconcileCaseFile } from "./engine.js";
import { callLiveModel } from "./model-caller.js";
import { PROMPT_VERSION } from "./prompt.js";
import { formatViolations, validateOutput } from "./validate.js";

export const USAGE = "usage: reconcile <path-to-case.json> --out <out.json>";

export interface CliArgs {
  casePath: string;
  outPath: string;
}

/** Parses CLI arguments (everything after the script name). Pure, for testing. */
export function parseArgs(
  argv: string[],
): { ok: true; args: CliArgs } | { ok: false; error: string } {
  let casePath: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--out") {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        return { ok: false, error: "--out requires a path" };
      }
      outPath = value;
    } else if (arg.startsWith("-")) {
      return { ok: false, error: `unknown option: ${arg}` };
    } else if (casePath === undefined) {
      casePath = arg;
    } else {
      return { ok: false, error: `unexpected extra argument: ${arg}` };
    }
  }

  if (casePath === undefined) {
    return { ok: false, error: "missing <path-to-case.json>" };
  }
  if (outPath === undefined) {
    return { ok: false, error: "missing --out <out.json>" };
  }
  return { ok: true, args: { casePath, outPath } };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`reconcile: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }

  if (!hasApiKey()) {
    console.error(
      `reconcile: ${API_KEY_ENV_VAR} is not set — copy .env.example to .env and add your key. No call made.`,
    );
    return 1;
  }

  const { casePath, outPath } = parsed.args;
  console.error(`reconcile: case=${casePath} model=${MODEL} prompt=${PROMPT_VERSION}`);

  const outcome = await reconcileCaseFile(casePath, { callModel: callLiveModel });
  if (!outcome.ok) {
    for (const line of outcome.errors) {
      console.error(`reconcile:   ${line}`);
    }
    console.error(
      outcome.stage === "load"
        ? "reconcile: FAILED — the case could not be loaded"
        : "reconcile: FAILED — the model never produced schema-valid output; nothing written",
    );
    return 1;
  }

  // The validator checks citations against the documents the run was actually
  // given. `reconcileCaseFile` loaded them internally; re-reading here leaves the
  // engine's signature alone, and the case is known to load since the run succeeded.
  const loaded = loadCaseWithDocuments(casePath);
  if (!loaded.ok) {
    for (const line of loaded.errors) {
      console.error(`reconcile:   ${line}`);
    }
    console.error("reconcile: FAILED — could not re-read the case to validate against");
    return 1;
  }

  writeFileSync(resolve(outPath), `${JSON.stringify(outcome.profile, null, 2)}\n`);

  const validation = validateOutput(outcome.profile, loaded.value.documents);
  for (const line of formatViolations(validation)) {
    console.error(`reconcile:   ${line}`);
  }
  if (!validation.ok) {
    console.error(
      `reconcile: FAILED — schema-valid but ${validation.errorCount} validation error(s); ` +
        `wrote ${outPath} anyway as evidence`,
    );
    return 1;
  }

  const warnings = validation.warningCount > 0 ? `, ${validation.warningCount} warning(s)` : "";
  console.error(
    `reconcile: ok — wrote ${outPath} (schema-valid, validated, attempt ${outcome.attempts}${warnings})`,
  );
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        `reconcile: unexpected error: ${error instanceof Error ? error.message : error}`,
      );
      process.exit(1);
    },
  );
}
