# Discoveries from issue #2 (fixture corpus)

Ideas noticed while authoring the corpus that the issue did not ask for.

## Strip `notes` before prompting — make the leak impossible

**What** — Every fixture document carries a `notes` field that spells out the answer key ("plants the second conflicting founding answer…"). The engine (#3) must remember to drop `notes` (and the manifest itself) before sending documents to the model, but nothing currently enforces that. A tiny helper in `src/` (e.g. `toPromptDocument(doc)` returning only `id`/`date`/`title`/`text`) plus a harness assertion that no prompt string contains a `notes` value would make the leak structurally impossible.

**Why useful** — A single forgotten field turns every benchmark result into a lie: the model would be graded on scenarios whose answers were pasted into its input.

**Effort** — Small.

## Machine-checkable poison markers in the expectation

**What** — `excludedSourceIds` bans citations of the impostor, but a run can launder the impostor's *content* without citing it (e.g. a claim "founded in 1998" cited against a legitimate source — a fabricated citation). An optional `expect.forbiddenText: string[]` (distinctive impostor values like `"1998"`, `"Erik Fernhaven"`, `"Dunmore"`, `"twelve thousand"`) would let the deterministic validator (#4) and harness (#6) string-match profile claims for leaked poison, complementing the citation check.

**Why useful** — Catches the subtlest Set C failure mode — poison content with a fake citation — deterministically, with no LLM judge needed.

**Effort** — Medium (schema + type + sync-test change, then a validator check).

## Answer-key completeness check in `validate-contract.ts`

**What** — `test/fixtures.test.ts` asserts that every document id appears in either `requiredSourceIds` or `excludedSourceIds`. That authoring invariant could move into (or be duplicated in) `scripts/validate-contract.ts` so `validate:contract` alone catches a document that is fed to the model but invisible to the harness's coverage checks.

**Why useful** — The corpus stays trustworthy even for contributors who run only the contract check; a silently unaccounted document weakens the "no input silently dropped" guarantee the fixtures exist to test.

**Effort** — Small.

## Flag unreferenced files under `fixtures/`

**What** — The corpus scan validates only documents referenced by a case's `documents` array. A stray `.json` under `fixtures/<set>/sources/` (authored but never wired into the manifest, or orphaned by a rename) is silently ignored. The scan already walks the tree, so it could cheaply report any source file no case references.

**Why useful** — Catches the most likely authoring mistake — writing a document and forgetting to list it — which otherwise surfaces much later as a confusing harness result.

**Effort** — Small.
