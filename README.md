# Cited Profile Reconciler

Given several source documents about one entity, produce a **cited profile** that separates what the sources agree on from what they dispute.

The interesting part is not summarisation — it is reconciliation. Deciding that "founded in 2011", "began operations in early 2012", and "incorporated December 2010" are three answers to _one_ question, and that they conflict, is semantic grouping. No regex, template, or string match does that, which is why an LLM is genuinely required here. Contradictions get their own **Disputed** section rather than being silently smoothed over, and every claim carries a citation back to the source that supports it.

See [`docs/INITIAL_PROJECT_IDEA.md`](docs/INITIAL_PROJECT_IDEA.md) for the full rationale.

## Status

The whole pipeline — contract, engine, fixture corpus, validator, renderer, and model configuration — is on `master`. Two pieces are still open. **This table is the only place status is tracked:** every command and file named elsewhere in this README, and in [`docs/demo.md`](docs/demo.md), is on `master` unless it appears here as open.

| Piece                                                        | Where it stands                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data contract — schemas, TS mirrors, compiled validators, CI | `master` ([#1](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/1))                                                                             |
| Reconciliation engine — `npm run reconcile`                  | `master` ([#3](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/3))                                                                             |
| Fixture corpus — Sets A / B / C                              | `master` ([#2](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/2))                                                                             |
| Deterministic output validator — `npm run validate:output`   | `master` ([#4](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/4))                                                                             |
| Profile renderer — `npm run render`                          | `master` ([#5](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/5))                                                                             |
| Model / gateway configuration via `.env`                     | `master`                                                                                                                                                    |
| End-to-end harness with offline replay                       | **open** ([PR #25](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/25)) — adds `test:e2e`                                                        |
| Prompt iteration — v1 → v2 before/after evidence             | **open** ([PR #20](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/20)) for [#7](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/7) |

No reconciliation run has been made against a live gateway from this repository — there is no key on the machine the epics were built on — so no scenario outcome or score is reported anywhere in these docs. `npm run reconcile` and `npm run smoke` are the two commands that need one; everything else, including the whole test suite, runs offline.

### The fixture corpus

Three test cases live at `examples/*.case.json`, each pairing a set of source documents in `examples/sources/` with the ground truth a run is scored against:

| Case                  | Scenario                                                    | Answer key                                                    |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| `set-a-agreement`     | Sources corroborate                                         | 12 questions, all agreed                                      |
| `set-b-contradiction` | Two planted conflicts                                       | 10 questions; founding date and membership disputed, 8 agreed |
| `set-c-poisoned`      | One source is a different entity with a near-identical name | 11 questions, all agreed, and no claim citing the impostor    |

A case's `expect.questions` is one entry per underlying question the sources answer. Each listed question must appear in a run's output with the status given — that is the assertion. Group _count_ is a signal rather than a verdict: the questions are pitched finer than `prompts/reconcile.v1.md` calibrates for, so a run that fuses several of them into one group may be behaving correctly, and over/under-merge counts are reported rather than failed on. `expect.excludedSourceIds` names documents whose content must not reach the profile at all. The manifests are the answer key and are **never** shown to the model — only the documents listed in `documents` become prompt input, via `toModelInput` (see [The engine](#the-engine)). `npm run validate:contract` checks every case and document against the schemas, plus the cross-file rules a schema cannot express.

## Setup

Requires **Node.js ≥ 20.10**.

```bash
npm install
cp .env.example .env      # then add your OpenCode key
```

Authentication goes through the **OpenCode** gateway (`OPENCODE_API_KEY`), not a personal Anthropic key. `LLM_MODEL` selects the model — it must be on the `SUPPORTED_MODELS` allowlist in `src/client.ts` (the structured-output request shape is model-specific, so new models are verified with `npm run smoke` before being added), and falls back to the pinned default when unset. `OPENCODE_BASE_URL` / `OPENAI_BASE_URL` override the gateway URL; a trailing `/v1` on either is stripped automatically because the Anthropic SDK appends `/v1/messages` itself. `OPENAI_BASE_URL` must be `https` (it is a machine-wide convention other tools set; the project-owned `OPENCODE_BASE_URL` carries no such restriction and takes precedence).

`.env` is gitignored — never commit a real key. The tests and the contract check run fine without a key; only `npm run reconcile` and `npm run smoke` make live calls.

| Command                                                | What it does                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `npm test`                                             | Run the test suite (vitest)                                                  |
| `npm run typecheck`                                    | Type-check without emitting                                                  |
| `npm run validate:contract`                            | Check every example document against the committed schemas                   |
| `npm run reconcile -- <case.json> --out <out.json>`    | Run the reconciliation engine on a fixture case (needs a live key)           |
| `npm run validate:output -- <profile.json> <sources…>` | Deterministically validate a finished profile against its sources            |
| `npm run render -- <profile.json> [out.html]`          | Profile → one self-contained HTML page (stdout without an output path)       |
| `npm run smoke`                                        | One tiny live structured-output call to probe the gateway (needs a live key) |
| `npm run format`                                       | Format with prettier                                                         |
| `npm run lint`                                         | Type-check + formatting check                                                |

`validate:output` takes any number of source arguments, each a document or a directory of `*.json`, and accepts `--json` (report as JSON) and `--strict` (treat an ungrouped claim as a failure). It exits 0 clean, 1 on violations, 2 when it could not run at all.

## The pipeline end to end

One complete input-to-output path: a fixture case in, a cited profile page out.

```
fixture case (examples/*.case.json)
     │   toModelInput() strips author notes and the answer key;
     │   the model sees only id, date, title, text
     ▼
reconcile   npm run reconcile -- <case.json> --out <profile.json>
     │   the LLM extracts atomic claims, groups them by underlying
     │   question, marks each group agreed or disputed; output that
     │   violates the schema is rejected and retried, never patched,
     │   and the deterministic validator below runs as a mandatory
     │   final step of this same command
     ▼
validate    npm run validate:output -- <profile.json> <sources…>
     │   deterministic, no LLM: every cited source exists, every
     │   quote is a verbatim substring, disputes carry ≥ 2 sources
     ▼
render      npm run render -- <profile.json> <out.html>
         one self-contained HTML page: agreed claims with citation
         markers, and a Disputed section that shows conflicts
         side by side instead of smoothing them over
```

The LLM does exactly one job — the semantic grouping in the middle. Everything before it is plain file loading, and everything after it is plain code, so a hallucinated citation is a test failure rather than a vibe.

`reconcile` does not just write and hope: after the model's output passes the schema it runs `validateOutput` itself and exits non-zero if any citation is unresolvable or any quote is not verbatim. The failing profile is still written, because it is the evidence prompt iteration works from — the exit code is what says it is not a result. Running `validate:output` separately, as the demo does, is what puts that report on screen.

## Demo

[`docs/demo.md`](docs/demo.md) is the ordered walkthrough: Set A (agreement) as the happy path ending in a rendered profile, Set B putting a planted contradiction on screen in the Disputed section, and Set C — the poisoned-input catch — as the closing moment. Every command it lists is on `master`; the reconcile steps need a live key.

[`docs/report.md`](docs/report.md) is the project report: architecture, the input boundary and output contract, the three techniques with their evidence, what each test scenario proves, and what is still open.

## Techniques and rubric

Three course techniques, covering both mandatory categories. [`docs/report.md`](docs/report.md) expands on the evidence for each.

| Technique                              | Rubric category              | Evidence                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured output (strict JSON schema) | Controls LLM use             | Schema violations are rejected and retried, never patched (`src/engine.ts`, tested offline in `test/engine.test.ts`)                                                                           |
| Code validation of model output        | Tests / constrains the model | Deterministic validator with seeded-failure tests — fabricated source id, altered quote, uncited claim each caught with a specific violation code (`src/validate.ts`, `test/validate.test.ts`) |
| Source citations                       | Tests / constrains the model | Every claim carries ≥ 1 citation (schema-enforced); every quote must appear verbatim in its source (`src/validate.ts`); the rendered page links each claim to its sources (`src/render.ts`)    |

## The contract

The JSON Schemas in [`schema/`](schema/) are the **source of truth**. [`src/contract.ts`](src/contract.ts) holds hand-written TypeScript mirrors of them, and [`test/contract.test.ts`](test/contract.test.ts) enforces that the two stay in sync — a field added to one side but not the other fails the test. When you change the contract, edit the schema first, then the type, then the key list in the test.

### Source documents — `schema/source-document.schema.json`

One document per file. This is the input format; the fixture corpus in issue #2 is written against it.

```json
{
  "id": "src-01",
  "date": "2021-03-14",
  "title": "Nimbus Cartography Collective: A Brief History",
  "text": "The Nimbus Cartography Collective was founded in 2011 by four cartographers…",
  "notes": "Optional. Why this fixture exists. Never shown to the model or the renderer."
}
```

`id` is lowercase alphanumeric with dots, dashes, or underscores, and must be unique within a fixture case — claims cite this value. `date` is `YYYY-MM-DD`. Quote spans in claims must appear **verbatim** in `text`, so avoid reflowing whitespace once claims reference a document.

### Reconciled profile — `schema/claims.schema.json`

The structured output of one reconciliation run, and the input to both the validator and the renderer.

```json
{
  "schemaVersion": "1.0.0",
  "entity": { "name": "Nimbus Cartography Collective", "aliases": ["Nimbus Collective"] },
  "generatedAt": "2026-08-13T12:00:00Z",
  "model": "claude-opus-5",
  "sources": [{ "id": "src-01", "date": "2021-03-14", "title": "…" }],
  "claims": [
    {
      "id": "claim-01",
      "text": "The collective was founded in 2011.",
      "citations": [{ "sourceId": "src-01", "quote": "was founded in 2011" }]
    }
  ],
  "groups": [
    {
      "id": "group-01",
      "question": "When was the collective founded?",
      "status": "disputed",
      "claimIds": ["claim-01", "claim-02"]
    }
  ]
}
```

Three constraints are worth knowing because they shape how the other epics work:

- **Every claim carries at least one citation**, and each citation pairs a `sourceId` with the verbatim `quote` that supports it. A claim supported by several sources carries one citation per source. This is what makes the deterministic quote check in issue #4 possible.
- **A `disputed` group holds at least two claims**, enforced by the schema itself. Conflicting answers sit side by side; nothing averages or resolves them.
- **`additionalProperties` is `false` throughout**, so a model that invents a field fails validation rather than having the extra field quietly ignored. Schema violations are rejected, not patched.

[`examples/reconciled-profile.example.json`](examples/reconciled-profile.example.json) is a hand-written document that validates against the schema — a worked reference for what the engine should emit.

## Talking to the model

[`src/client.ts`](src/client.ts) is the only module that constructs a client. The API key, gateway base URL, model selection (`LLM_MODEL` env var, validated against the `SUPPORTED_MODELS` allowlist, with a pinned fallback), token ceiling, and reasoning effort all live there and nowhere else:

```ts
import { getModel, getClient } from "./client.js";
```

Requests go through OpenCode, but the Anthropic SDK is still the transport — it is simply pointed at the gateway via `baseURL`, so the Messages API surface is unchanged for callers. The module deliberately contains no prompt and no pipeline; those belong to the engine epic. If `OPENCODE_API_KEY` is missing, `getClient()` throws with a message explaining how to fix it; use `hasApiKey()` to skip live calls in tests and scripts.

## The engine

`npm run reconcile -- <case.json> --out <out.json>` is the app's input→output path: it loads a fixture case, feeds **only** the referenced source documents to the model (author `notes` and the case's `expect` answer key are structurally unreachable from prompt construction — see `toModelInput` in `src/contract.ts`), and writes a profile that validates against `schema/claims.schema.json`. Output that violates the schema is **rejected and retried** (bounded attempts), never patched; if every attempt fails, the run logs each rejection reason and exits non-zero. The prompt lives in [`prompts/reconcile.v1.md`](prompts/reconcile.v1.md) — versioned and frozen; prompt iteration (issue #7) adds `v2` rather than editing `v1`. The model call is injected (`ModelCaller` in `src/engine.ts`), so the pipeline is fully tested offline with canned responses; `npm run smoke` is the one-call live check that the gateway serves the configured model and passes structured outputs through.

## Layout

```
schema/     JSON Schemas — the source of truth for the contract
prompts/    Versioned reconciliation prompts (v1 is frozen)
src/        client.ts (Anthropic), contract.ts (types), schema.ts (validators),
            engine.ts + prompt.ts + model-caller.ts + cli.ts (reconciliation engine),
            validate.ts (deterministic output validator), render.ts (HTML page)
examples/   The fixture corpus (*.case.json + sources/), a minimal format example, and a valid profile document
scripts/    validate-contract.ts — contract check; smoke.ts — live gateway probe;
            validate-output.ts and render-profile.ts — the two CLI front-ends
test/       Contract sync, client, engine, validator and renderer suites, with
            seeded-bad profiles under fixtures/
docs/       Project idea, problem statement, demo script (demo.md), report (report.md)
```
