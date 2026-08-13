# Prompt iteration: v1 → v2 before/after evidence (Epic 7)

Before/after comparison of the two frozen reconciliation prompts on the Set B
contradiction fixture (`examples/set-b-contradiction.case.json`).

**The result is negative: v2 is not an improvement over v1.** An earlier version
of this document claimed "question recall 7–8/10 → 10/10". That claim was an
artefact of a scorer that has since been deleted, it is withdrawn in full below,
and re-scoring with Epic 6's instrument shows no improvement on any metric that
survives the granularity objection — and one new defect in v2 that is worse than
anything v1 does. `DEFAULT_PROMPT_VERSION` therefore stays `v1`.

- **Prompt v1** — `prompts/reconcile.v1.md` (frozen baseline from #3, unmodified)
- **Prompt v2** — `prompts/reconcile.v2.md` (new file; v1 is not touched)
- **Scorer** — `src/score.ts` from Epic 6 / #25, called unchanged. **This PR must
  land after #25.**
- **Ground truth** — the case's `expect.questions`: 10 questions, exactly 2
  disputed (founding date, membership count).
- **Reproduce every number below** with `npm run score:evidence` — offline, no API
  key. Its output is committed verbatim as
  `docs/evidence/prompt-iteration/set-b.scores.txt`.

## Read this first: where the numbers come from

Every number in this document is computed from a **committed JSON profile**. No
live model call was made while producing this document, and the machine it was
written on has no API key. The four run profiles under
`docs/evidence/prompt-iteration/` are attributed to `minimax-m3` under
`PROMPT_VERSION=v1|v2` and were committed by the original author of this branch;
their provenance is discussed at the end and is **not fully verifiable from the
repository**. Treat them as the best available evidence, not as certified
recordings.

One row of the table is **not model output at all**:

> **`test/fixtures/harness/set-b-contradiction.response.json` is hand-authored.**
> Epic 6's own PR (#25) states this explicitly: "The cached responses are
> hand-authored, not recorded... they are *my* idea of a correct run, so the 0/0
> scores measure the harness, **not the v1 prompt**." It is listed below only to
> show what a clean sheet looks like on this instrument. **It is not a v1
> measurement and must never be quoted as one.**

## Scores (Epic 6's scorer, `src/score.ts`)

| Run | Groups (exp. 10) | Over-merge | Under-merge | Unanswered | Status mismatches | Disputed groups | Claims in >1 group | Validator |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1 run 1 | 7 | 3 | 0 | 0 | 1 | **2/2** | 0 | ok |
| v1 run 2 | 8 | 2 | 0 | 0 | 1 | **2/2** | 0 | **FAILS** |
| v1 run 3 | 7 | 3 | 0 | 0 | 1 | **2/2** | 0 | ok |
| v2 run 1 | 13 | 0 | 3 | 0 | 0 | **2/2** | **5** | ok (2 warnings) |
| _hand-authored cache_ | _10_ | _0_ | _0_ | _0_ | _0_ | _2/2_ | _0_ | _ok_ |

`over-merge` and `under-merge` come from a one-to-one assignment between expected
questions and emitted groups, so `groups − questions === underMerge − overMerge`
holds throughout. `unanswered` and `status mismatches` come from a loose,
non-exclusive match, so a fused group still counts as answering each of its
questions and an over-merged run is not punished twice.

### What the two robust metrics say

**Dispute recall: 2/2 for v1 in all three runs, and 2/2 for v2.** Both planted
contradictions surface as their own `disputed` group, holding all three rival
answers, in every run of both versions. These are the matches worth trusting:
they align at source-set score 1.00 and the group text is unambiguously about the
founding date and the membership count, so they can be checked by eye in the
transcript. **On the metric immune to the granularity objection, v1 and v2 are
indistinguishable.**

**Granularity: v1 over-merges by 2–3, v2 under-merges by 3.** The sign flips and
the magnitude does not. That is a trade between two failure directions, not an
improvement, and the fixture explicitly declines to treat it as a verdict
(`examples/set-b-contradiction.case.json`: "group count is a signal rather than a
verdict, since these questions are pitched finer than `prompts/reconcile.v1.md`
calibrates for").

## Withdrawn claim: "question recall 7–8/10 → 10/10"

The previous deliverable's headline was that v2 recovered three questions v1
missed (`q-patterns`, `q-premises`, `q-founders`). It does not, and the number was
never measuring what it appeared to.

1. **The old matcher was injective.** The deleted `scripts/score-merge.ts` marked
   each group used once, so `question recall ≤ group count` by construction. All
   three v1 runs scored recall *exactly equal* to their group count with **zero**
   unmatched groups. "7–8/10 → 10/10" was a restatement of "v2 emitted 13 groups
   instead of 7–8".
2. **The matches counted as hits were wrong.** In the old v2 transcript
   `q-location` and `q-product` were matched to each other's groups, `q-premises`
   to a "product range changed" group, and `q-founders` to an award group. Two of
   the three "recovered" questions were recovered onto groups about something
   else.
3. **Under a non-exclusive match, nothing was ever missing.** Epic 6's scorer
   reports `unanswered questions: 0` for every run of both versions.

Point 3 is *not* the fixed version of the claim. It is the mirror-image artefact:
because six of Set B's ten questions are answered by all five documents, almost
every question overlaps almost every group on source sets, so `unanswered` is
near-impossible to fail here. The old scorer's cap and the new scorer's floor are
both reasons this fixture cannot support a coverage claim at all. **There is no
coverage improvement to report, and no metric on this fixture that could
honestly show one.** The transcript prints every match with its scores so a
reader can see this for themselves rather than take it on trust.

## Diagnosis (v1) — what the evidence does support

v1 handles both planted conflicts correctly in every run: the three incompatible
founding answers ("founded in 1998" / "incorporated in the spring of 1997" /
"began trading in 1999") land in one `disputed` group, and the membership group
holds the 150-vs-200 conflict without collapsing to the majority.

Its real, checkable defect is **status contamination through over-merging**, and
it is visible at the claim level rather than the group level. In runs 1 and 3, the
single claim `c1` states both the disputed founding date *and* the undisputed
founders fact:

```json
{
  "id": "c1",
  "text": "Halberd Mills Cooperative was founded in 1998 by a group of hand-weavers in Cawden Vale.",
  "citations": [{ "sourceId": "set-b-01", "quote": "…" }]
}
```

`c1` sits in the `disputed` founding group, so *who founded the cooperative* is
rendered to a reader as disputed. It is not — the fixture says so directly:
"who founded it is not in dispute, only when". The same runs fold the premises
fact ("in a converted grain store in Cawden Vale") into claim `c3` in that same
disputed group. This is what the single `status mismatch` per v1 run detects, and
it under-counts: the metric flags `q-founders` but the premises contamination
rides along unflagged.

## Hypothesis (as it was framed)

v1's instructions emphasise atomicity and dispute handling but say nothing about
coverage or granularity, so the model folds minor single-source facts into
neighbouring groups. v2 is v1 plus (a) an exhaustive-coverage rule and (b) a
one-narrow-question-per-group rule, with "prefer two small groups over one broad
group" and "who founded it is a different question from when it was founded".
Nothing else changed.

## Result — the hypothesis is not supported, and v2 regresses

v2 does split more finely: 13 groups, `q-founders` and `q-premises` no longer
over-merged, over-merge 0. But the split was bought in a way that breaks a rule
both prompts state, and the cost lands exactly where this project cannot afford
it.

**v2 puts the same claim in two groups, one disputed and one agreed.** Both
`prompts/reconcile.v1.md:15` and `prompts/reconcile.v2.md:17` say "Every claim
belongs to exactly one group". v2's run violates this for five claims, and three
of them are the planted contradiction:

```text
claims in >1 group : 5  (c1 in g1/disputed + g2/agreed,
                         c2 in g1/disputed + g2/agreed,
                         c3 in g1/disputed + g2/agreed,
                         c10 in g3/agreed + g4/agreed,
                         c17 in g7/agreed + g8/agreed)
```

`c1`/`c2`/`c3` are the 1998 / 1997 / 1999 founding claims. They are in the
`disputed` group `g1` **and** in `g2`, "Where did Halberd Mills Cooperative begin
or remain located?", which v2 marks **`agreed`**. So v2's profile presents the
central planted contradiction as agreed *as well as* disputed. Collapsing a
planted conflict into an agreed answer is the failure the fixture exists to catch
— "over-merging or majority-voting collapses a disputed group into a single
agreed claim... they are wrong about whether the sources conflict, which is what
this project claims to get right". v2 does not collapse the disputed group, but it
publishes an agreed one alongside it, which misleads a reader in the same
direction.

Two further v2 defects, both from the same splitting pressure:

- **Two claims belong to no group at all** (`c12`, `c25`), so they never appear in
  the rendered profile. The validator reports these as `CLAIM_NOT_GROUPED`
  warnings.
- The first v2 attempt was rejected by the schema gate (a group with empty
  `claimIds`) and succeeded on the automatic retry.

Note that **no existing check catches the duplication.**
`schema/claims.schema.json` does not require `groups` to partition `claims`, and
`validateOutput` reports only the opposite defect (`CLAIM_NOT_GROUPED`). The
count in the table is computed by `scripts/score-evidence.ts` precisely because
nothing else was measuring it. Making it an error belongs to the validator (#4),
not to this epic — filed as a follow-up below.

### And the v1 baseline is two runs, not three

`set-b.v1.run2.json` **fails the deterministic validator**:

```text
error  QUOTE_NOT_VERBATIM  /claims/7/citations/0/quote  claim c8 quotes
"halberd Mills Cooperative was founded in 1998 by a group of …", which is not a
verbatim substring of set-b-01 (differs only in letter case)
```

Since #13, validation is a mandatory step in `reconcile`, so this run would exit
non-zero today: it is evidence, not a result. The old scorer never ran the
validator, which is why this went unnoticed — and run 2 is the run that supplied
the old document's "8/10" upper figure. The usable v1 baseline is runs 1 and 3,
both of which emit 7 groups.

## Conclusion

- **No measured improvement.** Dispute recall is 2/2 for both versions; coverage
  is unmeasurable on this fixture in either direction; granularity trades
  over-merge for under-merge at equal magnitude.
- **v2 is worse on the thing that matters.** It duplicates the planted
  contradiction into an `agreed` group and drops two claims out of the rendered
  profile. v1 does neither.
- **`DEFAULT_PROMPT_VERSION` stays `v1`** — now for a substantive reason rather
  than for want of samples.
- **This comparison cannot be settled offline.** v2 has exactly one recorded run,
  and the one difference that looked like a v2 win (status mismatches 1 → 0) is
  entangled with the duplication defect rather than independent of it.
  Distinguishing the two prompts needs repeated live runs — several per version,
  scored with `npm run score:evidence` — which needs an `OPENCODE_API_KEY` that is
  not available on this machine. That is the honest next step, and it is a
  prerequisite for any claim that one prompt is better than the other.

## Provenance of the four run profiles

Worth stating plainly, since the whole deliverable rests on it and the task of
checking it turned up something worth recording.

**Consistent with genuine recorded output:**

- The three v1 runs differ substantially in claim decomposition, citation
  bundling, phrasing, and group count (7 / 8 / 7) — the kind of variance
  resampling produces and that is laborious to fabricate three times over.
- All three carry `"generatedAt": "2026-08-13T12:00:00Z"`, identical and
  suspiciously round. This initially looked like a fabrication marker, but
  `prompts/reconcile.v1.md:24` offers *exactly* that string as its worked example
  of the field. A model with no clock copying the example from its own system
  prompt is the natural explanation, and it is the same in all three runs because
  the instruction is. By contrast the hand-authored harness cache carries
  plausible non-round times (`09:14:22Z`, `09:21:07Z`, `09:28:41Z`) — a human
  author avoiding the placeholder. The naive reading of that signal is backwards.
- `model: "minimax-m3"` is stamped by the engine from `getModel()`, so these went
  through the real pipeline, and run 2's case-mangled quote is a characteristic
  model error rather than something an author would plant.

**Not verifiable:**

- Nothing in the repository can prove a network call happened. A hand-authored
  response replayed through the engine would also be schema-valid and would also
  get `model` stamped, which is exactly the harness cache's situation.
- The deleted transcripts recorded an absolute path from the author's machine
  (`/mnt/c/users/takuf/.../worktrees/…`), which places the runs in a real working
  session but says nothing about the gateway.

**Position taken here:** the four profiles are kept as the baseline and labelled
as *attributed*, not certified. Re-recording them with a key — and recording more
than one v2 sample — is the first item below.

## Follow-ups

- **Re-record with a live key**, several runs per version, and re-score with
  `npm run score:evidence`. Until then no better/worse verdict is available.
- **Make claim duplication an error in the validator (#4)**: a claim in two
  groups is unenforced today, and when the two groups disagree about status it
  renders one fact as both agreed and disputed. This is the highest-value fix the
  epic turned up.
- **A v3** should keep v2's coverage intent but drop "prefer two small groups over
  one broad group", which is what produced both the duplication and the ungrouped
  claims. "One group per fact, not per aspect of a fact" — plus an explicit
  restatement that a claim appears in exactly one group — is the direction the
  evidence points.
