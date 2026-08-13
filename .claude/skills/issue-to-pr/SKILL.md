---
name: issue-to-pr
description: End-to-end workflow that takes a GitHub issue from reading to merged-ready PR. Reads the issue, crafts and self-reviews an implementation plan (asking the owner only when a real decision is needed), executes the plan faithfully, reviews the resulting code against the plan, opens a PR with lingtian as reviewer, and writes a post-implementation discovery document of new useful features. Use when asked to implement, fix, or work on a GitHub issue (e.g. "/issue-to-pr 42", "implement issue #42", or an issue URL).
---

# Issue to PR

Take a GitHub issue all the way to a reviewable pull request, faithfully and traceably. The argument is an issue number or URL (e.g. `/issue-to-pr 42`). If no issue is given, ask which issue to work on before doing anything else.

Work through the phases below **in order**. Do not skip a phase, and do not start a later phase until the current one is complete.

## Phase 1 — Read the issue

1. Fetch the full issue including all comments: `gh issue view <number> --comments`.
2. Extract: the problem statement, any acceptance criteria, constraints, and decisions already made in the comment thread (comments often override the original body).
3. Explore the parts of the codebase the issue touches until you can explain, in your own words, what needs to change and why. Check for linked issues/PRs that add context.

## Phase 2 — Craft the plan

Write a concrete implementation plan containing:

- **Goal** — one paragraph restating the issue in your own words.
- **Approach** — the chosen design and why, including alternatives you rejected.
- **Changes** — every file to be created or modified, with a one-line description of each change.
- **Tests** — what will be added or updated to prove the fix/feature works.
- **Out of scope** — things deliberately not done, so the PR stays reviewable.

## Phase 3 — Review the plan until happy

Iterate on the plan until it passes ALL of these checks. Re-review after every revision; only move on when a full pass produces no changes:

- Does it fully address the issue, including edge cases raised in comments?
- Is it the smallest plan that does the job — no opportunistic refactors, no scope creep?
- Does it follow this codebase's existing conventions and patterns?
- Is every step concrete enough to execute without inventing new decisions mid-implementation?
- Are the tests sufficient to catch a regression of this exact issue?

**Owner input:** if the plan hinges on a decision that is genuinely the owner's to make — product behavior, breaking changes, scope trade-offs the issue doesn't settle, or two materially different approaches with no clear winner — stop and ask the owner (use AskUserQuestion when available, otherwise ask directly in the conversation) before proceeding. Otherwise do NOT ask: make the reasonable call, record it as an assumption in the plan, and continue.

## Phase 4 — Execute the plan faithfully

1. Create a branch named `issue-<number>-<short-slug>` off the default branch.
2. Implement exactly what the plan says. The plan is the contract: no drive-by fixes, no extra features, no "while I'm here" changes.
3. If reality forces a deviation (the plan turns out to be wrong or incomplete), keep the deviation minimal and record it in a **deviation log** — what changed, and why. If a deviation would change the shape of the solution (not just its details), go back to Phase 3 and re-review the plan first.
4. Run the project's tests/build as you go; leave the branch green.

## Phase 5 — Review the code against the plan

Review the full diff (`git diff <default-branch>...HEAD`) against the plan:

- Every item in the plan's **Changes** list is implemented — nothing silently dropped.
- Nothing in the diff falls outside the plan plus the deviation log — nothing silently added.
- The tests listed in the plan exist and pass.
- The issue's acceptance criteria are demonstrably met.

Fix any gaps found and re-review. Only proceed when the diff and the plan (plus deviation log) match exactly.

## Phase 6 — Open the PR

1. Push the branch and open the PR with `gh pr create --reviewer lingtian`, tagging **lingtian** as the reviewer.
2. PR body must include:
   - Summary of the change and `Closes #<number>` to link the issue.
   - The plan (Goal / Approach / Changes / Tests).
   - The deviation log, or "No deviations from plan."
   - How it was tested.

## Phase 7 — Post-implementation discovery document

While implementing, you will have noticed things the issue didn't ask for: adjacent features worth building, rough edges, missing tests, refactors that would pay off. Capture them now, while they're fresh:

1. Write `docs/discoveries/issue-<number>-discoveries.md` with one section per discovery:
   - **What** — the feature or improvement, concretely.
   - **Why useful** — the user or developer benefit.
   - **Effort** — rough size (small / medium / large).
2. Only include genuinely useful ideas discovered during this implementation — an empty document with "No discoveries" is better than padded filler.
3. Commit it to the same branch so it ships with the PR, and mention it in a PR comment so the reviewer knows it's there.
