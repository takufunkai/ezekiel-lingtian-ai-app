/**
 * Renders a validated `ReconciledProfile` to one self-contained HTML page.
 *
 * This is a pure function of the JSON: same input, byte-identical output. It
 * takes no clock (the page shows the profile's own `generatedAt`), uses no
 * randomness, and renders arrays in the order the profile declares them.
 *
 * Every string that originates in the profile — claim texts, quotes, titles,
 * ids, the entity name — is untrusted model output and is HTML-escaped before
 * it reaches the page. The page itself makes zero external requests: inline
 * CSS, no scripts, no fonts, no images.
 *
 * Referential integrity (every cited source exists, every quote is verbatim,
 * every claim is grouped) is the validator epic's job, not the renderer's.
 * The renderer trusts schema-valid input; a group's `claimIds` entry with no
 * matching claim is skipped deterministically.
 */

import type { Claim, ClaimGroup, ReconciledProfile, SourceRef } from "./contract.js";

/** Escapes the five HTML metacharacters. Safe for text nodes and attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The `id` attribute of a source's anchor in the Sources section. */
function sourceAnchor(sourceId: string): string {
  return `source-${sourceId}`;
}

/** One inline citation marker, e.g. `[src-01]`, linking to its source anchor. */
function citationMarker(sourceId: string): string {
  return `<a class="cite" href="#${escapeHtml(sourceAnchor(sourceId))}">[${escapeHtml(sourceId)}]</a>`;
}

function renderClaimLine(claim: Claim): string {
  const markers = claim.citations.map((citation) => citationMarker(citation.sourceId)).join(" ");
  return `<li class="claim">${escapeHtml(claim.text)} <span class="cites">${markers}</span></li>`;
}

function renderAgreedSection(groups: ClaimGroup[], claimsById: Map<string, Claim>): string {
  const lines: string[] = ['<section id="agreed">', "<h2>Agreed</h2>"];
  const items = groups
    .filter((group) => group.status === "agreed")
    .flatMap((group) => group.claimIds)
    .map((claimId) => claimsById.get(claimId))
    .filter((claim): claim is Claim => claim !== undefined)
    .map(renderClaimLine);
  if (items.length === 0) {
    lines.push('<p class="empty">The sources agree on nothing.</p>');
  } else {
    lines.push('<ul class="claims">', ...items, "</ul>");
  }
  lines.push("</section>");
  return lines.join("\n");
}

function renderDisputedClaimCard(claim: Claim): string {
  const citations = claim.citations
    .map(
      (citation) =>
        `<li>${citationMarker(citation.sourceId)} <q>${escapeHtml(citation.quote)}</q></li>`,
    )
    .join("\n");
  return [
    '<article class="position">',
    `<p class="claim-text">${escapeHtml(claim.text)}</p>`,
    `<ul class="quotes">\n${citations}\n</ul>`,
    "</article>",
  ].join("\n");
}

function renderDisputedSection(groups: ClaimGroup[], claimsById: Map<string, Claim>): string {
  const lines: string[] = ['<section id="disputed">', "<h2>Disputed</h2>"];
  const disputed = groups.filter((group) => group.status === "disputed");
  if (disputed.length === 0) {
    lines.push('<p class="empty">No disputes — every question has one answer.</p>');
  }
  for (const group of disputed) {
    const cards = group.claimIds
      .map((claimId) => claimsById.get(claimId))
      .filter((claim): claim is Claim => claim !== undefined)
      .map(renderDisputedClaimCard)
      .join("\n");
    lines.push(
      '<section class="dispute">',
      `<h3>${escapeHtml(group.question)}</h3>`,
      `<div class="conflict">\n${cards}\n</div>`,
      "</section>",
    );
  }
  lines.push("</section>");
  return lines.join("\n");
}

