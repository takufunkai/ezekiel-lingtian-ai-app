/**
 * Renders a validated `ReconciledProfile` into one self-contained HTML page.
 *
 * There is **no model call in here**. The renderer is a pure function of its
 * input: the same JSON always produces a byte-identical page. That rules out
 * `Date.now()`, random ids, and iteration over anything whose order the input
 * does not fix — every loop below walks an array from the document itself, so the
 * page's order is the document's order.
 *
 * Two rules shape the output:
 *
 *   1. Every claim is followed by inline citation markers (`[S1][S3]`) that link
 *      to that source's entry in the Sources list.
 *   2. A `disputed` group is rendered as the underlying question plus each
 *      position side by side. Conflicting answers are never merged, averaged, or
 *      resolved — surfacing them is the point of the output format.
 *
 * All interpolated text (claim text, quotes, titles, entity names) originates
 * from model output and is therefore untrusted: it goes through `escapeHtml`
 * without exception.
 */

import type { Citation, Claim, ClaimGroup, ReconciledProfile, SourceRef } from "./contract.js";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five characters that can break out of HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** A source's display label and anchor, derived from its position in the manifest. */
export interface SourceLabel {
  /** Marker text without brackets, e.g. `S1`. */
  label: string;
  /** Fragment id of this source's entry in the Sources list. */
  anchor: string;
  source: SourceRef;
}

/** Source manifest keyed by source id. */
export type SourceIndex = Map<string, SourceLabel>;

/** The flat claims list keyed by claim id. */
export type ClaimIndex = Map<string, Claim>;

/** Everything the section renderers need to resolve ids into text. */
interface RenderContext {
  claims: ClaimIndex;
  sources: SourceIndex;
}

/** One resolved entry of a group's `claimIds`. */
interface GroupMember {
  id: string;
  claim: Claim | undefined;
}

/** `S1`-style label for the source at `position` in the manifest. */
function labelAt(position: number): string {
  return `S${position + 1}`;
}

/** Fragment id of a source's entry in the Sources list. */
function anchorOf(sourceId: string): string {
  return `source-${sourceId}`;
}

/**
 * Indexes the source manifest by id so citations resolve in one pass.
 *
 * Labels follow manifest order, so `[S1]` is always the first listed source. If a
 * document repeats an id the first entry wins; the schema does not forbid it, and
 * the renderer must not throw on input it merely finds odd.
 */
export function buildSourceIndex(sources: readonly SourceRef[]): SourceIndex {
  const index: SourceIndex = new Map();
  sources.forEach((source, position) => {
    if (index.has(source.id)) return;
    index.set(source.id, {
      label: labelAt(position),
      anchor: anchorOf(source.id),
      source,
    });
  });
  return index;
}

/** Indexes the flat claims list by id. First entry wins on a duplicate id. */
function buildClaimIndex(claims: readonly Claim[]): ClaimIndex {
  const index: ClaimIndex = new Map();
  for (const claim of claims) {
    if (!index.has(claim.id)) index.set(claim.id, claim);
  }
  return index;
}

/** Human-readable description of a source, used in link tooltips. */
function sourceSummary(source: SourceRef): string {
  return `${source.id} · ${source.date} · ${source.title}`;
}

/**
 * One inline citation marker per citation, in the claim's own citation order.
 *
 * A citation naming a source that is not in the manifest renders as `[?]` rather
 * than as a dead link — that combination is a validator failure (issue #4), and
 * the page should show it instead of hiding it behind a broken anchor.
 */
function renderCitationMarkers(citations: readonly Citation[], ctx: RenderContext): string {
  const markers = citations.map((citation) => {
    const entry = ctx.sources.get(citation.sourceId);
    if (entry === undefined) {
      const unknown = escapeHtml(`Unknown source: ${citation.sourceId}`);
      return `<span class="cite cite-unknown" title="${unknown}">[?]</span>`;
    }
    const title = escapeHtml(sourceSummary(entry.source));
    const href = escapeHtml(`#${entry.anchor}`);
    const label = escapeHtml(entry.label);
    return `<a class="cite" href="${href}" title="${title}">[${label}]</a>`;
  });
  return `<span class="cites">${markers.join("")}</span>`;
}

