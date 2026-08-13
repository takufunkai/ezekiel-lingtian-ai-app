Now I can see the actual rubric. Your original idea fails it in a specific, fixable way.

## Where "Wikipedia page for high-profile people" breaks

- **"One complete input-to-output path"** — "all online information" has no boundary. There's no defined point where retrieval is done, so there's no path to demonstrate.
- **"Tests or examples that show the result"** — this is the fatal one. The output is free prose with no ground truth, so your three test examples degrade into "we ran it and it looked fine." And live web dependency makes them non-reproducible, which is exactly what you don't want when demoing.
- **At least one technique must test or constrain the model.** Summarization is hard to constrain. There's no deterministic check that a biography is *correct*.
- The spec also warns against unnecessary complexity, and multi-source crawling is a lot of machinery around a fairly ordinary summarization call.

## The salvage (what I'd actually build)

Keep the retrieval-and-synthesis skeleton. Change the LLM's job from *summarizing* to *reconciling*. The course lists "several conflicting updates into a cited summary" as an example, and it maps onto the reconciliation stage from Project 2.

**Use case:** given several documents about one entity, produce a cited profile that separates what sources agree on from what they dispute.

- **Input:** 4–6 source documents, stored as fixtures in the repo (each with an ID, date, and text).
- **LLM task:** extract atomic claims; group claims that answer the same underlying question; mark each group as agreed or disputed; attach the source IDs supporting each claim.
- **Output:** structured JSON → rendered as a profile page. Every claim carries citations; contradictions get their own "Disputed" section instead of being silently smoothed over.

**Why an LLM is genuinely required:** deciding that "founded in 2011," "began operations in early 2012," and "incorporated December 2010" are three answers to *one* question, and that they conflict, is semantic grouping. No regex, template, or string match does that. This is the strongest possible answer to "why not fixed parsing?" — and it's the thing current AI search products actually do badly, so it's defensible in a presentation.

**Three techniques (satisfying both mandatory categories):**

| Technique | Category | Evidence it works |
|---|---|---|
| Structured output — strict JSON schema for claims, groups, citations | Controls LLM use ✓ | Schema violations rejected, not patched |
| Code validation of model output | Tests/constrains model ✓ | Deterministic checks below |
| Source citations | Tests/constrains model ✓ | Every claim traceable to a source ID |

**The validator is where your marks are.** Run outside the model, in plain code: every cited source ID must exist in the input set; every quoted span must appear verbatim in the source it cites; any claim with zero citations fails. This turns "the model hallucinated" from a vibe into a test failure.

**Three test examples:**
1. All sources agree → zero disputed groups, all claims cited.
2. Planted contradiction (two sources give different founding dates) → detected and surfaced as disputed, not averaged or picked arbitrarily.
3. Poisoned input — one source is about a *different* entity with a similar name → its claims are not merged in, and no fabricated citation appears.

Test 3 is your demo moment. It's also the honest version of the risk you'd have shipped in the original idea.

**Scope discipline:** use local fixtures, not live fetching, for all tests. If you want a live demo, add one optional fetch path *after* the fixture path passes. Use organizations or fictional entities rather than real named people — you avoid the defamation problem, and more practically, you can *plant* the contradictions you need to test.

**Your before-and-after improvement:** prompt v1 will over-merge (treating near-identical claims as one) or under-merge. Record the score on test 2, revise the prompt, record it again. That's the required evidence, and it falls out naturally.

## Alternatives, if the above doesn't fit

**Same machinery, biomedical sources.** I notice you have PubMed, ClinicalTrials, ChEMBL, and bioRxiv connectors. Given a compound, produce a cited evidence brief flagging where studies disagree. Swaps "tools/MCP" in as a technique and is more impressive. Risk: live APIs are flaky during a live demo, so cache responses as fixtures.

**Requirements → review questions.** Straight from the course examples. Input a requirements doc, output the ambiguities and the acceptance criteria they imply. Very safe, very demoable, less ambitious.

**Eval harness for a model task.** Meta, but scoring is deterministic and the tests write themselves. Weakest as a "useful app."

I'd take the first one. Same intellectual content as your original idea, but with a defined input set, a checkable output, and a failure mode you can show on screen.

One thing that would change my recommendation: is your team's domain biomedical, or was that connector set incidental? If it's real domain expertise, go with alternative one — knowing which sources matter is most of the value in retrieval, and that's not transferable.

