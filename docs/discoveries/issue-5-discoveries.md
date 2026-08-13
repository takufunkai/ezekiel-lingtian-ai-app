# Issue #5 discoveries — profile renderer

Ideas noticed while implementing the renderer that the issue did not ask for.

## Show the verbatim quotes on agreed claims too

**What** — Disputed cards show each citation's verbatim quote next to its marker; agreed claims currently show only the `[src-id]` markers. A `<details>` disclosure (or hover title) per agreed claim could reveal the quotes without cluttering the page.

**Why useful** — The quote is the evidence. Making it visible everywhere, not just in disputes, would let a demo audience spot-check any claim against its source in one glance — the citation technique becomes fully inspectable on screen.

**Effort** — Small.

## Render straight from a fixture case + engine output pair

**What** — A `render --case <case.json>` mode (or a flag on the harness, epic #6) that runs nothing but locates the matching engine output for a fixture case and renders it, naming the output after the case id.

**Why useful** — The demo flow today needs the operator to know where the engine wrote its JSON. One command per case removes a step from the live demo and from eyeballing regressions across the corpus.

**Effort** — Small once #3/#6 land; the renderer needs no changes.

## Link citation markers to the exact quote, not just the source

**What** — Sources currently anchor at the document level (`#source-src-01`). If the renderer ever gets the full `SourceDocument` texts (not just the profile's `SourceRef` manifest), it could render each source's body with the cited spans highlighted and anchor markers to the span itself.

**Why useful** — Reviewers could verify a quote is genuinely verbatim without opening the fixture file — the strongest possible on-screen proof that citations are real. Complements the deterministic quote check in epic #4 rather than replacing it.

**Effort** — Medium (new input plumbing: the profile alone does not carry source texts by design).

## Referential-integrity warnings at render time

**What** — The renderer deterministically skips a `claimIds` entry with no matching claim (integrity is epic #4's job). The CLI could still emit a stderr warning when it drops one, without changing the rendered bytes.

**Why useful** — A silently skipped claim in a demo is invisible; a one-line warning makes an engine bug loud at the moment someone is looking at the page, before the validator stage is even wired up.

**Effort** — Small.