/** The verbatim spans behind a claim, one list item per citation. */
function renderEvidence(citations: readonly Citation[], ctx: RenderContext): string[] {
  const lines = ['<ul class="evidence">'];
  for (const citation of citations) {
    const entry = ctx.sources.get(citation.sourceId);
    let tag = "?";
    let where = citation.sourceId;
    if (entry !== undefined) {
      tag = entry.label;
      where = sourceSummary(entry.source);
    }
    const quote = escapeHtml(citation.quote);
    lines.push(`<li><span class="tag">${escapeHtml(tag)}</span><q>${quote}</q>`);
    lines.push(`<span class="where">${escapeHtml(where)}</span></li>`);
  }
  lines.push("</ul>");
  return lines;
}

/** Sources cited by one claim, in citation order, as `Title (date)` text. */
function citedSourceTitles(citations: readonly Citation[], ctx: RenderContext): string {
  const seen: string[] = [];
  for (const citation of citations) {
    const entry = ctx.sources.get(citation.sourceId);
    let text = `${citation.sourceId} (not in manifest)`;
    if (entry !== undefined) {
      text = `${entry.source.title} (${entry.source.date})`;
    }
    if (!seen.includes(text)) seen.push(text);
  }
  return seen.join("; ");
}

/** Placeholder for a `claimIds` entry with no matching claim in the document. */
function renderMissingClaim(claimId: string): string {
  const id = escapeHtml(claimId);
  return `<p class="missing">Claim <code>${id}</code> is listed by this group but is missing from the claims list.</p>`;
}

/** Resolves a group's `claimIds` against the flat claims list, order preserved. */
function membersOf(group: ClaimGroup, ctx: RenderContext): GroupMember[] {
  return group.claimIds.map((id) => {
    return { id, claim: ctx.claims.get(id) };
  });
}

/** One agreed claim: the sentence, its markers, and the spans behind them. */
function renderAgreedClaim(claim: Claim, ctx: RenderContext): string[] {
  const markers = renderCitationMarkers(claim.citations, ctx);
  return [
    '<li class="claim">',
    `<p class="claim-text">${escapeHtml(claim.text)} ${markers}</p>`,
    ...renderEvidence(claim.citations, ctx),
    "</li>",
  ];
}

/** One position in a dispute: which sources say it, what they say, and the spans. */
function renderPosition(claim: Claim, ctx: RenderContext): string[] {
  const markers = renderCitationMarkers(claim.citations, ctx);
  const titles = escapeHtml(citedSourceTitles(claim.citations, ctx));
  return [
    '<li class="position">',
    `<p class="position-head">${markers}<span class="position-sources">${titles}</span></p>`,
    `<p class="claim-text">${escapeHtml(claim.text)}</p>`,
    ...renderEvidence(claim.citations, ctx),
    "</li>",
  ];
}

function renderAgreedGroup(group: ClaimGroup, ctx: RenderContext): string[] {
  const anchor = escapeHtml(`group-${group.id}`);
  const lines = [
    `<article class="group" id="${anchor}">`,
    `<h3 class="question">${escapeHtml(group.question)}</h3>`,
    '<ul class="claims">',
  ];
  for (const member of membersOf(group, ctx)) {
    if (member.claim === undefined) {
      lines.push(`<li class="claim">${renderMissingClaim(member.id)}</li>`);
      continue;
    }
    lines.push(...renderAgreedClaim(member.claim, ctx));
  }
  lines.push("</ul>", "</article>");
  return lines;
}

function renderDisputedGroup(group: ClaimGroup, ctx: RenderContext): string[] {
  const members = membersOf(group, ctx);
  const count = `${members.length} positions are on record for this question.`;
  const anchor = escapeHtml(`group-${group.id}`);
  const lines = [
    `<article class="group dispute" id="${anchor}">`,
    '<p class="dispute-flag">Sources conflict</p>',
    `<h3 class="question">${escapeHtml(group.question)}</h3>`,
    `<p class="dispute-note">${escapeHtml(count)} ${escapeHtml(DISPUTE_NOTE)}</p>`,
    '<ul class="positions">',
  ];
  for (const member of members) {
    if (member.claim === undefined) {
      lines.push(`<li class="position">${renderMissingClaim(member.id)}</li>`);
      continue;
    }
    lines.push(...renderPosition(member.claim, ctx));
  }
  lines.push("</ul>", "</article>");
  return lines;
}

