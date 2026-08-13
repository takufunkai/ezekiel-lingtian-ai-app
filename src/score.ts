/**
 * Merge-quality scoring: how well one run's groups line up with a case manifest.
 *
 * The manifest's `expect.questions` is the grouping answer key, but it is pitched
 * *finer* than the reconciliation prompt calibrates for — Set C lists three
 * separate questions about the pamphlet prize, and a run that answers all three
 * in one group is behaving reasonably. So group count is **not** a verdict here.
 * This module splits the two things a harness needs:
 *
 *   - {@link matchQuestions} — a *loose* (non-exclusive) best match per expected
 *     question. Several questions may land on the same group. This is what status
 *     assertions read: "does the output answer this question, and with the status
 *     the manifest says?" That is pass/fail.
 *   - {@link scoreMergeQuality} — a *one-to-one* greedy assignment between
 *     questions and groups. The two leftovers are the numbers: questions with no
 *     group of their own were over-merged, groups with no question of their own
 *     were under-merged. These are reported, never asserted, and are what the
 *     prompt-iteration epic (#7) compares v1 against v2 on.
 *
 * ## How a question is matched to a group
 *
 * The manifest says the question text is matched *semantically*, not by string
 * equality, and nothing here may call a model. The deterministic proxy is a pair,
 * compared lexicographically:
 *
 *   1. **Source-set Dice coefficient** — `2|A∩B| / (|A|+|B|)` over the manifest's
 *      `sourceIds` for the question and the set of `sourceId`s actually cited by
 *      the group's member claims. This is the primary signal because it is
 *      grounded in checkable output: which documents answer a question is ground
 *      truth in the manifest, and which documents a group cites is a fact about
 *      the profile. The group's own `question` string, by contrast, is free-form
 *      model prose.
 *   2. **Question-token Dice coefficient** — the same measure over content tokens
 *      of the two question strings (lowercased, stop-worded, crudely singularised).
 *      Used only to break source-set ties, which are common and unavoidable: in
 *      Set A four different questions are each answered by all five documents, so
 *      the evidence sets alone cannot tell them apart.
 *
 * Both are similarity measures over sets, not equality tests, so rephrasing
 * ("Where is it based?" vs "Where is the cooperative based?") does not break the
 * match. Nothing in this module reads `plantedFact` or `notes`.
 */

import type {
  ClaimGroup,
  ExpectedQuestion,
  FixtureCase,
  GroupStatus,
  ReconciledProfile,
} from "./contract.js";

/** Dice coefficient over two sets: 1 when identical, 0 when disjoint. */
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared += 1;
  }
  return (2 * shared) / (a.size + b.size);
}

/**
 * Words carrying no discriminating power in a "question about an entity".
 * Deliberately small and hand-picked: the point is to stop "what", "does" and
 * "the" from making every pair of questions look similar, not to build a stemmer.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "its",
  "many",
  "much",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "there",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "with",
]);

/** Crude singularisation, enough to make "members"/"member" match. */
function normaliseToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/** Content tokens of a question string, for the lexical tie-break. */
export function questionTokens(question: string): Set<string> {
  const tokens = question.toLowerCase().split(/[^a-z0-9]+/u);
  const out = new Set<string>();
  for (const token of tokens) {
    if (token.length === 0 || STOP_WORDS.has(token)) continue;
    out.add(normaliseToken(token));
  }
  return out;
}

/**
 * The set of input documents a group actually draws on: every `sourceId` cited by
 * any of its member claims. A `claimIds` entry matching no claim contributes
 * nothing (the validator reports that separately as `UNRESOLVED_CLAIM_ID`).
 */
export function citedSourceIds(profile: ReconciledProfile, group: ClaimGroup): Set<string> {
  const byId = new Map(profile.claims.map((claim) => [claim.id, claim]));
  const out = new Set<string>();
  for (const claimId of group.claimIds) {
    const claim = byId.get(claimId);
    if (claim === undefined) continue;
    for (const citation of claim.citations) out.add(citation.sourceId);
  }
  return out;
}

/** How well one expected question lines up with one emitted group. */
export interface MatchScore {
  /** Dice over cited source ids. Primary signal. */
  sourceScore: number;
  /** Dice over question content tokens. Tie-break only. */
  lexicalScore: number;
}

/** `> 0` when `a` is the better match, `< 0` when `b` is, `0` when they tie. */
function compareScores(a: MatchScore, b: MatchScore): number {
  if (a.sourceScore !== b.sourceScore) return a.sourceScore - b.sourceScore;
  return a.lexicalScore - b.lexicalScore;
}

function isMatch(score: MatchScore): boolean {
  return score.sourceScore > 0 || score.lexicalScore > 0;
}

/** The emitted group an expected question was matched to, flattened for reporting. */
export interface MatchedGroup {
  id: string;
  question: string;
  status: GroupStatus;
  /** Cited input documents, in manifest-independent sorted order. */
  citedSourceIds: string[];
  claimCount: number;
}

