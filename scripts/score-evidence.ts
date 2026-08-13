/**
 * Re-scores the committed prompt-iteration evidence with Epic 6's scorer (#6).
 *
 *   npm run score:evidence
 *
 * Offline and deterministic: it reads the run profiles committed under
 * `docs/evidence/prompt-iteration/`, plus the response Epic 6's harness replays,
 * and needs no API key. Its stdout is what `docs/evidence/prompt-iteration/*.txt`
 * holds, so anyone can regenerate the transcripts and diff them.
 *
 * This replaces the branch's own `scripts/score-merge.ts`, deleted alongside it.
 * That scorer's matcher was injective, which capped `question recall` at the
 * emitted group count and turned a granularity change into an apparent recall
 * improvement — see `docs/prompt-iteration.md`. Nothing here reimplements
 * scoring: {@link scoreMergeQuality} and {@link formatMergeQualityScore} come
 * from `src/score.ts` unchanged, so #7's numbers and #6's numbers are the same
 * instrument and cannot drift apart.
 *
 * Every profile is put through the schema gate and the deterministic validator
 * before it is scored, so a corrupt or uncited piece of evidence fails loudly
 * here rather than contributing a quiet number to the report.
 */

import { relative } from "node:path";
import type { ReconciledProfile } from "../src/contract.js";
import { loadCaseWithDocuments, type LoadedCase } from "../src/engine.js";
import { casePath, cachedResponsePath, runHarnessCase } from "../src/harness.js";
import { formatSchemaErrors, tryReadJsonFile, validateProfile } from "../src/schema.js";
import { formatMergeQualityScore, matchQuestions, scoreMergeQuality } from "../src/score.js";
import { formatViolations, validateOutput } from "../src/validate.js";

const CASE_ID = "set-b-contradiction";
const EVIDENCE_DIR = "docs/evidence/prompt-iteration";

/** One profile to score, with where it came from and how far to trust it. */
interface Subject {
  label: string;
  /** Repo-relative, so the transcript does not leak an author's absolute paths. */
  path: string;
  /** Provenance, printed with the score — see `docs/prompt-iteration.md`. */
  provenance: string;
  load: () => Promise<ReconciledProfile>;
}

function readProfile(path: string): ReconciledProfile {
  const parsed = tryReadJsonFile(path);
  if (!parsed.ok) {
    throw new Error(`${path}: ${parsed.error}`);
  }
  const result = validateProfile(parsed.data);
  if (!result.valid) {
    throw new Error(
      `${path} is not a schema-valid profile:\n  ${formatSchemaErrors(result.errors).join("\n  ")}`,
    );
  }
  return result.data;
}

function evidenceRun(label: string, file: string, provenance: string): Subject {
  const path = `${EVIDENCE_DIR}/${file}`;
  return { label, path, provenance, load: async () => readProfile(path) };
}

const SUBJECTS: Subject[] = [
  evidenceRun(
    "v1 run 1",
    "set-b.v1.run1.json",
    "recorded run committed with this PR, attributed to minimax-m3 under PROMPT_VERSION=v1",
  ),
  evidenceRun(
    "v1 run 2",
    "set-b.v1.run2.json",
    "recorded run committed with this PR, attributed to minimax-m3 under PROMPT_VERSION=v1",
  ),
  evidenceRun(
    "v1 run 3",
    "set-b.v1.run3.json",
    "recorded run committed with this PR, attributed to minimax-m3 under PROMPT_VERSION=v1",
  ),
  evidenceRun(
    "v2 run 1",
    "set-b.v2.run1.json",
    "recorded run committed with this PR, attributed to minimax-m3 under PROMPT_VERSION=v2 (single sample)",
  ),
  {
    label: "Epic 6 replay cache",
    path: relative(process.cwd(), cachedResponsePath(CASE_ID)).replaceAll("\\", "/"),
    provenance:
      "HAND-AUTHORED, not recorded from a model (stated in #25's own PR body) — measures the harness and the fixture, NOT the v1 prompt",
    load: async () => (await runHarnessCase(CASE_ID)).profile,
  },
];