/** `1 question` / `3 questions` — avoids a stray plural in the section headings. */
function countLabel(count: number, singular: string): string {
  if (count === 1) return `${count} ${singular}`;
  return `${count} ${singular}s`;
}

function renderSection(
  id: string,
  heading: string,
  count: string,
  blurb: string,
  body: string[],
): string[] {
  return [
    `<section id="${escapeHtml(id)}">`,
    `<h2>${escapeHtml(heading)} <span class="count">${escapeHtml(count)}</span></h2>`,
    `<p class="blurb">${escapeHtml(blurb)}</p>`,
    ...body,
    "</section>",
  ];
}

function renderEmpty(message: string): string[] {
  return [`<p class="empty">${escapeHtml(message)}</p>`];
}

function renderAgreedBody(groups: readonly ClaimGroup[], ctx: RenderContext): string[] {
  if (groups.length === 0) return renderEmpty("No agreed questions in this profile.");
  return groups.flatMap((group) => renderAgreedGroup(group, ctx));
}

function renderDisputedBody(groups: readonly ClaimGroup[], ctx: RenderContext): string[] {
  if (groups.length === 0) return renderEmpty(NO_DISPUTES);
  return groups.flatMap((group) => renderDisputedGroup(group, ctx));
}

function renderSources(sources: readonly SourceRef[]): string[] {
  const lines = ['<ol class="sources">'];
  sources.forEach((source, position) => {
    lines.push(`<li id="${escapeHtml(anchorOf(source.id))}">`);
    lines.push(`<span class="tag">${escapeHtml(labelAt(position))}</span>`);
    lines.push(`<span class="src-id">${escapeHtml(source.id)}</span>`);
    lines.push(`<span class="src-date">${escapeHtml(source.date)}</span>`);
    lines.push(`<span class="src-title">${escapeHtml(source.title)}</span>`);
    lines.push("</li>");
  });
  lines.push("</ol>");
  return lines;
}

function renderHeader(profile: ReconciledProfile, agreed: number, disputed: number): string[] {
  const aliases = profile.entity.aliases ?? [];
  const lines = [
    "<header>",
    '<p class="kicker">Cited profile · agreement and dispute kept apart</p>',
    `<h1>${escapeHtml(profile.entity.name)}</h1>`,
  ];
  if (aliases.length > 0) {
    const rendered = aliases.map((alias) => {
      return `<span class="alias">${escapeHtml(alias)}</span>`;
    });
    lines.push(`<p class="aliases">also called ${rendered.join("")}</p>`);
  }
  const model = profile.model ?? "none (hand-written document)";
  const questions = `${agreed} agreed, ${disputed} disputed`;
  lines.push('<dl class="meta">');
  lines.push(`<dt>Reconciled</dt><dd>${escapeHtml(profile.generatedAt)}</dd>`);
  lines.push(`<dt>Model</dt><dd>${escapeHtml(model)}</dd>`);
  lines.push(`<dt>Contract</dt><dd>${escapeHtml(profile.schemaVersion)}</dd>`);
  lines.push(`<dt>Sources</dt><dd>${escapeHtml(String(profile.sources.length))}</dd>`);
  lines.push(`<dt>Claims</dt><dd>${escapeHtml(String(profile.claims.length))}</dd>`);
  lines.push(`<dt>Questions</dt><dd>${escapeHtml(questions)}</dd>`);
  lines.push("</dl>");
  lines.push('<nav><a href="#agreed">Agreed</a><a href="#disputed">Disputed</a>');
  lines.push('<a href="#sources">Sources</a></nav>');
  lines.push("</header>");
  return lines;
}

