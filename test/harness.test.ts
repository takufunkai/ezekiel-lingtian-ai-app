/**
 * Epic 6 — the end-to-end harness over the three canonical examples.
 *
 * One command, offline, no API key: `npm run test:e2e`. Each case is loaded from
 * its committed manifest, run through the real engine with a replay `ModelCaller`
 * that reads a cached response from `test/fixtures/harness/`, and then checked
 * against `expect.questions` in the manifest — never against hardcoded strings in
 * this file.
 *
 * ## What is asserted vs. what is only reported
 *
 * `expect.questions` is pitched finer than `prompts/reconcile.v1.md` calibrates
 * for: Set C lists three separate questions about the pamphlet prize, and a run
 * that answers all three in one group is behaving reasonably. So **group count is
 * not a verdict here**.
 *
 * Asserted (pass/fail):
 *   - every listed question is answered by some group, with the manifest's status;
 *   - Set A emits no disputed group and every claim carries a citation;
 *   - Set B's two planted contradictions are disputed, hold at least two claims,
 *     and draw on at least two documents — nothing averaged, nothing resolved;
 *   - Set C cites nothing from the impostor;
 *   - `expect.requiredSourceIds` each support a claim;
 *   - the deterministic validator (#4) reports `ok` on all three profiles.
 *
 * Reported as numbers only (never a failure): over-merge and under-merge counts,
 * from `scoreMergeQuality`. That is the before/after evidence Epic 7 (#20)
 * consumes; see `src/score.ts` for how a question is matched to a group.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExpectedQuestion } from "../src/contract.js";
import {
  HARNESS_CASE_IDS,
  cachedResponsePath,
  runHarnessCase,
  type HarnessRun,
} from "../src/harness.js";
import {
  formatMergeQualityScore,
  matchQuestions,
  scoreMergeQuality,
  type QuestionMatch,
} from "../src/score.js";
import { formatViolations, validateOutput } from "../src/validate.js";

/** Each case runs once, however many `it` blocks read it. */
const started = new Map<string, Promise<HarnessRun>>();

function harnessRun(caseId: string): Promise<HarnessRun> {
  const existing = started.get(caseId);
  if (existing !== undefined) return existing;
  const promise = runHarnessCase(caseId);
  started.set(caseId, promise);
  return promise;
}

/** How a match reads in a failure message: the status, or the fact there is none. */
function describeMatch(match: QuestionMatch): string {
  if (match.group === undefined) {
    return `no group answering it (no group cites any of ${match.expectedSourceIds.join(", ")})`;
  }
  return `${match.group.status} (group ${match.group.id}, "${match.group.question}", citing ${
    match.group.citedSourceIds.join(", ") || "nothing"
  })`;
}

/**
 * Asserts every question in the manifest is answered with the status the manifest
 * gives. Reads `expect.questions`; hardcodes nothing.
 */
function expectManifestStatuses(run: HarnessRun): void {
  const matches = matchQuestions(run.fixtureCase, run.profile);
  expect(matches.length).toBe(run.fixtureCase.expect.questions.length);

  for (const match of matches) {
    expect(
      match.group?.status,
      `${match.questionId} ("${match.question}"): expected ${match.expectedStatus}, got ${describeMatch(match)}`,
    ).toBe(match.expectedStatus);
  }
}

/** Asserts the deterministic validator finds nothing blocking. */
function expectValidatorGreen(run: HarnessRun): void {
  const report = validateOutput(run.profile, run.documents);
  expect(
    report.ok,
    `${run.caseId}: the validator must stay green, but it reported ${report.errorCount} error(s):\n${formatViolations(
      report,
    ).join("\n")}`,
  ).toBe(true);
}

/** Asserts `expect.requiredSourceIds` each support at least one claim. */
function expectRequiredSourcesUsed(run: HarnessRun): void {
  const score = scoreMergeQuality(run.fixtureCase, run.profile);
  expect(
    score.missingRequiredSourceIds,
    `${run.caseId}: expect.requiredSourceIds names document(s) that support no claim in the profile: ${score.missingRequiredSourceIds.join(
      ", ",
    )}`,
  ).toEqual([]);
}

function disputedQuestions(run: HarnessRun): ExpectedQuestion[] {
  return run.fixtureCase.expect.questions.filter((question) => question.status === "disputed");
}

describe("the cached responses the suite replays", () => {
  it.each([...HARNESS_CASE_IDS])("%s has a committed cached response", (caseId) => {
    const path = cachedResponsePath(caseId);
    expect(existsSync(path), `${caseId}: no cached response at ${path}`).toBe(true);
  });

  it.each([...HARNESS_CASE_IDS])("%s replays without any API key", async (caseId) => {
    // The replay caller never touches the network, so this passes with the key
    // unset — which is the whole point of the record/replay half of issue #6.
    const run = await harnessRun(caseId);
    expect(run.attempts, `${caseId}: the cached response was rejected and retried`).toBe(1);
    expect(run.failures).toEqual([]);
    expect(run.profile.entity.name).toBe(run.fixtureCase.entity.name);
  });
});

