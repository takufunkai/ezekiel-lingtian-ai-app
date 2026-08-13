import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { escapeHtml, renderProfileHtml } from "../src/render.js";
import { formatSchemaErrors, readJsonFile, validateProfile } from "../src/schema.js";
import { SCHEMA_VERSION, type Claim, type ReconciledProfile } from "../src/contract.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "renderer");

/** Hand-written profile documents, standing in for engine output (see PR notes). */
const FIXTURES = ["founding-date-dispute.profile.json", "hostile-text.profile.json"];

const DISPUTE_FIXTURE = "founding-date-dispute.profile.json";
const HOSTILE_FIXTURE = "hostile-text.profile.json";

/** Loads a fixture, failing loudly if it has drifted out of contract. */
function loadFixture(name: string): ReconciledProfile {
  const result = validateProfile(readJsonFile(join(fixturesDir, name)));
  if (!result.valid) {
    throw new Error(`${name}: ${formatSchemaErrors(result.errors).join("; ")}`);
  }
  return result.data;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every capture group 1 of `pattern` across `html`. */
function captures(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** The markup of one top-level section, so a claim can be located precisely. */
function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}">`);
  expect(start, `no <section id="${id}"> in the page`).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

/** How many citation markers the document should produce, counted from the JSON. */
function expectedMarkerCount(profile: ReconciledProfile): number {
  const byId = new Map(profile.claims.map((claim) => [claim.id, claim] as const));
  let total = 0;
  for (const group of profile.groups) {
    for (const id of group.claimIds) {
      total += byId.get(id)?.citations.length ?? 0;
    }
  }
  return total;
}

const BASE: ReconciledProfile = {
  schemaVersion: SCHEMA_VERSION,
  entity: { name: "Base Entity" },
  generatedAt: "2026-01-02T03:04:05Z",
  sources: [
    {
      id: "src-01",
      date: "2026-01-01",
      title: "First source",
    },
    {
      id: "src-02",
      date: "2026-01-02",
      title: "Second source",
    },
  ],
  claims: [
    {
      id: "c1",
      text: "The entity exists.",
      citations: [
        {
          sourceId: "src-01",
          quote: "the entity exists",
        },
      ],
    },
    {
      id: "c2",
      text: "The entity does not exist.",
      citations: [
        {
          sourceId: "src-02",
          quote: "no such entity",
        },
      ],
    },
  ],
  groups: [
    {
      id: "g1",
      question: "Does the entity exist?",
      status: "disputed",
      claimIds: ["c1", "c2"],
    },
    {
      id: "g2",
      question: "Is the entity documented?",
      status: "agreed",
      claimIds: ["c1"],
    },
  ],
};

/** A copy of `BASE` with one deliberate change. Never mutates the shared base. */
function variant(change: (profile: ReconciledProfile) => void): ReconciledProfile {
  const copy = structuredClone(BASE);
  change(copy);
  return copy;
}

describe("the renderer's own fixtures satisfy the contract", () => {
  it.each(FIXTURES)("%s matches claims.schema.json", (name) => {
    const result = validateProfile(readJsonFile(join(fixturesDir, name)));
    expect(formatSchemaErrors(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("the renderer is a pure function of the JSON", () => {
  it.each(FIXTURES)("%s renders byte-identically twice in a row", (name) => {
    const profile = loadFixture(name);
    expect(renderProfileHtml(profile)).toBe(renderProfileHtml(profile));
  });

  it.each(FIXTURES)("%s renders identically from an independent copy", (name) => {
    const profile = loadFixture(name);
    const clone = structuredClone(profile);
    expect(renderProfileHtml(clone)).toBe(renderProfileHtml(profile));
  });

  it("shows the document's own generatedAt rather than reading a clock", () => {
    const html = renderProfileHtml(BASE);
    expect(html).toContain("2026-01-02T03:04:05Z");
  });
});

describe("the page is a single self-contained file", () => {
  const html = renderProfileHtml(loadFixture(DISPUTE_FIXTURE));

  it("starts with a doctype and ends with a closing html tag", () => {
    expect(html.startsWith("<!doctype html>\n")).toBe(true);
    expect(html.endsWith("</html>\n")).toBe(true);
  });

  it("inlines its styles instead of linking a stylesheet", () => {
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("@import");
  });

  it("loads no external byte and runs no script", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("url(");
  });

  it("orders the sections agreed, disputed, sources", () => {
    const agreed = html.indexOf('<section id="agreed">');
    const disputed = html.indexOf('<section id="disputed">');
    const sources = html.indexOf('<section id="sources">');
    expect(agreed).toBeGreaterThan(-1);
    expect(agreed).toBeLessThan(disputed);
    expect(disputed).toBeLessThan(sources);
  });
});

describe("every claim carries citations that jump to a source", () => {
  const profile = loadFixture(DISPUTE_FIXTURE);
  const html = renderProfileHtml(profile);

  it("renders one marker per citation, across both sections", () => {
    expect(countOf(html, '<a class="cite"')).toBe(expectedMarkerCount(profile));
  });

  it("labels sources by manifest position, so [S1] is the first source", () => {
    expect(html).toContain('<a class="cite" href="#source-src-01"');
    expect(html).toContain(">[S1]</a>");
    expect(html).toContain(">[S3]</a>");
    expect(html).not.toContain(">[S4]</a>");
  });

  it("gives every source an anchor target with its id, date, and title", () => {
    const sources = sectionOf(html, "sources");
    for (const source of profile.sources) {
      expect(sources).toContain(`<li id="source-${source.id}">`);
      expect(sources).toContain(escapeHtml(source.id));
      expect(sources).toContain(escapeHtml(source.date));
      expect(sources).toContain(escapeHtml(source.title));
    }
  });

  it("leaves no dangling fragment link anywhere on the page", () => {
    const ids = captures(html, /\bid="([^"]+)"/g);
    const targets = captures(html, /href="#([^"]+)"/g);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(ids, `nothing on the page has id="${target}"`).toContain(target);
    }
  });

  it("uses each anchor id exactly once", () => {
    const ids = captures(html, /\bid="([^"]+)"/g);
    expect([...new Set(ids)].length).toBe(ids.length);
  });

  it("shows the verbatim span behind each citation", () => {
    for (const claim of profile.claims) {
      for (const citation of claim.citations) {
        expect(html).toContain(`<q>${escapeHtml(citation.quote)}</q>`);
      }
    }
  });
});

describe("the Agreed section", () => {
  const profile = loadFixture(DISPUTE_FIXTURE);
  const agreed = sectionOf(renderProfileHtml(profile), "agreed");

  it("holds every agreed group's question and claims", () => {
    const groups = profile.groups.filter((group) => group.status === "agreed");
    expect(groups.length).toBe(3);
    const byId = new Map(profile.claims.map((claim) => [claim.id, claim] as const));
    for (const group of groups) {
      expect(agreed).toContain(escapeHtml(group.question));
      for (const id of group.claimIds) {
        const claim = byId.get(id) as Claim;
        expect(agreed).toContain(escapeHtml(claim.text));
      }
    }
  });

  it("keeps the disputed claims out of it", () => {
    expect(agreed).not.toContain("was founded in 1994");
    expect(agreed).not.toContain("began operations in 1996");
  });

  it("counts a claim's several supporting sources as several markers", () => {
    expect(agreed).toContain(">[S1]</a>");
    expect(agreed).toContain(">[S2]</a>");
    expect(agreed).toContain(">[S3]</a>");
  });
});

describe("the Disputed section surfaces the founding-date conflict", () => {
  const profile = loadFixture(DISPUTE_FIXTURE);
  const html = renderProfileHtml(profile);
  const disputed = sectionOf(html, "disputed");

  it("renders the dispute as the underlying question", () => {
    expect(disputed).toContain("When was Meridian Aerostat Works founded?");
    expect(disputed).toContain("Sources conflict");
  });

  it("shows all three conflicting answers side by side, none dropped", () => {
    expect(countOf(disputed, '<li class="position">')).toBe(3);
    expect(disputed).toContain("was founded in 1994.");
    expect(disputed).toContain("began operations in 1996.");
    expect(disputed).toContain("was incorporated in December 1993.");
  });

  it("attributes each position to the source that holds it", () => {
    expect(disputed).toContain("Meridian Aerostat Works: Twenty-Five Years Aloft (2019-05-04)");
    expect(disputed).toContain("The Balloon Builders of Bergen (2021-11-12)");
    expect(disputed).toContain("Company Register Extract (2023-02-28)");
  });

  it("states outright that nothing was merged or resolved", () => {
    expect(disputed).toContain("3 positions are on record");
    expect(disputed).toContain("nothing here is merged, averaged, or resolved");
  });

  it("does not smuggle the dispute into the agreed section", () => {
    const agreed = sectionOf(html, "agreed");
    expect(agreed).not.toContain("When was Meridian Aerostat Works founded?");
  });
});

describe("untrusted text is escaped, never interpolated raw", () => {
  const html = renderProfileHtml(loadFixture(HOSTILE_FIXTURE));

  it("escapes markup in claim text, quotes, titles, and the entity name", () => {
    expect(html).toContain("Skjold &amp; Vaerft &lt;Aerostat Division&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).toContain("&quot;S&amp;V&quot;");
    expect(html).toContain("1990 &lt;presumed&gt;");
  });

  it("leaves no raw tag from the data in the output", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<presumed>");
    expect(html).not.toContain("<Aerostat");
  });

  it("emits only known entities, so no stray ampersand survives", () => {
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
  });

  it("escapes the attribute values it builds, not just the text", () => {
    expect(html).toContain("the founder&#39;s own account");
    expect(html).not.toMatch(/title="[^"]*&quot;[^"]*"[^>]*[a-z]=/);
  });

  it("escapes each character exactly once", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("<i>")).toBe("&lt;i&gt;");
    expect(escapeHtml('"q"')).toBe("&quot;q&quot;");
    expect(escapeHtml("it's")).toBe("it&#39;s");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("degenerate documents render rather than throw", () => {
  it("says so when nothing is disputed", () => {
    const profile = variant((copy) => {
      copy.groups = copy.groups.filter((group) => group.status === "agreed");
    });
    const html = renderProfileHtml(profile);
    expect(html).toContain("No disputed questions in this profile");
    expect(html).toContain("0 questions");
  });

  it("says so when nothing is agreed", () => {
    const profile = variant((copy) => {
      copy.groups = copy.groups.filter((group) => group.status === "disputed");
    });
    const html = renderProfileHtml(profile);
    expect(html).toContain("No agreed questions in this profile.");
  });

  it("flags a group that names a claim the document does not contain", () => {
    const profile = variant((copy) => {
      copy.groups = [
        {
          id: "g1",
          question: "Where did the claim go?",
          status: "agreed",
          claimIds: ["nope"],
        },
      ];
    });
    const html = renderProfileHtml(profile);
    expect(html).toContain("<code>nope</code>");
    expect(html).toContain("is missing from the claims list.");
  });

  it("flags a citation naming a source outside the manifest", () => {
    const profile = variant((copy) => {
      const claim = copy.claims[0];
      expect(claim).toBeDefined();
      claim!.citations = [{ sourceId: "src-99", quote: "not from any listed source" }];
    });
    const html = renderProfileHtml(profile);
    expect(html).toContain("cite-unknown");
    expect(html).toContain("[?]");
    expect(html).toContain("Unknown source: src-99");
  });

  it("uses the singular for a single question or document", () => {
    const profile = variant((copy) => {
      copy.groups = copy.groups.filter((group) => group.status === "agreed");
      copy.sources = copy.sources.slice(0, 1);
    });
    const html = renderProfileHtml(profile);
    expect(html).toContain("1 question");
    expect(html).toContain("1 document");
  });

  it("renders the aliases the entity is also known by", () => {
    const profile = variant((copy) => {
      copy.entity.aliases = ["Alias One", "Alias Two"];
    });
    const html = renderProfileHtml(profile);
    expect(html).toContain("Alias One");
    expect(html).toContain("Alias Two");
  });
});

describe("the committed example profile renders", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const examplePath = join(repoRoot, "examples", "reconciled-profile.example.json");

  it("puts the example's founding-date dispute in the Disputed section", () => {
    const result = validateProfile(readJsonFile(examplePath));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const disputed = sectionOf(renderProfileHtml(result.data), "disputed");
    expect(disputed).toContain("When was the Nimbus Cartography Collective founded?");
    expect(countOf(disputed, '<li class="position">')).toBe(2);
  });
});