/**
 * Page styles, inlined.
 *
 * The page is opened straight off disk during the demo, so it may not load a
 * single external byte: no CDN stylesheet, no web font, no image, no script.
 */
const STYLE = [
  ":root { --bg: #f6f7f9; --card: #ffffff; --ink: #16191d; --muted: #5b6472;",
  "  --line: #d9dee6; --agree: #1c7c4a; --dispute: #b3341f; --accent: #274b8f;",
  "  --dispute-bg: #fdf3f1; }",
  "@media (prefers-color-scheme: dark) {",
  "  :root { --bg: #14171b; --card: #1c2026; --ink: #eceff3; --muted: #9aa4b2;",
  "    --line: #2f3641; --agree: #4cc38a; --dispute: #ff8b6b; --accent: #8fb0ef;",
  "    --dispute-bg: #241d1c; }",
  "}",
  "* { box-sizing: border-box; }",
  "body { margin: 0; padding: 2rem 1rem 3rem; background: var(--bg); color: var(--ink);",
  "  font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial,",
  "  sans-serif; }",
  "main { max-width: 60rem; margin: 0 auto; }",
  "header { margin-bottom: 2.5rem; }",
  ".kicker { margin: 0; font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase;",
  "  color: var(--muted); }",
  "h1 { margin: 0.2rem 0 0.4rem; font-size: 2rem; line-height: 1.2; }",
  ".aliases { margin: 0 0 1rem; color: var(--muted); font-size: 0.9rem; }",
  ".alias { margin-left: 0.4rem; padding: 0.05rem 0.5rem; border: 1px solid var(--line);",
  "  border-radius: 999px; }",
  ".meta { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0;",
  "  padding: 0.9rem 1rem; background: var(--card); border: 1px solid var(--line);",
  "  border-radius: 8px; font-size: 0.85rem; }",
  ".meta dt { color: var(--muted); }",
  ".meta dd { margin: 0; }",
  "nav { margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }",
  "nav a { padding: 0.3rem 0.8rem; border: 1px solid var(--line); border-radius: 999px;",
  "  background: var(--card); color: var(--accent); text-decoration: none; font-size: 0.85rem; }",
  "section { margin-bottom: 3rem; }",
  "h2 { margin: 0 0 0.2rem; font-size: 1.35rem; }",
  "h2 .count { font-size: 0.8rem; font-weight: 400; color: var(--muted); }",
  ".blurb { margin: 0 0 1.2rem; color: var(--muted); font-size: 0.9rem; max-width: 46rem; }",
  "#agreed h2 { color: var(--agree); }",
  "#disputed h2 { color: var(--dispute); }",
  ".group { margin-bottom: 1.2rem; padding: 1rem 1.1rem; background: var(--card);",
  "  border: 1px solid var(--line); border-left: 4px solid var(--agree); border-radius: 8px; }",
  ".group.dispute { border-left-color: var(--dispute); }",
  ".question { margin: 0 0 0.6rem; font-size: 1.05rem; }",
  ".dispute-flag { margin: 0 0 0.35rem; font-size: 0.7rem; letter-spacing: 0.1em;",
  "  text-transform: uppercase; color: var(--dispute); font-weight: 700; }",
  ".dispute-note { margin: 0 0 0.9rem; color: var(--muted); font-size: 0.85rem; }",
  ".claims { list-style: none; margin: 0; padding: 0; }",
  ".claims > .claim + .claim { margin-top: 0.9rem; padding-top: 0.9rem;",
  "  border-top: 1px dashed var(--line); }",
  ".claim-text { margin: 0 0 0.4rem; }",
  ".positions { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.9rem;",
  "  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); align-items: start; }",
  ".position { padding: 0.8rem 0.9rem; border: 1px solid var(--line); border-radius: 6px;",
  "  background: var(--dispute-bg); }",
  ".position-head { margin: 0 0 0.45rem; display: flex; flex-wrap: wrap; align-items: baseline;",
  "  gap: 0.4rem; }",
  ".position-sources { color: var(--muted); font-size: 0.8rem; }",
  ".position .claim-text { font-weight: 600; }",
  ".cites { white-space: nowrap; }",
  ".cite { color: var(--accent); text-decoration: none; font-size: 0.8rem; font-weight: 700;",
  "  vertical-align: super; }",
  ".cite:hover { text-decoration: underline; }",
  ".cite-unknown { color: var(--dispute); }",
  ".evidence { list-style: none; margin: 0; padding: 0; font-size: 0.85rem; }",
  ".evidence li { margin-top: 0.3rem; }",
  ".evidence .where { display: block; color: var(--muted); font-size: 0.75rem;",
  "  padding-left: 2.3rem; }",
  ".tag { display: inline-block; min-width: 1.9rem; margin-right: 0.4rem; padding: 0 0.35rem;",
  "  border-radius: 4px; background: var(--accent); color: var(--card); font-size: 0.7rem;",
  "  font-weight: 700; text-align: center; letter-spacing: 0.04em; }",
  ".sources { margin: 0; padding: 0; list-style: none; }",
  ".sources li { padding: 0.6rem 0.8rem; margin-bottom: 0.5rem; background: var(--card);",
  "  border: 1px solid var(--line); border-radius: 6px; }",
  ".sources li:target { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }",
  ".src-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
  "  font-size: 0.8rem; color: var(--muted); margin-right: 0.5rem; }",
  ".src-date { color: var(--muted); font-size: 0.8rem; margin-right: 0.5rem; }",
  ".src-title { font-weight: 600; }",
  ".empty { margin: 0; padding: 0.9rem 1rem; background: var(--card);",
  "  border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }",
  ".missing { margin: 0; color: var(--dispute); font-size: 0.9rem; }",
  "footer { max-width: 60rem; margin: 0 auto; padding-top: 1rem; color: var(--muted);",
  "  font-size: 0.8rem; border-top: 1px solid var(--line); }",
];

