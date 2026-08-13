# Cited Profile Reconciler

Given several source documents about one entity, produce a **cited profile** that separates what the sources agree on from what they dispute.

The interesting part is not summarisation — it is reconciliation. Deciding that "founded in 2011", "began operations in early 2012", and "incorporated December 2010" are three answers to _one_ question, and that they conflict, is semantic grouping. No regex, template, or string match does that, which is why an LLM is genuinely required here. Contradictions get their own **Disputed** section rather than being silently smoothed over, and every claim carries a citation back to the source that supports it.

See [`docs/INITIAL_PROJECT_IDEA.md`](docs/INITIAL_PROJECT_IDEA.md) for the full rationale.

## Status

This repository contains the **scaffolding and shared data contract** ([issue #1](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/1)), the **reconciliation engine** ([#3](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/3)), and the **fixture corpus** ([#2](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/2)). The deterministic validator ([#4](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/4)) and profile renderer ([#5](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/5)) are separate epics that build on the contract described below.

### The fixture corpus

Three test cases live at `examples/*.case.json`, each pairing a set of source documents in `examples/sources/` with the ground truth a run is scored against:

| Case                  | Scenario                                                    | Expected outcome                                        |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `set-a-agreement`     | Sources corroborate                                         | 12 agreed groups, 0 disputed                            |
| `set-b-contradiction` | Two planted conflicts                                       | 2 disputed groups (founding date, membership), 8 agreed |
| `set-c-poisoned`      | One source is a different entity with a near-identical name | 11 agreed groups, and no claim citing the impostor      |

A case's `expect.questions` is one entry per underlying question the sources answer, so a run's group count is directly comparable to it. `expect.excludedSourceIds` names documents whose content must not reach the profile at all. The manifests are the answer key and are **never** shown to the model — only the documents listed in `documents` become prompt input, via `toModelInput` (see [The engine](#the-engine)). `npm run validate:contract` checks every case and document against the schemas, plus the cross-file rules a schema cannot express.

## Setup

Requires **Node.js ≥ 20.10**.

```bash
npm install
cp .env.example .env      # then add your OpenCode key
```

Authentication goes through the **OpenCode** gateway (`OPENCODE_API_KEY`), not a personal Anthropic key. `LLM_MODEL` selects the model (falling back to the pinned default in `src/client.ts`), and `OPENCODE_BASE_URL` / `OPENAI_BASE_URL` override the gateway URL if you need a route other than the default.

`.env` is gitignored — never commit a real key. The tests and the contract check run fine without a key; only `npm run reconcile` and `npm run smoke` make live calls.

| Command                                             | What it does                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm test`                                          | Run the test suite (vitest)                                                  |
| `npm run typecheck`                                 | Type-check without emitting                                                  |
| `npm run validate:contract`                         | Check every example document against the committed schemas                   |
| `npm run reconcile -- <case.json> --out <out.json>` | Run the reconciliation engine on a fixture case (needs a live key)           |
| `npm run smoke`                                     | One tiny live structured-output call to probe the gateway (needs a live key) |
| `npm run format`                                    | Format with prettier                                                         |
| `npm run lint`                                      | Type-check + formatting check                                                |

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

[`src/client.ts`](src/client.ts) is the only module that constructs a client. The API key, gateway base URL, model id, token ceiling, and reasoning effort are pinned there and nowhere else:

```ts
import { MODEL, getClient } from "./client.js";
```

Requests go through OpenCode, but the Anthropic SDK is still the transport — it is simply pointed at the gateway via `baseURL`, so the Messages API surface is unchanged for callers. The module deliberately contains no prompt and no pipeline; those belong to the engine epic. If `OPENCODE_API_KEY` is missing, `getClient()` throws with a message explaining how to fix it; use `hasApiKey()` to skip live calls in tests and scripts.

## The engine

`npm run reconcile -- <case.json> --out <out.json>` is the app's input→output path: it loads a fixture case, feeds **only** the referenced source documents to the model (author `notes` and the case's `expect` answer key are structurally unreachable from prompt construction — see `toModelInput` in `src/contract.ts`), and writes a profile that validates against `schema/claims.schema.json`. Output that violates the schema is **rejected and retried** (bounded attempts), never patched; if every attempt fails, the run logs each rejection reason and exits non-zero. The prompt lives in [`prompts/reconcile.v1.md`](prompts/reconcile.v1.md) — versioned and frozen; prompt iteration (issue #7) adds `v2` rather than editing `v1`. The model call is injected (`ModelCaller` in `src/engine.ts`), so the pipeline is fully tested offline with canned responses; `npm run smoke` is the one-call live check that the gateway serves the pinned model and passes structured outputs through.

## Layout

```
schema/     JSON Schemas — the source of truth for the contract
prompts/    Versioned reconciliation prompts (v1 is frozen)
src/        client.ts (Anthropic), contract.ts (types), schema.ts (validators),
            engine.ts + prompt.ts + model-caller.ts + cli.ts (reconciliation engine)
examples/   The fixture corpus (*.case.json + sources/) and a valid profile document
scripts/    validate-contract.ts — contract check; smoke.ts — live gateway probe
test/       Contract sync tests, client behaviour tests, engine tests
docs/       Project idea and problem statement
```
