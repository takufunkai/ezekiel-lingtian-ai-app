# Prompt iteration: v1 → v2 before/after evidence (Epic 7)

Live before/after comparison of the two frozen reconciliation prompts on the
Set B contradiction fixture (`examples/set-b-contradiction.case.json`), scored
with the interim scorer `scripts/score-merge.ts` (a stopgap until the real
harness from #6 lands). Raw model outputs and score transcripts are committed
under `docs/evidence/prompt-iteration/`.

- **Prompt v1** — `prompts/reconcile.v1.md` (frozen baseline from #3)
- **Prompt v2** — `prompts/reconcile.v2.md` (new file; v1 is not modified)
- **Model** — `minimax-m3` via the OpenCode gateway (`LLM_MODEL` env), engine
  pipeline identical for both versions; the prompt is selected per run with
  `PROMPT_VERSION=v1|v2`.
- **Ground truth** — the case's `expect.questions`: 10 questions, exactly 2
  disputed (founding date, membership count).

## Scores

| Run | Groups (exp. 10) | Merge delta | Question recall | Status accuracy | Disputed recall |
| --- | --- | --- | --- | --- | --- |
| v1 run 1 | 7 | **−3 (over-merged)** | 7/10 | 7/7 | 2/2 |
| v1 run 2 | 8 | **−2 (over-merged)** | 8/10 | 8/8 | 2/2 |
| v1 run 3 | 7 | **−3 (over-merged)** | 7/10 | 7/7 | 2/2 |
| v2 run 1 | 13 | **+3 (under-merged)** | **10/10** | 10/10 | 2/2 |

(Merge delta = output groups − expected questions; negative means questions
were collapsed or dropped, positive means questions were split.)

Run-to-run variance under v1 was small (7–8 groups, same three questions
missed in two of three runs, `q-founders` recovered once). Only one v2 run was
recorded before the evidence cut-off, so v2's variance is not yet
characterised — treat its numbers as a single sample.

## Diagnosis (v1)

Both planted conflicts were handled correctly in every v1 run: the three
incompatible founding answers ("founded in 1998" / "incorporated in the spring
of 1997" / "began trading in 1999") landed in one `disputed` group, and the
membership group held the 150-vs-200 conflict without collapsing to the
majority. Sample from `set-b.v1.run1.json`:

```json
{
  "id": "g1",
  "question": "When was Halberd Mills Cooperative founded or established?",
  "status": "disputed",
  "claimIds": ["c1", "c2", "c3"]
}
```

The dominant failure mode was **over-merging / dropped coverage of peripheral
facts**: every v1 run produced only 7–8 groups against 10 expected, and the
same expected questions went missing — `q-patterns` (blanket patterns),
`q-premises` (the converted grain store), and usually `q-founders` (who founded
it). Their facts were either never extracted as claims or folded into
neighbouring broader groups (patterns into the product group, premises into
the expansion group, founders into the founding-date group).

## Hypothesis

v1's instructions emphasise atomicity and dispute handling but say nothing
about coverage or group granularity, so the model treats minor single-source
facts as not worth a claim/group of their own. Adding (a) an explicit
exhaustive-coverage rule ("a fact stated by only one document is still a
claim; re-read each document for facts not yet covered") and (b) a
one-narrow-question-per-group rule with concrete examples ("who founded it is
a different question from when it was founded"; "prefer two small groups over
one broad group") should recover the missing questions without disturbing the
already-correct dispute behaviour.

v2 (`prompts/reconcile.v2.md`) is v1 with exactly those additions, plus an
explicit "silence is not disagreement / elaboration is agreement" line in
step 3. Nothing else was changed.

## Result

The hypothesis was half right — and the honest half-miss is part of the
evidence:

- **Coverage fixed.** v2 recovered all three missing questions: 10/10 expected
  questions matched (v1: 7–8/10), including patterns, premises, and founders.
- **Disputes still correct.** 2/2 disputed recall, 10/10 status accuracy —
  the granularity push did not cause any planted conflict to split or resolve.
- **But the merge delta flipped sign.** v2 produced 13 groups (+3,
  under-merged): "prefer two small groups over one broad group" made the model
  split single-source facts into aspect-per-group, e.g. the dyehouse expansion
  became "what new facility did it open?" *and* "why did it open a second
  dyehouse?", and the award question spawned satellite groups for its
  historical significance and its presence in filings.

```text
EXTRA g9  [agreed] "What new facility did Halberd Mills Cooperative open?"        sources={set-b-04}
EXTRA g10 [agreed] "Why did Halberd Mills Cooperative open a second dyehouse?"    sources={set-b-04}
EXTRA g13 [agreed] "Is the Fenmoor design award recorded in Halberd Mills Cooperative's filings?" sources={set-b-02}
```

Net assessment: v2 is an improvement on the metrics that matter most to this
project — nothing the sources state is silently dropped (question recall
7–8/10 → 10/10) and no conflict is collapsed — at the cost of over-splitting
peripheral facts, which is the *safer* failure direction (a split fact is
still visible and cited; a dropped one is gone). The absolute merge delta is
roughly unchanged (≈3), so on raw group count v2 is *not* better, only
different; the improvement is in recall and coverage.

One operational note: the v2 run's first attempt was rejected by the schema
gate (a group with empty `claimIds` — likely a side effect of pushing for more
groups) and succeeded on the automatic retry. Worth watching in #6's harness.

`DEFAULT_PROMPT_VERSION` remains `v1` for now: one v2 run is too thin a base to
change the default, and the under-merge cost is real. Re-evaluate once #6's
harness can run both versions repeatedly.

## TODO (post-demo)

- More v2 runs to characterise variance (only one recorded here).
- A v3 could keep v2's coverage rules but soften "prefer two small groups",
  e.g. "one group per fact, not per aspect of a fact".
- Replace `scripts/score-merge.ts` with #6's real scorer and re-record.