/** One expected question, and the group (if any) the run answers it with. */
export interface QuestionMatch {
  questionId: string;
  question: string;
  expectedStatus: GroupStatus;
  expectedSourceIds: string[];
  /** Absent when no group overlaps this question at all — the run never answers it. */
  group?: MatchedGroup;
  score: MatchScore;
  /** Expected sources the matched group does not cite. Reported, not asserted. */
  missingSourceIds: string[];
}

function toMatchedGroup(profile: ReconciledProfile, group: ClaimGroup): MatchedGroup {
  return {
    id: group.id,
    question: group.question,
    status: group.status,
    citedSourceIds: [...citedSourceIds(profile, group)].sort(),
    claimCount: group.claimIds.length,
  };
}

function scorePair(
  profile: ReconciledProfile,
  question: ExpectedQuestion,
  group: ClaimGroup,
): MatchScore {
  return {
    sourceScore: dice(new Set(question.sourceIds), citedSourceIds(profile, group)),
    lexicalScore: dice(questionTokens(question.question), questionTokens(group.question)),
  };
}

/**
 * Best group per expected question, **without** exclusivity: two questions may
 * match the same group, which is exactly what an over-merged run looks like.
 *
 * Use this for pass/fail assertions. Ties beyond both score components are broken
 * by group order in the profile, so the result is deterministic.
 */
export function matchQuestions(
  fixtureCase: FixtureCase,
  profile: ReconciledProfile,
): QuestionMatch[] {
  return fixtureCase.expect.questions.map((question) => {
    let best: { group: ClaimGroup; score: MatchScore } | undefined;
    for (const group of profile.groups) {
      const score = scorePair(profile, question, group);
      if (!isMatch(score)) continue;
      if (best === undefined || compareScores(score, best.score) > 0) {
        best = { group, score };
      }
    }

    if (best === undefined) {
      return {
        questionId: question.id,
        question: question.question,
        expectedStatus: question.status,
        expectedSourceIds: [...question.sourceIds],
        score: { sourceScore: 0, lexicalScore: 0 },
        missingSourceIds: [...question.sourceIds],
      };
    }

    const cited = citedSourceIds(profile, best.group);
    return {
      questionId: question.id,
      question: question.question,
      expectedStatus: question.status,
      expectedSourceIds: [...question.sourceIds],
      group: toMatchedGroup(profile, best.group),
      score: best.score,
      missingSourceIds: question.sourceIds.filter((id) => !cited.has(id)),
    };
  });
}

/** A question whose matched group disagrees with the manifest about status. */
export interface StatusMismatch {
  questionId: string;
  groupId: string;
  expected: GroupStatus;
  actual: GroupStatus;
}

/** A claim citing a document the manifest says must not reach the profile. */
export interface ExcludedCitation {
  claimId: string;
  sourceId: string;
  quote: string;
}

/**
 * The numeric verdict on one run. Everything here is an integer or a list of ids,
 * so it serialises cleanly as before/after evidence.
 */
export interface MergeQualityScore {
  caseId: string;
  /** Entries in `expect.questions`. */
  questionCount: number;
  /** Groups the run emitted. */
  groupCount: number;
  /** Questions paired one-to-one with a group of their own. */
  matchedCount: number;
  /**
   * Questions with no group of their own: the run fused them into a group another
   * question already claimed. **Reported, not asserted** — the manifests are
   * pitched finer than the prompt calibrates for.
   */
  overMerge: number;
  overMergedQuestionIds: string[];
  /**
   * Groups with no question of their own: the run split one question across
   * several groups, or emitted a group about something not in the answer key.
   * **Reported, not asserted.**
   */
  underMerge: number;
  underMergedGroupIds: string[];
  /** Questions the run does not answer at all. A real defect; assert on this. */
  unansweredQuestionIds: string[];
  /** Questions whose group carries the wrong status. A real defect; assert on this. */
  statusMismatches: StatusMismatch[];
  /** `expect.requiredSourceIds` that support no claim. A real defect. */
  missingRequiredSourceIds: string[];
  /** Claims citing `expect.excludedSourceIds`. A real defect. */
  excludedCitations: ExcludedCitation[];
  /** Groups the run marked disputed. */
  disputedGroupIds: string[];
}

/** Every source id cited by any claim in the profile. */
export function allCitedSourceIds(profile: ReconciledProfile): Set<string> {
  const out = new Set<string>();
  for (const claim of profile.claims) {
    for (const citation of claim.citations) out.add(citation.sourceId);
  }
  return out;
}

/** Claims citing any of `expect.excludedSourceIds`, in document order. */
export function excludedCitations(
  fixtureCase: FixtureCase,
  profile: ReconciledProfile,
): ExcludedCitation[] {
  const excluded = new Set(fixtureCase.expect.excludedSourceIds ?? []);
  if (excluded.size === 0) return [];
  const out: ExcludedCitation[] = [];
  for (const claim of profile.claims) {
    for (const citation of claim.citations) {
      if (excluded.has(citation.sourceId)) {
        out.push({ claimId: claim.id, sourceId: citation.sourceId, quote: citation.quote });
      }
    }
  }
  return out;
}