const AGREED_BLURB =
  "Questions the sources answer consistently. Every claim is followed by the sources supporting it; the markers link to the Sources list below.";

const DISPUTED_BLURB =
  "Questions the sources answer differently. Each position sits side by side with the verbatim span it rests on, so the disagreement stays visible in the output.";

const SOURCES_BLURB =
  "Every document supplied to this reconciliation run. Citation markers throughout the page link here.";

const DISPUTE_NOTE =
  "They are shown side by side exactly as reported — nothing here is merged, averaged, or resolved.";

const NO_DISPUTES =
  "No disputed questions in this profile — the sources did not contradict each other.";

const FOOTER =
  "Rendered deterministically from the reconciled-profile JSON: no model call and no clock read, so the same document always produces the same page.";

/**
 * Renders a profile document as one self-contained HTML page.
 *
 * Pure: the output depends only on `profile`. Callers that want the page on disk
 * write the returned string themselves (see `scripts/render-profile.ts`).
 */
export function renderProfileHtml(profile: ReconciledProfile): string {
  const ctx: RenderContext = {
    claims: buildClaimIndex(profile.claims),
    sources: buildSourceIndex(profile.sources),
  };

  const agreed = profile.groups.filter((group) => group.status === "agreed");
  const disputed = profile.groups.filter((group) => group.status === "disputed");
  const title = `${profile.entity.name} — cited profile`;

  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    ...STYLE,
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    ...renderHeader(profile, agreed.length, disputed.length),
    ...renderSection(
      "agreed",
      "Agreed",
      countLabel(agreed.length, "question"),
      AGREED_BLURB,
      renderAgreedBody(agreed, ctx),
    ),
    ...renderSection(
      "disputed",
      "Disputed",
      countLabel(disputed.length, "question"),
      DISPUTED_BLURB,
      renderDisputedBody(disputed, ctx),
    ),
    ...renderSection(
      "sources",
      "Sources",
      countLabel(profile.sources.length, "document"),
      SOURCES_BLURB,
      renderSources(profile.sources),
    ),
    "</main>",
    `<footer>${escapeHtml(FOOTER)}</footer>`,
    "</body>",
    "</html>",
  ];

  return `${lines.join("\n")}\n`;
}