describe("Test 1 — Set A, all sources agree", () => {
  const caseId = "set-a-agreement";

  it("marks no group disputed", async () => {
    const run = await harnessRun(caseId);
    const disputed = run.profile.groups
      .filter((group) => group.status === "disputed")
      .map((group) => `${group.id} ("${group.question}")`);
    expect(
      disputed,
      `${caseId}: the sources corroborate each other, so no group may be disputed — got ${disputed.length}: ${disputed.join(
        "; ",
      )}`,
    ).toEqual([]);
  });

  it("answers every manifest question with the expected status", async () => {
    expectManifestStatuses(await harnessRun(caseId));
  });

  it("cites every claim", async () => {
    const run = await harnessRun(caseId);
    expect(run.profile.claims.length).toBeGreaterThan(0);
    const uncited = run.profile.claims
      .filter((claim) => claim.citations.length === 0)
      .map((claim) => claim.id);
    expect(
      uncited,
      `${caseId}: every claim must carry at least one citation — uncited: ${uncited.join(", ")}`,
    ).toEqual([]);
  });

  it("uses every required source", async () => {
    expectRequiredSourcesUsed(await harnessRun(caseId));
  });

  it("passes the deterministic validator", async () => {
    expectValidatorGreen(await harnessRun(caseId));
  });
});