/**
 * Claims that sit in more than one group, with the statuses of those groups.
 *
 * Both prompts say "Every claim belongs to exactly one group", but nothing
 * enforces it: `schema/claims.schema.json` does not make `groups` a partition of
 * `claims`, and `validateOutput` reports only the opposite defect
 * (`CLAIM_NOT_GROUPED`). So a run can put one claim in two groups and stay green
 * on every existing check — and if the two groups disagree about status, the same
 * fact is rendered as both disputed and agreed. That happened here, which is why
 * this is measured rather than assumed. Reported, never asserted: this script is
 * an evidence generator, and the enforcement question belongs to the validator.
 */
function multiGroupClaims(profile: ReconciledProfile): string[] {
  const groupsByClaim = new Map<string, string[]>();
  for (const group of profile.groups) {
    for (const claimId of group.claimIds) {
      const seen = groupsByClaim.get(claimId) ?? [];
      seen.push(`${group.id}/${group.status}`);
      groupsByClaim.set(claimId, seen);
    }
  }
  return [...groupsByClaim.entries()]
    .filter(([, groups]) => groups.length > 1)
    .map(([claimId, groups]) => `${claimId} in ${groups.join(" + ")}`);
}

function scoreOne(loaded: LoadedCase, subject: Subject, profile: ReconciledProfile): void {
  console.log(`=== ${subject.label} ===`);
  console.log(`source     : ${subject.path}`);
  console.log(`provenance : ${subject.provenance}`);
  console.log(`model field: ${profile.model ?? "(unrecorded)"}`);
  console.log("");

  const validation = validateOutput(profile, loaded.documents);
  const violations = formatViolations(validation);
  console.log(`validator  : ${validation.ok ? "ok" : `${validation.errorCount} error(s)`}`);
  for (const line of violations) {
    console.log(`  ${line}`);
  }
  console.log("");

  for (const line of formatMergeQualityScore(scoreMergeQuality(loaded.fixtureCase, profile))) {
    console.log(line);
  }
  const multiGroup = multiGroupClaims(profile);
  console.log(
    `  claims in >1 group    : ${multiGroup.length}  (${multiGroup.length === 0 ? "none" : multiGroup.join(", ")})`,
  );
  console.log("");

  // The alignment, printed in full and with its scores, because the previous
  // scorer's headline number turned out to rest on matches that were visibly
  // wrong once you looked at them. A reader can check every row here.
  console.log("loose match (expected question -> answering group):");
  for (const match of matchQuestions(loaded.fixtureCase, profile)) {
    if (match.group === undefined) {
      console.log(`  MISS  ${match.questionId} [${match.expectedStatus}] -> (no group answers it)`);
      continue;
    }
    const verdict = match.group.status === match.expectedStatus ? "ok   " : "STATUS";
    const scores = `src ${match.score.sourceScore.toFixed(2)} lex ${match.score.lexicalScore.toFixed(2)}`;
    console.log(
      `  ${verdict} ${match.questionId} [${match.expectedStatus}] -> ${match.group.id} ` +
        `[${match.group.status}] "${match.group.question}" (${scores})`,
    );
  }
  console.log("");
}

async function main(): Promise<number> {
  const loaded = loadCaseWithDocuments(casePath(CASE_ID));
  if (!loaded.ok) {
    console.error(`score:evidence: could not load ${CASE_ID} — ${loaded.errors.join("; ")}`);
    return 1;
  }

  console.log(`Scored with src/score.ts (Epic 6, #25) against examples/${CASE_ID}.case.json.`);
  console.log("over-merge / under-merge come from a one-to-one assignment; status and");
  console.log("answered-at-all come from a loose non-exclusive match. No model call, no API key.");
  console.log("");

  for (const subject of SUBJECTS) {
    scoreOne(loaded.value, subject, await subject.load());
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`score:evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
