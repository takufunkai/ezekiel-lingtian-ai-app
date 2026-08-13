/**
 * CLI entrypoint. Two input modes, one pipeline:
 *
 *   reconcile <path-to-case.json> --out <out.json>
 *   reconcile --sources <dir> [--entity "<name>"] --out <out.json>
 *
 * The first is the primary path: a fixture case with its answer key. The second
 * consumes a **gathered set** — the directory `npm run gather` writes, which has
 * source documents and provenance but no ground truth, so it is not a
 * `FixtureCase` and no case file exists to point at. Both modes build model
 * input the same way (entity + documents stripped by `toModelInput`), run the
 * same engine, and go through the same mandatory validation.
 *
 * Exit codes: 0 success, 1 run failure (unloadable input, the model never
 * produced schema-valid output within the retry bound, or the output failed
 * validation), 2 usage error.
 *
 * Validation is a mandatory step, not an option: schema-valid output can still
 * cite a source that was never supplied or quote a span that appears nowhere in
 * it, and those are the failures this project exists to catch. A profile that
 * fails is still written, because it is the evidence prompt iteration works
 * from — the non-zero exit is what says it is not a result. That matters *more*
 * on a gathered set, not less: nobody hand-checked those documents.
 *
 * Run via `npm run reconcile -- <case.json> --out <out.json>`.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { API_KEY_ENV_VAR, getBaseUrl, getModel, hasApiKey } from "./client.js";
import type { ReconciledProfile, SourceDocument } from "./contract.js";
import {
  loadCaseWithDocuments,
  reconcileCaseFile,
  reconcileDocuments,
  type ModelCaller,
} from "./engine.js";
import { callLiveModel } from "./model-caller.js";
import { PROMPT_VERSION } from "./prompt.js";
import { formatSchemaErrors, tryReadJsonFile, validateSourceDocument } from "./schema.js";
import { formatViolations, validateOutput } from "./validate.js";

export const USAGE = [
  "usage: reconcile <path-to-case.json> --out <out.json>",
  '       reconcile --sources <dir> [--entity "<name>"] --out <out.json>',
].join("\n");

/** Fixture-case mode: the primary path. */
export interface CliArgs {
  casePath: string;
  outPath: string;
}

/** Gathered-set mode: source documents plus an entity, no case file. */
export interface SourcesCliArgs {
  /** A gathered set directory (or a directory of `*.json` documents). */
  sourcesDir: string;
  /** Overrides `topic.json`'s `entity.name`; required when there is no `topic.json`. */
  entityName?: string;
  outPath: string;
}

export type ParsedArgs = CliArgs | SourcesCliArgs;

/** True for fixture-case mode. The two modes share no fields. */
export function isCaseArgs(args: ParsedArgs): args is CliArgs {
  return "casePath" in args;
}

/** Parses CLI arguments (everything after the script name). Pure, for testing. */
export function parseArgs(
  argv: string[],
): { ok: true; args: ParsedArgs } | { ok: false; error: string } {
  let casePath: string | undefined;
  let outPath: string | undefined;
  let sourcesDir: string | undefined;
  let entityName: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--out" || arg === "--sources" || arg === "--entity") {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        return { ok: false, error: `${arg} requires a ${arg === "--entity" ? "name" : "path"}` };
      }
      if (arg === "--out") outPath = value;
      else if (arg === "--sources") sourcesDir = value;
      else entityName = value;
    } else if (arg.startsWith("-")) {
      return { ok: false, error: `unknown option: ${arg}` };
    } else if (casePath === undefined) {
      casePath = arg;
    } else {
      return { ok: false, error: `unexpected extra argument: ${arg}` };
    }
  }

  if (casePath !== undefined && sourcesDir !== undefined) {
    return {
      ok: false,
      error: "give either <path-to-case.json> or --sources <dir>, not both",
    };
  }
  // Checked before --out, so an argument-free invocation still says what the
  // input is meant to be first, as it always has.
  if (casePath === undefined && sourcesDir === undefined) {
    return { ok: false, error: "missing <path-to-case.json> (or --sources <dir>)" };
  }
  if (outPath === undefined) {
    return { ok: false, error: "missing --out <out.json>" };
  }

  if (sourcesDir !== undefined) {
    const args: SourcesCliArgs = { sourcesDir, outPath };
    if (entityName !== undefined) {
      if (entityName.trim() === "") {
        return { ok: false, error: "--entity requires a non-empty name" };
      }
      args.entityName = entityName.trim();
    }
    return { ok: true, args };
  }

  if (entityName !== undefined) {
    return { ok: false, error: "--entity applies to --sources mode only" };
  }
  // Non-null: the "neither given" case returned above and `sourcesDir` is
  // undefined here, so a case path was supplied — narrowing across that
  // compound condition is more than the checker tracks.
  return { ok: true, args: { casePath: casePath!, outPath } };
}