describe("Test 2 — Set B, planted contradictions", () => {
  const caseId = "set-b-contradiction";

  it("surfaces each planted contradiction as a disputed group", async () => {
    const run = await harnessRun(caseId);
    const matches = matchQuestions(run.fixtureCase, run.profile);
    const expectedDisputed = disputedQuestions(run);

    // The manifest, not this file, decides which questions these are.
    expect(
      expectedDisputed.length,
      `${caseId}: the manifest should plant at least one contradiction`,
    ).toBeGreaterThan(0);

    for (const question of expectedDisputed) {
      const match = matches.find((candidate) => candidate.questionId === question.id);
      expect(match, `${question.id}: not present in the manifest match set`).toBeDefined();
      if (match === undefined) continue;

      expect(
        match.group?.status,
        `${question.id} ("${question.question}"): expected disputed, got ${describeMatch(match)}`,
      ).toBe("disputed");

      const group = match.group;
      if (group === undefined) continue;

      // Neither averaged nor resolved to one answer: the conflicting answers must
      // still be there, side by side, each backed by its own document.
      expect(
        group.claimCount,
        `${question.id}: group ${group.id} is disputed but holds ${group.claimCount} claim(s), so the conflicting answers were merged into one`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        group.citedSourceIds.length,
        `${question.id}: group ${group.id} draws on ${group.citedSourceIds.length} document(s) (${group.citedSourceIds.join(
          ", ",
        )}); a surviving dispute needs at least two`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the planted contradictions as separate disputes", async () => {
    const run = await harnessRun(caseId);
    const matches = matchQuestions(run.fixtureCase, run.profile);

    // Over-merging *agreed* questions is a quality number, not a failure — but the
    // manifest plants two independent contradictions on different topics, and
    // collapsing them into one group means one of them is not surfaced as its own
    // dispute, which is precisely what Test 2 exists to catch.
    const byGroup = new Map<string, string[]>();
    for (const question of disputedQuestions(run)) {
      const group = matches.find((candidate) => candidate.questionId === question.id)?.group;
      if (group === undefined) continue;
      byGroup.set(group.id, [...(byGroup.get(group.id) ?? []), question.id]);
    }

    const fused = [...byGroup]
      .filter(([, questionIds]) => questionIds.length > 1)
      .map(
        ([groupId, questionIds]) => `${questionIds.join(" and ")} both resolve to group ${groupId}`,
      );
    expect(
      fused,
      `${caseId}: each planted contradiction must be its own disputed group — ${fused.join("; ")}`,
    ).toEqual([]);
  });

  it("answers every manifest question with the expected status", async () => {
    expectManifestStatuses(await harnessRun(caseId));
  });

  it("emits a numeric merge-quality score", async () => {
    const run = await harnessRun(caseId);
    const score = scoreMergeQuality(run.fixtureCase, run.profile);

    // Printed so `npm run test:e2e` is itself the before/after evidence for #7.
    for (const line of formatMergeQualityScore(score)) console.log(line);

    // The numbers are evidence, not a verdict: over/under-merge are asserted only
    // to be well-formed, never to be zero. The real defects are asserted instead.
    for (const [name, value] of [
      ["overMerge", score.overMerge],
      ["underMerge", score.underMerge],
      ["matchedCount", score.matchedCount],
      ["questionCount", score.questionCount],
      ["groupCount", score.groupCount],
    ] as const) {
      expect(Number.isInteger(value), `${caseId}: ${name} must be an integer, got ${value}`).toBe(
        true,
      );
      expect(value, `${caseId}: ${name} must not be negative`).toBeGreaterThanOrEqual(0);
    }
    expect(
      score.groupCount - score.questionCount,
      `${caseId}: the score must account for every group and question (groups - questions should equal underMerge - overMerge)`,
    ).toBe(score.underMerge - score.overMerge);

    expect(
      score.unansweredQuestionIds,
      `${caseId}: question(s) the run never answers: ${score.unansweredQuestionIds.join(", ")}`,
    ).toEqual([]);
    expect(
      score.statusMismatches.map(
        (mismatch) =>
          `${mismatch.questionId}: expected ${mismatch.expected}, got ${mismatch.actual}`,
      ),
      `${caseId}: status mismatches against the manifest`,
    ).toEqual([]);
  });

  it("passes the deterministic validator", async () => {
    expectValidatorGreen(await harnessRun(caseId));
  });
});

describe("Test 3 — Set C, poisoned input", () => {
  const caseId = "set-c-poisoned";

  it("cites nothing from the excluded impostor documents", async () => {
    const run = await harnessRun(caseId);
    const excluded = run.fixtureCase.expect.excludedSourceIds ?? [];
    expect(
      excluded.length,
      `${caseId}: the manifest should name at least one excluded source`,
    ).toBeGreaterThan(0);

    const score = scoreMergeQuality(run.fixtureCase, run.profile);
    const offenders = score.excludedCitations.map(
      (citation) =>
        `claim ${citation.claimId} cites excluded source ${citation.sourceId} ("${citation.quote}")`,
    );
    expect(
      offenders,
      `${caseId}: expect.excludedSourceIds is [${excluded.join(
        ", ",
      )}], so no claim may cite them — ${offenders.length} did:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("answers every manifest question with the expected status", async () => {
    expectManifestStatuses(await harnessRun(caseId));
  });

  it("marks no group disputed, since the only conflict came from the impostor", async () => {
    const run = await harnessRun(caseId);
    const expectedDisputed = disputedQuestions(run).map((question) => question.id);
    const actualDisputed = run.profile.groups
      .filter((group) => group.status === "disputed")
      .map((group) => `${group.id} ("${group.question}")`);
    // Read from the manifest: Set C plants no contradiction between genuine sources.
    expect(expectedDisputed).toEqual([]);
    expect(
      actualDisputed,
      `${caseId}: a disputed group here means the impostor's answers were merged in — got: ${actualDisputed.join(
        "; ",
      )}`,
    ).toEqual([]);
  });

  it("uses every required source", async () => {
    expectRequiredSourcesUsed(await harnessRun(caseId));
  });

  it("keeps the deterministic validator green", async () => {
    expectValidatorGreen(await harnessRun(caseId));
  });
});

describe("the merge-quality score reports both failure directions", () => {
  it("prints a score for all three cases", async () => {
    for (const caseId of HARNESS_CASE_IDS) {
      const run = await harnessRun(caseId);
      for (const line of formatMergeQualityScore(scoreMergeQuality(run.fixtureCase, run.profile))) {
        console.log(line);
      }
    }
  });

  it("counts a fused pair of groups as one over-merge", async () => {
    const run = await harnessRun("set-b-contradiction");
    const mutated = structuredClone(run.profile);
    // Fuse the two disputed groups into one. Two manifest questions now share a
    // single group, so exactly one of them loses its own group.
    const [first, second] = mutated.groups;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    first.claimIds = [...first.claimIds, ...second.claimIds];
    first.question = `${first.question} ${second.question}`;
    mutated.groups = mutated.groups.filter((group) => group.id !== second.id);

    const score = scoreMergeQuality(run.fixtureCase, mutated);
    expect(score.overMerge).toBe(1);
    expect(score.underMerge).toBe(0);
    // Still no status mismatch: the fused group is disputed, which is what both
    // questions expect. Over-merging is a quality number, not a failure.
    expect(score.statusMismatches).toEqual([]);
  });

  it("counts a split group as one under-merge", async () => {
    const run = await harnessRun("set-b-contradiction");
    const mutated = structuredClone(run.profile);
    const target = mutated.groups.find((group) => group.claimIds.length >= 2);
    expect(target).toBeDefined();
    if (target === undefined) return;
    const [firstClaimId, ...restClaimIds] = target.claimIds;
    expect(firstClaimId).toBeDefined();
    if (firstClaimId === undefined) return;
    target.claimIds = [firstClaimId];
    target.status = "agreed";
    mutated.groups.push({
      id: `${target.id}-split`,
      question: target.question,
      status: "agreed",
      claimIds: restClaimIds,
    });

    const score = scoreMergeQuality(run.fixtureCase, mutated);
    expect(score.underMerge).toBe(1);
    expect(score.overMerge).toBe(0);
  });
});
