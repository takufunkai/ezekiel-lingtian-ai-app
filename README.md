# Cited Profile Reconciler

Given several source documents about one entity, produce a **cited profile** that separates what the sources agree on from what they dispute.

The interesting part is not summarisation — it is reconciliation. Deciding that "founded in 2011", "began operations in early 2012", and "incorporated December 2010" are three answers to *one* question, and that they conflict, is semantic grouping. No regex, template, or string match does that, which is why an LLM is genuinely required here. Contradictions get their own **Disputed** section rather than being silently smoothed over, and every claim carries a citation back to the source that supports it.

See [`docs/INITIAL_PROJECT_IDEA.md`](docs/INITIAL_PROJECT_IDEA.md) for the full rationale.

## Status

This repository currently contains the **scaffolding and the shared data contract** ([issue #1](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/1)). The reconciliation engine, deterministic validator, renderer, and fixture corpus are separate epics ([#2](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/2)–[#5](https://github.com/takufunkai/ezekiel-lingtian-ai-app/issues/5)) that all build on the contract described below.

## Setup

Requires **Node.js ≥ 20.10**.

```bash
npm install
cp .env.example .env      # then add your OpenCode key
```

Authentication goes through the **OpenCode** gateway (`OPENCODE_API_KEY`), not a personal Anthropic key. Set `OPENCODE_BASE_URL` only if you need to point at a gateway other than the default.

`.env` is gitignored — never commit a real key. Nothing in this epic makes a live API call, so the tests and the contract check run fine without a key.

| Command | What it does |
| --- | --- |
| `npm test` | Run the test suite (vitest) |
| `npm run typecheck` | Type-check without emitting |
| `npm run validate:contract` | Check every example document against the committed schemas |
| `npm run format` | Format with prettier |
| `npm run lint` | Type-check + formatting check |

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

## Layout

```
schema/     JSON Schemas — the source of truth for the contract
src/        client.ts (Anthropic), contract.ts (types), schema.ts (compiled validators)
examples/   A valid profile document and two format-example sources
scripts/    validate-contract.ts — checks the examples against the schemas
test/       Contract sync tests and client behaviour tests
docs/       Project idea and problem statement
```