/** A gathered set loaded off disk: its documents, and the entity to profile. */
export interface LoadedSources {
  entityName: string;
  documents: SourceDocument[];
  /** Directory the documents were read from, for logging. */
  sourcesDir: string;
}

export type LoadSourcesResult =
  { ok: true; value: LoadedSources } | { ok: false; errors: string[] };

/**
 * Loads a gathered set: every `*.json` document in it, plus the entity name.
 *
 * Accepts either the set root (`gathered/<slug>/`, documents under `sources/`)
 * or a bare directory of documents. The entity comes from `--entity` when given,
 * otherwise from `topic.json`'s `entity.name` — the manifest `gather` writes.
 * Documents are schema-checked here exactly as a case's documents are; a set is
 * only as trustworthy as the schema says it is, and this one came off the web.
 */
export function loadGatheredSources(
  sourcesDir: string,
  entityName: string | undefined,
): LoadSourcesResult {
  const root = resolve(sourcesDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, errors: [`--sources: "${sourcesDir}" is not a directory`] };
  }

  const nested = join(root, "sources");
  const documentsDir = existsSync(nested) && statSync(nested).isDirectory() ? nested : root;

  const files = readdirSync(documentsDir)
    .filter((name) => name.endsWith(".json") && name !== "topic.json")
    .sort();
  if (files.length === 0) {
    return { ok: false, errors: [`--sources: no *.json documents found in ${documentsDir}`] };
  }

  const documents: SourceDocument[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const name of files) {
    const parsed = tryReadJsonFile(join(documentsDir, name));
    if (!parsed.ok) {
      errors.push(`document "${name}": ${parsed.error}`);
      continue;
    }
    const result = validateSourceDocument(parsed.data);
    if (!result.valid) {
      errors.push(
        ...formatSchemaErrors(result.errors).map((line) => `document "${name}": ${line}`),
      );
      continue;
    }
    // Two documents sharing an id would make every citation to it ambiguous,
    // and the validator resolves quotes through an id-keyed map, so one would
    // silently shadow the other.
    if (seen.has(result.data.id)) {
      errors.push(`document "${name}": duplicate source id "${result.data.id}"`);
      continue;
    }
    seen.add(result.data.id);
    documents.push(result.data);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const resolvedEntity = entityName ?? readTopicEntityName(root, documentsDir);
  if (resolvedEntity === undefined) {
    return {
      ok: false,
      errors: [
        `--sources: no entity name — ${join(root, "topic.json")} is missing or has no ` +
          `entity.name, so pass --entity "<name>"`,
      ],
    };
  }

  return { ok: true, value: { entityName: resolvedEntity, documents, sourcesDir: documentsDir } };
}

/**
 * Reads `entity.name` from a gathered set's `topic.json`, if there is one.
 * Looked for beside the set root and beside the documents, so pointing
 * `--sources` at either `gathered/<slug>/` or `gathered/<slug>/sources` works.
 */
function readTopicEntityName(root: string, documentsDir: string): string | undefined {
  for (const candidate of new Set([
    join(root, "topic.json"),
    join(documentsDir, "..", "topic.json"),
  ])) {
    if (!existsSync(candidate)) continue;
    try {
      const data = JSON.parse(readFileSync(candidate, "utf8")) as {
        entity?: { name?: unknown };
      };
      const name = data.entity?.name;
      if (typeof name === "string" && name.trim() !== "") {
        return name.trim();
      }
    } catch {
      // A malformed topic.json is not fatal: --entity still names the subject.
      continue;
    }
  }
  return undefined;
}

