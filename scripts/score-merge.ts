/**
 * INTERIM merge-quality scorer for the prompt-iteration epic (#7).
 *
 * Epic #6 owns the real end-to-end harness and scoring; this script exists only
 * so #7 can record before/after evidence before #6 lands, and should be
 * superseded by it. It is deliberately a one-off: no test framework, no config,
 * one case and one run output per invocation.
 *
 *   usage: tsx scripts/score-merge.ts <case.json> <run-output.json>
 *
 * What it measures, against the case's `expect.questions` ground truth:
 *
 * - **Merge delta** — output group count minus expected question count.
 *   Positive means the run under-merged (split one question across groups),
 *   negative means it over-merged (collapsed distinct questions together).
 * - **Question recall** — each expected question is greedily matched to the
 *   most similar unused output group (word overlap on the question text plus
 *   Jaccard similarity of cited source ids). Matching is crude on purpose;
 *   borderline matches deserve a human eyeball, which is why the alignment is
 *   printed in full.
 * - **Status accuracy / disputed recall** — among matched pairs, whether the
 *   group's agreed/disputed status equals the expected one. Disputed recall is
 *   the headline number for the contradiction set: it catches the run that
 *   collapses a planted conflict into one agreed answer.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ClaimGroup,
  ExpectedQuestion,
  FixtureCase,
  ReconciledProfile,
} from "../src/contract.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "been",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
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
  "the",
  "their",
  "there",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits += 1;
  return hits / Math.min(a.size, b.size);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let hits = 0;
  for (const x of a) if (b.has(x)) hits += 1;
  return hits / (a.size + b.size - hits);
}

function main(): number {
  const [casePathArg, runPathArg] = process.argv.slice(2);
  if (!casePathArg || !runPathArg) {
    console.error("usage: tsx scripts/score-merge.ts <case.json> <run-output.json>");
    return 2;
  }
  const casePath = resolve(casePathArg);
  const fixture = JSON.parse(readFileSync(casePath, "utf8")) as FixtureCase;
  const run = JSON.parse(readFileSync(resolve(runPathArg), "utf8")) as ReconciledProfile;

  const expected = fixture.expect.questions;
  const groups = run.groups;
  const claimSources = new Map<string, Set<string>>();
  for (const claim of run.claims) {
    claimSources.set(claim.id, new Set(claim.citations.map((c) => c.sourceId)));
  }
  const groupSources = (g: ClaimGroup): Set<string> => {
    const ids = new Set<string>();
    for (const claimId of g.claimIds) for (const s of claimSources.get(claimId) ?? []) ids.add(s);
    return ids;
  };

  // Greedy alignment: repeatedly take the highest-scoring (question, group)
  // pair among the unmatched, until nothing scores above a floor.
  type Pair = { q: ExpectedQuestion; g: ClaimGroup; score: number };
  const pairs: Pair[] = [];
  for (const q of expected) {
    const qWords = words(q.question);
    const qSources = new Set(q.sourceIds);
    for (const g of groups) {
      const score = overlap(qWords, words(g.question)) + jaccard(qSources, groupSources(g));
      pairs.push({ q, g, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const matchedQ = new Map<string, Pair>();
  const usedG = new Set<string>();
  for (const p of pairs) {
    if (p.score < 0.3) break; // floor: below this it is noise, not a match
    if (matchedQ.has(p.q.id) || usedG.has(p.g.id)) continue;
    matchedQ.set(p.q.id, p);
    usedG.add(p.g.id);
  }

  const mergeDelta = groups.length - expected.length;
  const statusHits = [...matchedQ.values()].filter((p) => p.g.status === p.q.status).length;
  const expectedDisputed = expected.filter((q) => q.status === "disputed");
  const disputedHits = expectedDisputed.filter(
    (q) => matchedQ.get(q.id)?.g.status === "disputed",
  ).length;

  console.log(`case: ${fixture.id}   run: ${resolve(runPathArg)}`);
  console.log(`model: ${run.model ?? "(unrecorded)"}`);
  console.log("");
  console.log(
    `groups: ${groups.length} (expected ${expected.length})  merge delta: ${mergeDelta >= 0 ? "+" : ""}${mergeDelta} (${mergeDelta > 0 ? "under-merged" : mergeDelta < 0 ? "over-merged" : "exact"})`,
  );
  console.log(`question recall: ${matchedQ.size}/${expected.length}`);
  console.log(`status accuracy (of matched): ${statusHits}/${matchedQ.size}`);
  console.log(`disputed recall: ${disputedHits}/${expectedDisputed.length}`);
  console.log("");
  console.log("alignment (expected question -> matched group):");
  for (const q of expected) {
    const p = matchedQ.get(q.id);
    if (!p) {
      console.log(`  MISS  ${q.id} [${q.status}] -> (no group matched)`);
      continue;
    }
    const ok = p.g.status === q.status ? "ok   " : "WRONG";
    console.log(
      `  ${ok} ${q.id} [${q.status}] -> ${p.g.id} [${p.g.status}] "${p.g.question}" (score ${p.score.toFixed(2)})`,
    );
  }
  const extras = groups.filter((g) => !usedG.has(g.id));
  console.log(`unmatched groups (${extras.length}):`);
  for (const g of extras) {
    console.log(
      `  EXTRA ${g.id} [${g.status}] "${g.question}" sources={${[...groupSources(g)].join(", ")}}`,
    );
  }
  return 0;
}

process.exitCode = main();
