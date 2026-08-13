# Issue #3 discoveries

Things noticed while building the reconciliation engine that the issue didn't ask for. None are implemented; each is a candidate for a follow-up issue.

## Retry with validation feedback

**What.** On a schema rejection the engine currently re-sends the identical request. A v2 retry could append the ajv error lines as a follow-up user turn ("your previous output violated the schema at these paths — emit a corrected document"), giving the model the reason it failed. Requires widening the `ModelCaller` seam from one message to a short history.

**Why useful.** Likely raises the first-retry success rate substantially, cutting cost and latency on flaky outputs — the retry budget stops being three blind rolls of the same dice. Still reject-and-retry, never patching: the model produces the whole corrected document.

**Effort.** Medium.

## Run the deterministic checks inside the retry loop

**What.** Once #4 ships its checks (every quote an exact substring, every cited id present, every claim grouped), the engine could run them after schema validation and treat failures as rejections too — retryable events rather than downstream test failures.

**Why useful.** A profile that is schema-valid but cites a paraphrased quote currently succeeds at the engine and fails only in the validator/harness. Retrying at generation time is the only point where the failure is still recoverable.

**Effort.** Small once #4 exists (the engine's reject-and-retry loop already takes a list of reasons).

## Prompt caching for the eval harness

**What.** The system prompt and the transport schema are byte-identical across every run. When the harness (#6) runs the whole corpus, adding a `cache_control` breakpoint on the system block would serve that prefix from cache on all runs after the first — if the OpenCode gateway passes prompt caching through (the smoke script could be extended to probe this).

**Why useful.** The harness re-sends the same large prefix once per case per prompt version; cached reads are ~0.1× input price.

**Effort.** Small.

## Shared "load and validate a JSON file" helper

**What.** The `tryReadJsonFile` → `validateX` → `formatSchemaErrors` sequence now appears in `scripts/validate-contract.ts` and twice in `src/engine.ts`. A `loadValidated<T>(path, validator)` helper in `src/schema.ts` returning `{ok, data | errors}` would collapse all three.

**Why useful.** #4 (validator) and #6 (harness) will each need the same sequence again; four copies is where drift starts.

**Effort.** Small.

## validate-contract does not catch duplicate document ids

**What.** A case whose two document files declare the same `id` passes `npm run validate:contract` (the script collects ids into a `Set`, so the duplicate silently disappears). Citations against that id would be ambiguous.

**Why useful.** The fixture corpus (#2) is hand-written — exactly the kind of mistake the script exists to catch. One `Set.has` check before `add` fixes it.

**Effort.** Small.

## SDK bump to the GA structured-outputs surface

**What.** The pinned `@anthropic-ai/sdk` 0.71.x only ships structured outputs as the beta top-level `output_format`. Current SDKs expose the GA `output_config.format` plus a `messages.parse()` helper that validates against the schema client-side and strips transport-unsupported keywords automatically — which would replace the hand-rolled transport-schema sanitiser in `src/engine.ts`.

**Why useful.** Deletes bespoke code and moves off a deprecated parameter. Should be done when a live key is available so the new surface can be verified against the OpenCode gateway (`npm run smoke` is the probe).

**Effort.** Medium (lockfile churn touches every epic; verify live before merging).
