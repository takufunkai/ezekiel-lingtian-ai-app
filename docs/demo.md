# Demo script

An ordered walkthrough of the three canonical scenarios. Set A is the happy path and ends with a rendered profile page; Set B puts a planted contradiction on screen in the **Disputed** section; Set C — the poisoned input — is the closing moment.

Steps that depend on an unmerged PR are marked **[PR #n]**. Until those merge, run them from the PR branch or treat them as the intended flow.

## 0. Prerequisites

```bash
git clone https://github.com/takufunkai/ezekiel-lingtian-ai-app.git
cd ezekiel-lingtian-ai-app
npm install
cp .env.example .env      # then put your OpenCode key in OPENCODE_API_KEY
mkdir -p out              # demo output goes here (untracked)
npm test                  # everything here runs offline — no key needed
```

Optional sanity check that the gateway serves the pinned model (one tiny live call):

```bash
npm run smoke
```

> **Offline mode — TBD [#6].** The reconcile steps below make live model calls. The end-to-end harness (issue #6, not started) adds record/replay caching so the whole demo reruns deterministically without an API key, with `--live` re-recording. Until then, the demo needs a key; everything downstream of the model call (validation, rendering) is already deterministic.

## Act 1 — Set A: the sources agree (happy path)

Five sources about the **Thornwood Seed Library** corroborate each other **[PR #11]**. The trap in this set is a *false positive*: the collection size is worded five different ways ("more than forty", "forty-two varieties", "around forty", …) which are compatible, not conflicting. A run that marks them disputed has mistaken paraphrase for disagreement.

```bash
npm run reconcile -- examples/set-a-agreement.case.json --out out/set-a.profile.json   # [PR #11]
npm run validate:output -- out/set-a.profile.json examples/sources/set-a-*.json        # [PR #13]
npm run render -- out/set-a.profile.json out/set-a.html                                # [PR #15]
open out/set-a.html        # or xdg-open on Linux
```

What to point at on screen:

- `reconcile` logs the attempt count — schema-invalid model output was rejected and retried, never patched. (Once PR #13 merges, `reconcile` also runs the deterministic validator itself and exits non-zero on any violation.)
- The validator reports **0 violations**: every cited source exists in the input set, every quote is a verbatim substring of its source.
- The rendered page has an **empty Disputed section**, and every claim is followed by `[S1]`-style citation markers that jump to the source list.

Optional aside — show the validator actually catching a lie, using a seeded-bad fixture **[PR #13]**:

```bash
npm run validate:output -- test/fixtures/validator/bad-altered-quote.profile.json test/fixtures/validator/sources/*.json
# exits 1 with QUOTE_NOT_VERBATIM at the exact JSON Pointer
```

## Act 2 — Set B: a planted contradiction, on screen

Five sources about the **Halberd Mills Cooperative** **[PR #11]** plant two real conflicts:

- **Founding date** — "was founded in 1998" / "was incorporated in the spring of 1997" / "began trading in 1999". Three answers to one question sharing no phrase a string match could key on: recognising *founded*, *incorporated*, and *began trading* as the same question is the semantic grouping this project exists for.
- **Membership** — a 2-to-1 split ("just over two hundred" twice vs "about a hundred and fifty"). The minority answer must survive; two sources agreeing does not settle a question.

```bash
npm run reconcile -- examples/set-b-contradiction.case.json --out out/set-b.profile.json  # [PR #11]
npm run render -- out/set-b.profile.json out/set-b.html                                   # [PR #15]
open out/set-b.html
```

What to point at on screen:

- The **Disputed** section shows the founding question with the conflicting positions side by side — nothing merged, averaged, or ranked, and each position carries its source and verbatim quote.
- The membership dispute keeps the minority position on screen next to the majority one.
- The agreed questions (location, product, award) still render as agreed — finding one real conflict didn't poison everything else.

## Act 3 — Set C: the poisoned input (closing moment)

Four genuine sources about **Marrow Lane Press**, a poetry publisher — plus one impostor: *Marrowlane Press Ltd*, a commercial printer one space and one suffix away, sharing vocabulary so that name-similarity matching looks reasonable **[PR #11]**. Merging it would fabricate a founding-date dispute (2009 vs 1986) and a bogus location dispute. The correct output: all groups agreed, the impostor's claims excluded entirely.

```bash
npm run reconcile -- examples/set-c-poisoned.case.json --out out/set-c.profile.json   # [PR #11]
npm run render -- out/set-c.profile.json out/set-c.html                               # [PR #15]
open out/set-c.html
grep -c '"sourceId": "set-c-05"' out/set-c.profile.json   # expect 0 — nothing cites the impostor
```

What to point at on screen:

- The Disputed section is **empty** — no fake 1986-vs-2009 founding dispute.
- No claim cites `set-c-05` (the `grep` shows it): the impostor appears in the source manifest, because it was an input, but contributes nothing.
- This is the failure mode current AI search products actually have, caught by construction: the fixture's manifest lists `set-c-05` in `excludedSourceIds`, so the E2E harness **[#6]** turns this scene into a permanent regression test.

## Troubleshooting

- **`OPENCODE_API_KEY is not set`** — copy `.env.example` to `.env` and add the key; no call is made without it.
- **404 from the gateway** — the default base URL had a double-`/v1` bug; fixed in **[PR #16]**, which also adds `LLM_MODEL` and `OPENAI_BASE_URL` overrides in `.env`.
- **Model never produces schema-valid output** — `reconcile` logs each attempt's rejection reasons and exits 1; nothing is written. Try `npm run smoke` to confirm the gateway serves the pinned model.
