# Issue #4 discoveries

Ideas noticed while building the deterministic validator, out of scope for the issue itself.

## Manifest-completeness check (input document absent from `sources`)

**What** — the validator checks that every manifest entry corresponds to an input document (`manifest-source-not-in-input`), but not the reverse: an engine output whose `sources` manifest omits a document that was supplied as input passes silently. `claims.schema.json` describes the manifest as "every source document that was supplied as input", so the reverse direction is arguably also a violation.

**Why useful** — a model that silently drops an input source from its manifest is hiding evidence; catching it would strengthen the poisoned-input scenario. Left out here because the intended semantics for poisoned cases (should the impostor document appear in the manifest?) is a product call the schema description alone does not settle — worth deciding explicitly with #2/#3.

**Effort** — small (one loop + one violation code + tests), once the semantics are decided.

## Quote-check diagnostics: report the nearest match

**What** — `quote-not-verbatim` currently says only that the quote is not a substring. For prompt iteration (#7) it would help to include *why* it missed: a whitespace/punctuation-normalised match ("verbatim except for whitespace") or the closest span by edit distance.

**Why useful** — most near-miss quotes are single-character or whitespace drifts; naming the culprit turns a manual diff into a one-glance fix and tells #7 which failure modes to prompt against.

**Effort** — medium (normalised second pass is small; edit-distance search needs care to stay fast on long sources).

## Machine-readable violation summary for the harness

**What** — the report is a flat violation list. The harness (#6) will likely want per-code counts and a per-claim index (e.g. "claim c3: 2 violations") to score runs and aggregate across the fixture corpus.

**Why useful** — avoids every consumer re-implementing the same group-by; keeps scoring code in one place.

**Effort** — small (a `summarise(report)` helper over the existing shape).

## CLI startup dominates the test suite

**What** — the four spawned-CLI tests take ~25s of the 33s suite runtime, almost all of it `tsx` cold-start under WSL on `/mnt/c`. The core is unit-tested directly, so the spawns only prove arg-parsing and exit codes.

**Why useful** — if the suite grows, moving the CLI logic into an exported `runCli(argv)` tested in-process (keeping one smoke spawn) would cut test wall-time substantially.

**Effort** — small.
