# Demo script

An ordered walkthrough of the three canonical scenarios. Set A is the happy path and ends with a rendered profile page; Set B puts a planted contradiction on screen in the **Disputed** section; Set C — the poisoned input — is the closing moment.

Everything below runs from a clean checkout of `master` — the fixture corpus, the engine, the deterministic validator and the renderer are all merged. Nothing here needs a PR branch checked out. What is *not* merged is tracked in one place — the Status table in [`README.md`](../README.md) — rather than annotated step by step here.

The reconcile steps make live model calls, so they need `OPENCODE_API_KEY`. No live run has been made from this repository — there is no key on the machine these epics were built on — so this script is the intended sequence with real commands, not a transcript of a recorded session. Every step downstream of the model call is deterministic and covered by the offline test suite.

## 0. Prerequisites

```bash
git clone https://github.com/takufunkai/ezekiel-lingtian-ai-app.git
cd ezekiel-lingtian-ai-app
npm install
cp .env.example .env      # then put your OpenCode key in OPENCODE_API_KEY
mkdir -p out              # demo output goes here (untracked)
npm test                  # everything here runs offline — no key needed
```

Optional sanity check that the gateway serves the configured model (one tiny live call):

```bash
npm run smoke
```

> **Offline mode — TBD.** The reconcile steps below make live model calls. The end-to-end harness for issue #6 adds record/replay caching so all three cases rerun deterministically without a key (`npm run test:e2e`, with `--live` to re-record); it is written but still open in [PR #25](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/25), so on `master` today the demo needs a key. Everything downstream of the model call — validation, rendering — is already deterministic.

## Act 1 — Set A: the sources agree (happy path)

Five sources about the **Thornwood Seed Library** corroborate each other. The trap in this set is a *false positive*: the collection size is worded five different ways ("more than forty", "forty-two varieties", "around forty", …) which are compatible, not conflicting. A run that marks them disputed has mistaken paraphrase for disagreement.

```bash
npm run reconcile -- examples/set-a-agreement.case.json --out out/set-a.profile.json
npm run validate:output -- out/set-a.profile.json examples/sources/set-a-*.json
npm run render -- out/set-a.profile.json out/set-a.html
open out/set-a.html        # or xdg-open on Linux
```

What to point at on screen:

- `reconcile` logs the gateway, model and prompt version, then the attempt count — schema-invalid model output was rejected and retried, never patched. It also runs the deterministic validator itself as a mandatory final step, so a zero exit code already means the citations check out; a profile that fails is still written, but the run exits non-zero to say it is not a result.
- The separate `validate:output` call is what puts that report on screen: **0 violations**, meaning every cited source exists in the input set and every quote is a verbatim substring of its source.
- The rendered page has an **empty Disputed section**, and every claim is followed by `[S1]`-style citation markers that jump to the source list.

Optional aside — show the validator actually catching a lie, using a seeded-bad fixture:

```bash
npm run validate:output -- test/fixtures/validator/bad-altered-quote.profile.json test/fixtures/validator/sources/*.json
# exits 1 with QUOTE_NOT_VERBATIM at the exact JSON Pointer
```

## Act 2 — Set B: a planted contradiction, on screen

Five sources about the **Halberd Mills Cooperative** plant two real conflicts:

- **Founding date** — "was founded in 1998" / "was incorporated in the spring of 1997" / "began trading in 1999". Three answers to one question sharing no phrase a string match could key on: recognising *founded*, *incorporated*, and *began trading* as the same question is the semantic grouping this project exists for.
- **Membership** — a 2-to-1 split ("just over two hundred" twice vs "about a hundred and fifty"). The minority answer must survive; two sources agreeing does not settle a question.

```bash
npm run reconcile -- examples/set-b-contradiction.case.json --out out/set-b.profile.json
npm run render -- out/set-b.profile.json out/set-b.html
open out/set-b.html
```

What to point at on screen:

- The **Disputed** section shows the founding question with the conflicting positions side by side — nothing merged, averaged, or ranked, and each position carries its source and verbatim quote.
- The membership dispute keeps the minority position on screen next to the majority one.
- The agreed questions (location, product, award) still render as agreed — finding one real conflict didn't poison everything else.

Do not count groups on screen and compare the number to the manifest's ten questions. The manifest's questions are pitched finer than `prompts/reconcile.v1.md` calibrates for — a run that answers premises together with location, or patterns together with product, is behaving reasonably. What the manifest asserts is that each question is answered **with the status given**; over- and under-merge are numbers to report, not a pass/fail line.

## Act 3 — Set C: the poisoned input (closing moment)

Four genuine sources about **Marrow Lane Press**, a poetry publisher — plus one impostor: *Marrowlane Press Ltd*, a commercial printer one space and one suffix away, sharing vocabulary so that name-similarity matching looks reasonable. Merging it would fabricate a founding-date dispute (2009 vs 1986) and a bogus location dispute. The correct output: all groups agreed, the impostor's claims excluded entirely.

```bash
npm run reconcile -- examples/set-c-poisoned.case.json --out out/set-c.profile.json
npm run render -- out/set-c.profile.json out/set-c.html
open out/set-c.html

# The impostor must be cited by nothing. Phrased so that success is an exit-0
# command: plain `grep -c … # expect 0` exits 1 when it finds nothing, which is
# the outcome we want, and would abort the script under `set -e`.
! grep -q '"sourceId": "set-c-05"' out/set-c.profile.json && echo "impostor not cited"
```

What to point at on screen:

- The Disputed section is **empty** — no fake 1986-vs-2009 founding dispute.
- No claim cites `set-c-05` (the `grep` line prints `impostor not cited`): the impostor appears in the source manifest, because it was an input, but contributes nothing.
- This is the failure mode current AI search products actually have, caught by construction: the fixture's manifest lists `set-c-05` in `excludedSourceIds`, so once the end-to-end harness lands ([PR #25](https://github.com/takufunkai/ezekiel-lingtian-ai-app/pull/25)) this scene becomes a permanent regression test rather than a live demo.

## Troubleshooting

- **`OPENCODE_API_KEY is not set`** — copy `.env.example` to `.env` and add the key; no call is made without it.
- **404 from the gateway** — the default base URL once carried a double-`/v1` bug (requests went to `/zen/v1/v1/messages`); the default is now `https://opencode.ai/zen`, and a trailing `/v1` on either override is stripped for you. If you set an override, `reconcile` prints the gateway it resolved on its first line, so check that before anything else.
- **`LLM_MODEL="…" is not a supported model`** — model selection is an allowlist (`SUPPORTED_MODELS` in `src/client.ts`), because the structured-output request shape is verified per model. Leave `LLM_MODEL` unset to take the pinned default, or verify a new model with `npm run smoke` and add it to the list.
- **`OPENAI_BASE_URL="…" is not https`** — that variable is often set machine-wide by unrelated tools, so the project refuses to send the OpenCode key to a plaintext URL. Use the project-owned `OPENCODE_BASE_URL`, which takes precedence.
- **Model never produces schema-valid output** — `reconcile` logs each attempt's rejection reasons and exits 1; nothing is written. Try `npm run smoke` to confirm the gateway serves the configured model.
- **`reconcile` exits 1 but the profile file is there** — that is the validator, not the schema: the output was schema-valid but cited a source or quoted a span the documents do not support. The violation lines name the code and a JSON Pointer. The file is kept on purpose as evidence; the exit code is what says it is not a result.