export interface RunOptions {
  callModel: ModelCaller;
  /** Where run output goes. Defaults to stderr, prefixed by the caller. */
  log?: (line: string) => void;
}

/**
 * The whole run: load, reconcile, write, validate. Returns the exit code.
 *
 * Exported so both modes are testable offline with an injected `ModelCaller` —
 * `main` is only argument parsing, the key check, and the live caller.
 */
export async function run(args: ParsedArgs, options: RunOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));

  let profile: ReconciledProfile;
  let attempts: number;
  let documents: readonly SourceDocument[];

  if (isCaseArgs(args)) {
    const outcome = await reconcileCaseFile(args.casePath, {
      callModel: options.callModel,
      log,
    });
    if (!outcome.ok) {
      for (const line of outcome.errors) {
        log(`reconcile:   ${line}`);
      }
      log(
        outcome.stage === "load"
          ? "reconcile: FAILED — the case could not be loaded"
          : "reconcile: FAILED — the model never produced schema-valid output; nothing written",
      );
      return 1;
    }

    // The validator checks citations against the documents the run was actually
    // given. `reconcileCaseFile` loaded them internally; re-reading here leaves the
    // engine's signature alone, and the case is known to load since the run succeeded.
    const loaded = loadCaseWithDocuments(args.casePath);
    if (!loaded.ok) {
      for (const line of loaded.errors) {
        log(`reconcile:   ${line}`);
      }
      log("reconcile: FAILED — could not re-read the case to validate against");
      return 1;
    }
    profile = outcome.profile;
    attempts = outcome.attempts;
    documents = loaded.value.documents;
  } else {
    const loaded = loadGatheredSources(args.sourcesDir, args.entityName);
    if (!loaded.ok) {
      for (const line of loaded.errors) {
        log(`reconcile:   ${line}`);
      }
      log("reconcile: FAILED — the gathered sources could not be loaded");
      return 1;
    }
    log(
      `reconcile: entity="${loaded.value.entityName}" documents=${loaded.value.documents.length} ` +
        `from ${loaded.value.sourcesDir}`,
    );

    const outcome = await reconcileDocuments(
      { name: loaded.value.entityName },
      loaded.value.documents,
      { callModel: options.callModel, log },
    );
    if (!outcome.ok) {
      for (const failure of outcome.failures) {
        for (const reason of failure.reasons) {
          log(`reconcile:   attempt ${failure.attempt}: ${reason}`);
        }
      }
      log("reconcile: FAILED — the model never produced schema-valid output; nothing written");
      return 1;
    }
    profile = outcome.profile;
    attempts = outcome.attempts;
    documents = loaded.value.documents;
  }

  writeFileSync(resolve(args.outPath), `${JSON.stringify(profile, null, 2)}\n`);

  const validation = validateOutput(profile, documents);
  for (const line of formatViolations(validation)) {
    log(`reconcile:   ${line}`);
  }
  if (!validation.ok) {
    log(
      `reconcile: FAILED — schema-valid but ${validation.errorCount} validation error(s); ` +
        `wrote ${args.outPath} anyway as evidence`,
    );
    return 1;
  }

  const warnings = validation.warningCount > 0 ? `, ${validation.warningCount} warning(s)` : "";
  log(
    `reconcile: ok — wrote ${args.outPath} (schema-valid, validated, attempt ${attempts}${warnings})`,
  );
  return 0;
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

  const { args } = parsed;

  // Resolve the effective config up front so a bad env value fails here with
  // its actionable message, and log the gateway so a redirected base URL is
  // visible in every run log — not just in `npm run smoke`.
  let model: string;
  let gateway: string;
  try {
    model = getModel();
    gateway = getBaseUrl();
  } catch (error) {
    console.error(`reconcile: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const input = isCaseArgs(args) ? `case=${args.casePath}` : `sources=${args.sourcesDir}`;
  console.error(`reconcile: ${input} gateway=${gateway} model=${model} prompt=${PROMPT_VERSION}`);

  return run(args, { callModel: callLiveModel });
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
