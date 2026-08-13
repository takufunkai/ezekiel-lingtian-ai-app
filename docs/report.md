# Project report — Cited Profile Reconciler

Given several source documents about one entity, produce a **cited profile** that separates what the sources agree on from what they dispute. Contradictions get their own **Disputed** section instead of being silently smoothed over, and every claim carries a citation back to the verbatim span that supports it.

**Why an LLM is genuinely required:** deciding that "founded in 2011", "began operations in early 2012", and "incorporated December 2010" are three answers to _one_ question, and that they conflict, is semantic grouping. No regex, template, or string match does that. The LLM does exactly that one job; everything around it is deterministic code.

This report states only what exists. Facts about `master` are stated as fact; work in an open PR is marked **[PR #n]**; work not yet started or still in flight is marked **TBD** with its issue number. No test results or scores are claimed that have not been produced.

## Architecture overview

```
fixture case ──▶ reconcile (LLM) ──▶ validate (code) ──▶ render (code) ──▶ profile.html
   [PR #11]         master              [PR #13]            [PR #15]
```

| Module                             | Role                                                                                           | Status                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| `schema/*.schema.json`             | Source of truth for the contract; TS mirrors in `src/contract.ts` kept in sync by test         | master                 |
| `src/engine.ts`, `src/cli.ts`      | `npm run reconcile -- <case.json> --out <out.json>`: prompt → model → ajv check → reject/retry | master                 |
| `prompts/reconcile.v1.md`          | The versioned, frozen system prompt; iteration adds v2 rather than editing v1                  | master                 |
| `src/client.ts`                    | The only module that builds a model client (OpenCode gateway, Anthropic SDK as transport)      | master (env: [PR #16]) |
| `examples/set-{a,b,c}-*.case.json` | The three-scenario fixture corpus: 15 hand-authored documents + answer-key manifests           | [PR #11]               |
| `src/validate.ts`                  | Deterministic validator: `validateOutput(profile, sources)` → violations with codes + pointers | [PR #13]               |
| `src/render.ts`                    | Deterministic renderer: profile JSON → one self-contained HTML page                            | [PR #15]               |
| E2E harness, offline record/replay | One command runs all three scenarios offline; emits the merge-quality score                    | TBD [#6]               |

CI (`.github/workflows/ci.yml`) runs typecheck + formatting, the full test suite, and validates every committed example against the schemas on each push and PR.

## Input boundary

The input is a **fixture case**: a JSON file naming the entity and 4–6 source documents (`id`, `date`, `title`, `text`, optional `notes`), plus an `expect` block — the answer key. There is no live fetching; the idea doc calls unbounded retrieval out as the thing that kills reproducibility, so the boundary is the committed corpus. (A live-fetch path behind a flag is the issue's optional stretch — not built.)

**Answer-key isolation is structural, not disciplinary.** Prompt construction accepts only `ModelSourceDocument`, produced by `toModelInput()` in `src/contract.ts`, which copies exactly `id`, `date`, `title`, `text` field by field. Author `notes` and the case's `expect` key are unreachable from the prompt path — a field added to `SourceDocument` later has to be added to `toModelInput` explicitly to ever reach the model.

## Output contract

One reconciliation run emits one JSON document that must satisfy `schema/claims.schema.json`:

- **Every claim carries ≥ 1 citation**, each pairing a `sourceId` with the **verbatim** quote supporting it. This is what makes deterministic checking possible downstream.
- **A `disputed` group holds ≥ 2 claims** — enforced by the schema itself. Conflicting answers sit side by side; nothing averages or resolves them.
- **`additionalProperties: false` throughout** — an invented field is a validation failure, not a quietly ignored extra.

The same document is the input to both the validator [PR #13] and the renderer [PR #15]; nothing downstream of the model call re-interprets the sources.

## The three techniques

| Technique                              | Rubric category              | Evidence                                       |
| -------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Structured output (strict JSON schema) | Controls LLM use             | Violations rejected and retried, never patched |
| Code validation of model output        | Tests / constrains the model | Deterministic validator + seeded-failure tests |
| Source citations                       | Tests / constrains the model | Every claim traceable; verbatim-quote check    |

### 1. Structured output — controls LLM use

The engine validates every model response against the compiled ajv validator for `claims.schema.json`. A schema-invalid response is **rejected and retried** (bounded at 3 attempts, identical request each time), never repaired; if every attempt fails, the run logs each rejection reason and exits non-zero, writing nothing. Evidence on master: `src/engine.ts`, exercised offline with canned responses in `test/engine.test.ts` (the model call is injected, so the reject/retry/give-up paths are unit-tested without a network).

### 2. Code validation of model output — tests/constrains the model

`validateOutput(profile, sources)` **[PR #13]** is plain code — substring tests, set lookups, id resolution; no LLM anywhere. Every cited source id must exist in the input set; every quote must be an exact substring of its source (no whitespace collapsing, no case folding); uncited claims, unresolvable ids, invented manifest entries, and under-sourced disputes are each reported with a specific violation code and an RFC 6901 JSON Pointer. The seeded-failure tests plant each defect — fabricated source id, altered quote, uncited claim, and more — and assert the exact code fires. On that branch the validator is also wired into `reconcile` as a mandatory step: schema-valid output that fails validation still exits non-zero.

### 3. Source citations — tests/constrains the model

Citations are load-bearing at every layer: the schema requires ≥ 1 per claim; the prompt requires verbatim spans; the validator **[PR #13]** fails any quote that is not an exact substring and any id that resolves to nothing; the renderer **[PR #15]** displays each claim's `[S1]`-style markers linking to the source list, so traceability is on screen, not just in the JSON.

## The three test scenarios

The corpus **[PR #11]** commits three cases, each with an answer-key manifest (`expect`) that the E2E harness **[#6]** will assert against. What each proves:

- **Set A — agreement** (Thornwood Seed Library). All five sources corroborate; expected: 12 agreed questions, zero disputed. The deliberate trap is the _false positive_: the collection size and founding year are each worded five compatible ways. Marking paraphrase as dispute, or splitting one question into several groups, fails. Proves the app doesn't manufacture conflict.
- **Set B — planted contradiction** (Halberd Mills Cooperative). Two real conflicts: a three-way founding date ("founded in 1998" / "incorporated in the spring of 1997" / "began trading in 1999") sharing no matchable phrase, and a 2-to-1 membership split where the minority answer must survive. Expected: exactly those two groups disputed, eight agreed. Proves conflicts are detected and surfaced, not averaged, picked, or allowed to poison the agreed questions. Group-count deltas vs the manifest give the numeric over/under-merge score **[#6]** that #7 uses as its measuring stick.
- **Set C — poisoned input** (Marrow Lane Press). Four genuine sources plus a near-namesake impostor (_Marrowlane Press Ltd_, a commercial printer). Expected: all groups agreed, and `excludedSourceIds` makes any claim citing the impostor a failure. Proves entity discipline: merging the impostor would fabricate a founding-date dispute (2009 vs 1986) that never existed.

**Results: TBD [#6].** The harness that runs all three offline (cached responses, `--live` to re-record) and emits the merge-quality score is not started; no scenario outcomes are claimed here. The demo script (`docs/demo.md`) runs the same three scenarios live today.

## Prompt iteration — TBD [#7]

`prompts/reconcile.v1.md` is frozen on master as the baseline. Issue #7 (in flight, in parallel with this document) will record v1's Set B score, diagnose the dominant failure mode from real outputs, write `prompts/reconcile.v2.md`, and re-score — delivering `docs/prompt-iteration.md` with both prompts, before/after numbers, and the diagnosis → hypothesis → result narrative. That document is the before/after evidence; none of its results are anticipated here.

## Rubric checklist

| Requirement                                      | Where it is met                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| One clear use case                               | Several conflicting documents → one cited, dispute-aware profile                                                                             |
| One complete input-to-output path                | `case.json` → `reconcile` → `validate` [PR #13] → `render` [PR #15]                                                                          |
| One useful task for the LLM                      | Semantic claim grouping — beyond any fixed parsing                                                                                           |
| ≥ 3 course techniques, both mandatory categories | Table above: one controls LLM use, two test/constrain the model                                                                              |
| One shared repository                            | This repo; epics built on branches, reviewed via PRs, merged one at a time                                                                   |
| Tests or examples that show the result           | Contract/engine/client suites on master; seeded-failure validator tests [PR #13]; renderer tests [PR #15]; corpus [PR #11]; harness TBD [#6] |
| Before-and-after improvement evidence            | TBD [#7] — `docs/prompt-iteration.md`                                                                                                        |

## Known limits

- Reconciliation currently needs a live key; deterministic offline replay of the full pipeline is [#6]'s deliverable.
- The three downstream epics ([PR #11], [PR #13], [PR #15]) are in review, not merged; commands they add are marked throughout.
- Fixtures are fictional entities by design (plantable contradictions, no defamation risk); no live-fetch input path exists.