function renderSourcesSection(sources: SourceRef[]): string {
  const items = sources
    .map(
      (source) =>
        `<li id="${escapeHtml(sourceAnchor(source.id))}">` +
        `<code>[${escapeHtml(source.id)}]</code> ` +
        `<span class="date">${escapeHtml(source.date)}</span> — ` +
        `${escapeHtml(source.title)}</li>`,
    )
    .join("\n");
  return [
    '<section id="sources">',
    "<h2>Sources</h2>",
    `<ul class="sources">\n${items}\n</ul>`,
    "</section>",
  ].join("\n");
}

const STYLE = `
:root { color-scheme: light; }
body {
  margin: 0 auto;
  max-width: 46rem;
  padding: 2rem 1.25rem 4rem;
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.55;
  color: #1e2126;
  background: #fdfcfa;
}
header { border-bottom: 2px solid #1e2126; padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
h1 { margin: 0 0 0.25rem; font-size: 1.9rem; }
h2 {
  font-size: 0.95rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  font-family: system-ui, sans-serif;
  color: #5a5f66;
  margin: 2.25rem 0 0.75rem;
}
h3 { margin: 0 0 0.6rem; font-size: 1.05rem; }
.aliases { margin: 0; color: #5a5f66; font-style: italic; }
.meta { margin: 0.4rem 0 0; font-family: system-ui, sans-serif; font-size: 0.8rem; color: #5a5f66; }
ul.claims { padding-left: 1.2rem; margin: 0; }
ul.claims li { margin: 0.35rem 0; }
a.cite {
  font-family: system-ui, sans-serif;
  font-size: 0.75rem;
  text-decoration: none;
  color: #14507a;
  background: #e8f0f6;
  border-radius: 3px;
  padding: 0 0.25em;
  white-space: nowrap;
}
a.cite:hover { text-decoration: underline; }
section.dispute {
  border: 1px solid #d8a03a;
  border-left: 5px solid #d8a03a;
  background: #fdf6e8;
  border-radius: 4px;
  padding: 1rem 1.1rem;
  margin: 1rem 0;
}
.conflict { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0.75rem; }
article.position { background: #fff; border: 1px solid #e3d5b3; border-radius: 4px; padding: 0.7rem 0.85rem; }
.claim-text { margin: 0 0 0.5rem; font-weight: bold; }
ul.quotes { list-style: none; margin: 0; padding: 0; font-size: 0.9rem; }
ul.quotes li { margin: 0.3rem 0; }
ul.quotes q { color: #5a5f66; }
ul.sources { list-style: none; padding: 0; margin: 0; }
ul.sources li { margin: 0.45rem 0; }
ul.sources li:target { background: #e8f0f6; }
ul.sources code { font-size: 0.85rem; }
.date { font-family: system-ui, sans-serif; font-size: 0.85rem; color: #5a5f66; }
.empty { color: #5a5f66; font-style: italic; }
`.trim();

function renderHeader(profile: ReconciledProfile): string {
  const lines: string[] = ["<header>", `<h1>${escapeHtml(profile.entity.name)}</h1>`];
  const aliases = profile.entity.aliases ?? [];
  if (aliases.length > 0) {
    lines.push(`<p class="aliases">Also known as: ${aliases.map(escapeHtml).join(", ")}</p>`);
  }
  const modelSuffix = profile.model === undefined ? "" : ` by ${escapeHtml(profile.model)}`;
  lines.push(
    `<p class="meta">Generated ${escapeHtml(profile.generatedAt)}${modelSuffix}</p>`,
    "</header>",
  );
  return lines.join("\n");
}

/** Renders the complete HTML document for one reconciled profile. */
export function renderProfileHtml(profile: ReconciledProfile): string {
  const claimsById = new Map(profile.claims.map((claim) => [claim.id, claim]));
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(profile.entity.name)} — Cited Profile</title>`,
    `<style>\n${STYLE}\n</style>`,
    "</head>",
    "<body>",
    renderHeader(profile),
    "<main>",
    renderAgreedSection(profile.groups, claimsById),
    renderDisputedSection(profile.groups, claimsById),
    renderSourcesSection(profile.sources),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
