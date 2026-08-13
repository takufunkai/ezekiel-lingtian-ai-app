# Project report — Cited Profile Reconciler

Given several source documents about one entity, produce a **cited profile** that separates what the sources agree on from what they dispute. Contradictions get their own **Disputed** section instead of being silently smoothed over, and every claim carries a citation back to the verbatim span that supports it.

**Why an LLM is genuinely required:** deciding that "founded in 2011", "began operations in early 2012", and "incorporated December 2010" are three answers to _one_ question, and that they conflict, is semantic grouping. No regex, template, or string match does that. The LLM does exactly that one job; everything around it is deterministic code.

This report states only what exists. The whole pipeline described below — contract, engine, fixture corpus, deterministic validator, renderer, model configuration — is merged to `master`; two things are not, and both are named where they matter rather than sprinkled through the text as markers. **No test result, scenario outcome or score is claimed anywhere in this report**, because none has been produced: there is no API key on the machine these epics were built on, so no reconciliation run has ever been made against a live gateway.

## Architecture overview

```
fixture case ──▶ reconcile (LLM) ──▶ validate (code) ──▶ render (code) ──▶ profile.html
   master           master              master              master
```

| Module                             | Role                                                                                           | Status         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | -------------- |
| `schema/*.schema.json`             | Source of truth for the contract; TS mirrors in `src/contract.ts` kept in sync by test         | master         |
| `src/engine.ts`, `src/cli.ts`      | `npm run reconcile -- <case.json> --out <out.json>`: prompt → model → ajv check → reject/retry | master         |
| `prompts/reconcile.v1.md`          | The versioned, frozen system prompt; iteration adds v2 rather than editing v1                  | master         |
| `src/client.ts`                    | The only module that builds a model client (OpenCode gateway, Anthropic SDK as transport)      | master         |
| `examples/set-{a,b,c}-*.case.json` | The three-scenario fixture corpus: 15 hand-authored documents + answer-key manifests           | master         |
| `src/validate.ts`                  | Deterministic validator: `validateOutput(profile, sources)` → violations with codes + pointers | master         |
| `src/render.ts`                    | Deterministic renderer: profile JSON → one self-contained HTML page                            | master         |
| `src/harness.ts`, `src/score.ts`   | Record/replay end-to-end suite and merge-quality scoring for the three cases                   | open ([PR #25](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/25)) |
| `docs/prompt-iteration.md`         | v1 → v2 before/after evidence on Set B                                                         | open ([PR #20](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/20)) |

The reconcile step is not just "model then write". After a response passes the compiled `claims.schema.json` validator, `src/cli.ts` runs `validateOutput` against the documents the run was actually given, as a mandatory step: schema-valid output that cites a source it was never handed, or quotes a span that appears nowhere in it, still exits non-zero. The failing profile is written anyway, deliberately, because it is the evidence prompt iteration works from — the exit code is what says it is not a result.

CI (`.github/workflows/ci.yml`) runs typecheck + formatting, the full test suite, and validates every committed example against the schemas on each push and PR.

## Input boundary

The input is a **fixture case**: a JSON file naming the entity and 4–6 source documents (`id`, `date`, `title`, `text`, optional `notes`), plus an `expect` block — the answer key. There is no live fetching; the idea doc calls unbounded retrieval out as the thing that kills reproducibility, so the boundary is the committed corpus. (A live-fetch path behind a flag is the issue's optional stretch — not built.)

**Answer-key isolation is structural, not disciplinary.** Prompt construction accepts only `ModelSourceDocument`, produced by `toModelInput()` in `src/contract.ts`, which copies exactly `id`, `date`, `title`, `text` field by field. Author `notes` and the case's `expect` key are unreachable from the prompt path — a field added to `SourceDocument` later has to be added to `toModelInput` explicitly to ever reach the model.

## Output contract

One reconciliation run emits one JSON document that must satisfy `schema/claims.schema.json`:

- **Every claim carries ≥ 1 citation**, each pairing a `sourceId` with the **verbatim** quote supporting it. This is what makes deterministic checking possible downstream.
- **A `disputed` group holds ≥ 2 claims** — enforced by the schema itself. Conflicting answers sit side by side; nothing averages or resolves them.
- **`additionalProperties: false` throughout** — an invented field is a validation failure, not a quietly ignored extra.

The same document is the input to both the validator and the renderer; nothing downstream of the model call re-interprets the sources.

## The three techniques

| Technique                              | Rubric category              | Evidence                                       |
| -------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Structured output (strict JSON schema) | Controls LLM use             | Violations rejected and retried, never patched |
| Code validation of model output        | Tests / constrains the model | Deterministic validator + seeded-failure tests |
| Source citations                       | Tests / constrains the model | Every claim traceable; verbatim-quote check    |

### 1. Structured output — controls LLM use

The engine validates every model response against the compiled ajv validator for `claims.schema.json`. A schema-invalid response is **rejected and retried** (bounded at 3 attempts, identical request each time), never repaired; if every attempt fails, the run logs each rejection reason and exits non-zero, writing nothing. Evidence on master: `src/engine.ts`, exercised offline with canned responses in `test/engine.test.ts` (the model call is injected, so the reject/retry/give-up paths are unit-tested without a network).

### 2. Code validation of model output — tests/constrains the model

`validateOutput(profile, sources)` in `src/validate.ts` is plain code — substring tests, set lookups, id resolution; no LLM anywhere. Every cited source id must exist in the input set; every quote must be an exact substring of its source (no whitespace collapsing, no case folding); uncited claims, unresolvable ids, invented manifest entries, and under-sourced disputes are each reported with a specific violation code and an RFC 6901 JSON Pointer. The seeded-failure tests in `test/validate.test.ts` plant each defect — fabricated source id, altered quote, uncited claim, and more, each with its own committed bad profile under `test/fixtures/validator/` — and assert the exact code fires. It is reachable two ways: standalone via `npm run validate:output -- <profile.json> <sources…>` (`--json`, `--strict`; exit 0/1/2 so CI can tell "wrong" from "could not run"), and as the mandatory final step of `reconcile`.

### 3. Source citations — tests/constrains the model

Citations are load-bearing at every layer: the schema requires ≥ 1 per claim; the prompt requires verbatim spans; the validator fails any quote that is not an exact substring and any id that resolves to nothing; the renderer displays each claim's `[S1]`-style markers linking to the source list, so traceability is on screen, not just in the JSON.

## The three test scenarios

The corpus on `master` commits three cases, each with an answer-key manifest (`expect`) listing the underlying questions the sources answer, the status each should carry, and which documents must or must not reach the profile. What each proves:

- **Set A — agreement** (Thornwood Seed Library). All five sources corroborate; the manifest lists 12 questions, all `agreed`. The deliberate trap is the _false positive_: the collection size and founding year are each worded five compatible ways. Marking paraphrase as dispute fails. Proves the app doesn't manufacture conflict.
- **Set B — planted contradiction** (Halberd Mills Cooperative). Two real conflicts: a three-way founding date ("founded in 1998" / "incorporated in the spring of 1997" / "began trading in 1999") sharing no matchable phrase, and a 2-to-1 membership split where the minority answer must survive. The manifest lists 10 questions, of which `q-founding` and `q-membership` are `disputed`. Proves conflicts are detected and surfaced, not averaged, picked, or allowed to poison the agreed questions. This is the set prompt iteration should be scored on, because both failure directions are observable in it: under-merging splits the three founding-date answers apart, over-merging or majority-voting collapses a disputed group into one agreed claim.
- **Set C — poisoned input** (Marrow Lane Press). Four genuine sources plus a near-namesake impostor (_Marrowlane Press Ltd_, a commercial printer). The manifest lists 11 questions, all `agreed`, and names `set-c-05` in `excludedSourceIds`, which makes any claim citing the impostor a failure. Proves entity discipline: merging the impostor would fabricate a founding-date dispute (2009 vs 1986) that never existed.

### What the manifests assert, and what they merely measure

This distinction is load-bearing, and it changed during the project. The assertion is that **each listed question appears in the run's output with the status the manifest gives it**, plus the two source-level rules: every `requiredSourceIds` document supports some claim, and no `excludedSourceIds` document is cited by any claim. Those are pass/fail.

Group **count** is not a verdict. `expect.questions` is pitched finer than `prompts/reconcile.v1.md` calibrates for — the prompt says only to group claims that answer the same underlying question, so a run that answers Set B's premises together with its location, or Set C's three pamphlet-prize questions in one group, is behaving reasonably. Over-merge and under-merge are therefore **reported numbers**, not failures. An earlier draft of this report treated group-count deltas as the measuring stick; the answer keys were corrected to say otherwise and this section follows them, not the other way round.

The mechanism is implemented in `src/score.ts` on the open harness PR, and it is worth naming precisely because it is the instrument prompt iteration would compare v1 against v2 with:

- A question is matched to an emitted group by similarity, never by string equality — primarily the Dice coefficient over source-id sets (the manifest's `sourceIds` for the question against the ids actually cited by the group's claims), with a Dice coefficient over question content tokens as tie-break. Source sets come first because they are checkable facts on both sides; the group's `question` string is free-form model prose.
- Status assertions read a **loose** match, where several questions may land on the same group. A fused group still answers each of the questions inside it, so an over-merged run is not punished twice.
- Over/under-merge come from a separate **one-to-one** greedy assignment: questions left without a group of their own were over-merged; groups left without a question of their own were under-merged. `groupCount - questionCount === underMerge - overMerge` holds by construction, so this is a strict refinement of the naive count difference — it says *which* questions were fused and *which* groups were spare.
- Unanswered questions, status mismatches, missing required sources and excluded-source citations are the real defects and are asserted; the merge numbers are printed alongside them.

**No results.** The harness that runs the three cases offline is written but not merged, and it replays hand-authored cached responses, so even once merged it evidences the pipeline and the scorer rather than the model's behaviour on these documents. Live runs need a key, and none has been available here. The demo script (`docs/demo.md`) is the live sequence; it has not been executed end to end.

## Prompt iteration — no evidence yet

`prompts/reconcile.v1.md` is frozen on master as the baseline, and iteration adds `v2` rather than editing `v1`. Issue #7's deliverable is `docs/prompt-iteration.md`: v1's Set B behaviour recorded, the dominant failure mode diagnosed from real outputs, `prompts/reconcile.v2.md` written against that diagnosis, and both re-scored — with the diagnosis → hypothesis → result narrative. [PR #20](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/20) is open for it; that document is the before/after evidence and **none of its numbers are anticipated or quoted here**. Until it merges, this repository shows no before/after improvement evidence.

## Rubric checklist

| Requirement                                      | Where it is met                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| One clear use case                               | Several conflicting documents → one cited, dispute-aware profile                                                                             |
| One complete input-to-output path                | `case.json` → `reconcile` → `validate` → `render`, all on master                                                                              |
| One useful task for the LLM                      | Semantic claim grouping — beyond any fixed parsing                                                                                           |
| ≥ 3 course techniques, both mandatory categories | Table above: one controls LLM use, two test/constrain the model                                                                              |
| One shared repository                            | This repo; epics built on branches, reviewed via PRs, merged one at a time                                                                   |
| Tests or examples that show the result           | On master: contract, client, engine, validator (seeded-failure) and renderer suites, plus the three-case corpus. The end-to-end suite over those three cases is open in PR #25. |
| Before-and-after improvement evidence            | **Not met yet** — open in PR #20 as `docs/prompt-iteration.md`                                                                                |

## Known limits

- **No run has ever been made against a live gateway from this repository.** Every claim in this report is about committed code, schemas and fixtures, or about tests that run offline. There are no scenario outcomes, scores, or sample profiles produced by a model.
- Reconciliation needs a live key. Deterministic offline replay of the full pipeline is issue #6's deliverable, written but not merged (PR #25) — and even that replays hand-authored cached responses, so it exercises the pipeline and the scorer, not the model.
- The before-and-after prompt-iteration evidence the rubric asks for does not exist on `master` yet (PR #20).
- Group-count agreement with a case manifest is deliberately **not** a pass/fail criterion; see the scoring section above. A reader looking for a single headline accuracy number will not find one, and that is a considered choice rather than an omission.
- Fixtures are fictional entities by design (plantable contradictions, no defamation risk); no live-fetch input path exists.
