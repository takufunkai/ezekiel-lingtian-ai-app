/**
 * Record/replay plumbing for the end-to-end suite (issue #6).
 *
 * The engine takes an injectable `ModelCaller`, so the three canonical cases run
 * with **no API key and no network**: {@link replayCaller} returns a caller that
 * reads one cached response per case from `test/fixtures/harness/`. That is what
 * `npm run test:e2e` exercises, and it is why the suite is deterministic.
 *
 * The cached responses go through the engine's normal path — parsed as JSON and
 * validated against `schema/claims.schema.json` — so a malformed cache fails the
 * suite the same way a malformed model response would. Nothing here patches or
 * post-processes them.
 *
 * Re-recording against the live gateway:
 *
 *     npx tsx src/harness.ts --live                 # all three cases
 *     npx tsx src/harness.ts --live set-b-contradiction
 *
 * That path needs `OPENCODE_API_KEY` and overwrites the cached response with the
 * raw text of the attempt the engine accepted (pretty-printed for a readable
 * diff, since the cache is committed).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureCase, ReconciledProfile, SourceDocument } from "./contract.js";
import {
  loadCaseWithDocuments,
  reconcile,
  type AttemptFailure,
  type ModelCaller,
} from "./engine.js";
import { hasApiKey, API_KEY_ENV_VAR } from "./client.js";
import { callLiveModel } from "./model-caller.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The three rubric-required cases, in the order the suite reports them. */
export const HARNESS_CASE_IDS = [
  "set-a-agreement",
  "set-b-contradiction",
  "set-c-poisoned",
] as const;

export type HarnessCaseId = (typeof HARNESS_CASE_IDS)[number];

/** Committed case manifest for a harness case. */
export function casePath(caseId: string): string {
  return join(repoRoot, "examples", `${caseId}.case.json`);
}

/** Committed cached model response for a harness case. */
export function cachedResponsePath(caseId: string): string {
  return join(repoRoot, "test", "fixtures", "harness", `${caseId}.response.json`);
}

/**
 * A `ModelCaller` that ignores the request and replays the cached response.
 *
 * Deliberately returns the file's text unchanged rather than a re-serialised
 * object: the engine's `JSON.parse` is part of what is under test.
 */
export function replayCaller(caseId: string): ModelCaller {
  const path = cachedResponsePath(caseId);
  return async () => readFileSync(path, "utf8");
}

/** One completed harness run: the manifest, its documents, and the profile. */
export interface HarnessRun {
  caseId: string;
  fixtureCase: FixtureCase;
  /** The documents actually supplied to the run — the validator's ground truth. */
  documents: SourceDocument[];
  profile: ReconciledProfile;
  attempts: number;
  failures: AttemptFailure[];
}

/**
 * Loads a case, runs it through the engine with the given caller (replay by
 * default), and returns the accepted profile.
 *
 * @throws when the case cannot be loaded or the response is rejected — both are
 * harness defects rather than test outcomes, so they surface as errors with the
 * engine's own reasons attached rather than as a soft failure.
 */
export async function runHarnessCase(
  caseId: string,
  callModel: ModelCaller = replayCaller(caseId),
): Promise<HarnessRun> {
  const loaded = loadCaseWithDocuments(casePath(caseId));
  if (!loaded.ok) {
    throw new Error(`${caseId}: could not load the case — ${loaded.errors.join("; ")}`);
  }

  const outcome = await reconcile(loaded.value, { callModel, log: () => {} });
  if (!outcome.ok) {
    const reasons = outcome.failures
      .flatMap((failure) =>
        failure.reasons.map((reason) => `attempt ${failure.attempt}: ${reason}`),
      )
      .join("\n  ");
    throw new Error(
      `${caseId}: the engine rejected the cached response, so it is not a valid profile:\n  ${reasons}`,
    );
  }

  return {
    caseId,
    fixtureCase: loaded.value.fixtureCase,
    documents: loaded.value.documents,
    profile: outcome.profile,
    attempts: outcome.attempts,
    failures: outcome.failures,
  };
}

/**
 * Re-records one case's cached response against the live gateway.
 *
 * Only the accepted attempt is written, so a cache file is always a response the
 * engine let through. UNEXERCISED: there is no API key on the authoring machine,
 * so this path has never been run — see the PR body for #6.
 */
export async function recordHarnessCase(caseId: string): Promise<string> {
  let lastRaw: string | undefined;
  const capturing: ModelCaller = async (request) => {
    const raw = await callLiveModel(request);
    lastRaw = raw;
    return raw;
  };

  const run = await runHarnessCase(caseId, capturing);
  if (lastRaw === undefined) {
    throw new Error(`${caseId}: the live caller produced no response to record`);
  }

  const path = cachedResponsePath(caseId);
  // Pretty-printed because the cache is committed and reviewed as a diff. Parsed
  // from the raw text first, so anything that is not JSON fails here loudly.
  writeFileSync(path, `${JSON.stringify(JSON.parse(lastRaw), null, 2)}\n`, "utf8");
  return `${caseId}: recorded ${run.profile.claims.length} claim(s) and ${run.profile.groups.length} group(s) to ${path}`;
}

const USAGE = `Usage: tsx src/harness.ts --live [caseId...]

Re-records the cached model responses the end-to-end suite replays.
Cases: ${HARNESS_CASE_IDS.join(", ")}

Replaying (the default, no key needed) is what \`npm run test:e2e\` does.`;

async function main(argv: readonly string[]): Promise<number> {
  if (!argv.includes("--live")) {
    console.error(USAGE);
    return 2;
  }
  if (!hasApiKey()) {
    console.error(`${API_KEY_ENV_VAR} is not set, so there is nothing to record against.`);
    return 1;
  }

  const named = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = named.filter((id) => !(HARNESS_CASE_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    console.error(`unknown case id(s): ${unknown.join(", ")}\n\n${USAGE}`);
    return 2;
  }

  for (const caseId of named.length > 0 ? named : HARNESS_CASE_IDS) {
    console.log(await recordHarnessCase(caseId));
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