/**
 * Scores one run against its case manifest.
 *
 * The over/under-merge halves come from a greedy one-to-one assignment: every
 * (question, group) pair with any overlap is scored, the pairs are taken in
 * descending score order, and each question and each group is used at most once.
 * Greedy rather than optimal (Hungarian) on purpose — it is short, deterministic,
 * and the score is a comparison instrument between prompt versions, not an award.
 *
 * Note `groupCount - questionCount === underMerge - overMerge` always holds, so
 * this is a strict refinement of the naive count difference: it says *which*
 * questions were fused and *which* groups were spare.
 */
export function scoreMergeQuality(
  fixtureCase: FixtureCase,
  profile: ReconciledProfile,
): MergeQualityScore {
  const questions = fixtureCase.expect.questions;
  const groups = profile.groups;

  interface Pair {
    questionIndex: number;
    groupIndex: number;
    score: MatchScore;
  }

  const pairs: Pair[] = [];
  for (const [questionIndex, question] of questions.entries()) {
    for (const [groupIndex, group] of groups.entries()) {
      const score = scorePair(profile, question, group);
      if (isMatch(score)) pairs.push({ questionIndex, groupIndex, score });
    }
  }

  pairs.sort((a, b) => {
    const byScore = compareScores(b.score, a.score);
    if (byScore !== 0) return byScore;
    if (a.questionIndex !== b.questionIndex) return a.questionIndex - b.questionIndex;
    return a.groupIndex - b.groupIndex;
  });

  const takenQuestions = new Set<number>();
  const takenGroups = new Set<number>();
  for (const pair of pairs) {
    if (takenQuestions.has(pair.questionIndex) || takenGroups.has(pair.groupIndex)) continue;
    takenQuestions.add(pair.questionIndex);
    takenGroups.add(pair.groupIndex);
  }

  const overMergedQuestionIds = questions
    .filter((_, index) => !takenQuestions.has(index))
    .map((question) => question.id);
  const underMergedGroupIds = groups
    .filter((_, index) => !takenGroups.has(index))
    .map((group) => group.id);

  // Status and answered-at-all come from the loose match, so an over-merged run
  // is not double-punished: a fused group still answers each of its questions.
  const matches = matchQuestions(fixtureCase, profile);
  const unansweredQuestionIds = matches
    .filter((match) => match.group === undefined)
    .map((match) => match.questionId);
  const statusMismatches: StatusMismatch[] = matches.flatMap((match) =>
    match.group !== undefined && match.group.status !== match.expectedStatus
      ? [
          {
            questionId: match.questionId,
            groupId: match.group.id,
            expected: match.expectedStatus,
            actual: match.group.status,
          },
        ]
      : [],
  );

  const cited = allCitedSourceIds(profile);
  const missingRequiredSourceIds = (fixtureCase.expect.requiredSourceIds ?? []).filter(
    (id) => !cited.has(id),
  );

  return {
    caseId: fixtureCase.id,
    questionCount: questions.length,
    groupCount: groups.length,
    matchedCount: takenQuestions.size,
    overMerge: overMergedQuestionIds.length,
    overMergedQuestionIds,
    underMerge: underMergedGroupIds.length,
    underMergedGroupIds,
    unansweredQuestionIds,
    statusMismatches,
    missingRequiredSourceIds,
    excludedCitations: excludedCitations(fixtureCase, profile),
    disputedGroupIds: groups
      .filter((group) => group.status === "disputed")
      .map((group) => group.id),
  };
}

/** Human-readable score block, one line per number. Printed by the e2e suite. */
export function formatMergeQualityScore(score: MergeQualityScore): string[] {
  const list = (ids: readonly string[]): string => (ids.length === 0 ? "none" : ids.join(", "));
  return [
    `merge quality — ${score.caseId}`,
    `  questions in manifest : ${score.questionCount}`,
    `  groups emitted        : ${score.groupCount}`,
    `  matched one-to-one    : ${score.matchedCount}`,
    `  over-merge            : ${score.overMerge}  (${list(score.overMergedQuestionIds)})`,
    `  under-merge           : ${score.underMerge}  (${list(score.underMergedGroupIds)})`,
    `  disputed groups       : ${score.disputedGroupIds.length}  (${list(score.disputedGroupIds)})`,
    `  unanswered questions  : ${score.unansweredQuestionIds.length}  (${list(score.unansweredQuestionIds)})`,
    `  status mismatches     : ${score.statusMismatches.length}  (${list(
      score.statusMismatches.map(
        (mismatch) =>
          `${mismatch.questionId}: expected ${mismatch.expected}, got ${mismatch.actual}`,
      ),
    )})`,
    `  missing required srcs : ${score.missingRequiredSourceIds.length}  (${list(score.missingRequiredSourceIds)})`,
    `  excluded-source cites : ${score.excludedCitations.length}  (${list(
      score.excludedCitations.map((cite) => `${cite.claimId} → ${cite.sourceId}`),
    )})`,
  ];
}
