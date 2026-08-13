import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { escapeHtml, renderProfileHtml } from "../src/render.js";
import { readJsonFile } from "../src/schema.js";
import type { ReconciledProfile } from "../src/contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = join(repoRoot, "examples", "reconciled-profile.example.json");
const exampleProfile = readJsonFile(profilePath) as ReconciledProfile;

const html = renderProfileHtml(exampleProfile);

/** The markup of one top-level `<section id="...">…</section>` block. */
function sectionOf(page: string, id: string): string {
  const start = page.indexOf(`<section id="${id}">`);
  expect(start, `page has no section "${id}"`).toBeGreaterThanOrEqual(0);
  const end = page.indexOf("</section>\n<section id=", start);
  return end === -1 ? page.slice(start) : page.slice(start, end);
}

describe("renderProfileHtml on the committed example profile", () => {
  it("shows the disputed group's question and BOTH conflicting claims in Disputed", () => {
    const disputed = sectionOf(html, "disputed");
    expect(disputed).toContain("When was the Nimbus Cartography Collective founded?");
    expect(disputed).toContain("The Nimbus Cartography Collective was founded in 2011.");
    expect(disputed).toContain("The Nimbus Cartography Collective began operations in early 2012.");
  });

  it("keeps agreed claims out of the Disputed section and in Agreed", () => {
    const agreed = sectionOf(html, "agreed");
    expect(agreed).toContain("The Nimbus Cartography Collective is based in Rotterdam.");
    expect(sectionOf(html, "disputed")).not.toContain("Rotterdam");
  });

  it("renders every claim with at least one citation marker", () => {
    // Each rendered claim line/card carries the [src-…] markers of its citations.
    for (const claim of exampleProfile.claims) {
      const index = html.indexOf(escapeHtml(claim.text));
      expect(index, `claim "${claim.id}" is not rendered`).toBeGreaterThanOrEqual(0);
      for (const citation of claim.citations) {
        const following = html.slice(index, index + 600);
        expect(following).toContain(`href="#source-${citation.sourceId}"`);
      }
    }
  });

  it("shows one marker per supporting source on a multi-source claim", () => {
    const agreed = sectionOf(html, "agreed");
    const line = agreed.split("\n").find((l) => l.includes("based in Rotterdam"))!;
    expect(line).toContain(">[src-01]</a>");
    expect(line).toContain(">[src-02]</a>");
  });

  it("links every citation marker to an existing anchor in Sources", () => {
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(html).toContain(`id="${target}"`);
    }
  });

  it("lists id, date, and title for every source", () => {
    const sources = sectionOf(html, "sources");
    for (const source of exampleProfile.sources) {
      expect(sources).toContain(`id="source-${source.id}"`);
      expect(sources).toContain(source.date);
      expect(sources).toContain(escapeHtml(source.title));
    }
  });

  it("shows the profile's own generatedAt, entity name, and aliases", () => {
    expect(html).toContain("Generated 2026-08-13T09:30:00Z");
    expect(html).toContain("<h1>Nimbus Cartography Collective</h1>");
    expect(html).toContain("Nimbus, the Nimbus Collective");
  });

  it("is a pure function: two renders are byte-identical", () => {
    const again = renderProfileHtml(readJsonFile(profilePath) as ReconciledProfile);
    expect(Buffer.from(again).equals(Buffer.from(html))).toBe(true);
  });

  it("makes no external requests: no src/href pointing off the page", () => {
    const urls = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    for (const url of urls) {
      expect(url.startsWith("#")).toBe(true);
    }
    expect(html).not.toContain("<script");
  });
});

describe("escaping of untrusted profile strings", () => {
  const hostile: ReconciledProfile = {
    schemaVersion: "1.0.0",
    entity: { name: 'Evil & Co <b>"bold"</b>', aliases: ["<i>sly</i>"] },
    generatedAt: "2026-08-13T00:00:00Z",
    sources: [{ id: "src-01", date: "2026-01-01", title: "<script>alert(2)</script>" }],
    claims: [
      {
        id: "c1",
        text: "<script>alert(1)</script>",
        citations: [{ sourceId: "src-01", quote: '"><img src=x onerror=alert(3)>' }],
      },
      {
        id: "c2",
        text: "It is 'fine'",
        citations: [{ sourceId: "src-01", quote: "fine" }],
      },
    ],
    groups: [
      { id: "g1", question: "Is <script> escaped?", status: "disputed", claimIds: ["c1", "c2"] },
    ],
  };
  const page = renderProfileHtml(hostile);

  it("never emits profile-supplied markup verbatim", () => {
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).not.toContain("<script>alert(2)</script>");
    expect(page).not.toContain("<img src=x");
    expect(page).not.toContain("<i>sly</i>");
    expect(page).not.toContain("<b>");
  });

  it("renders the hostile text as escaped entities instead", () => {
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("&quot;&gt;&lt;img src=x onerror=alert(3)&gt;");
    expect(page).toContain("Evil &amp; Co &lt;b&gt;&quot;bold&quot;&lt;/b&gt;");
    expect(page).toContain("Is &lt;script&gt; escaped?");
  });
});

describe("the render CLI", () => {
  const scratch = mkdtempSync(join(tmpdir(), "render-cli-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function runCli(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", join(repoRoot, "scripts", "render.ts"), ...args],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, stderr: "" };
    } catch (error) {
      const failure = error as { status: number | null; stderr: Buffer };
      return { status: failure.status ?? 1, stderr: failure.stderr.toString() };
    }
  }

  it("renders a valid profile to the requested file, byte-equal to the library", () => {
    const out = join(scratch, "profile.html");
    const result = runCli([profilePath, "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(html);
  });

  it("refuses a schema-invalid profile with a non-zero exit and writes nothing", () => {
    const invalid = join(scratch, "invalid.json");
    const broken = structuredClone(exampleProfile) as unknown as Record<string, unknown>;
    delete broken.groups;
    writeFileSync(invalid, JSON.stringify(broken), "utf8");

    const out = join(scratch, "invalid.html");
    const result = runCli([invalid, "--out", out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not validate");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses malformed JSON with a non-zero exit", () => {
    const malformed = join(scratch, "malformed.json");
    writeFileSync(malformed, '{"schemaVersion": "1.0.0",}', "utf8");
    const result = runCli([malformed, "--out", join(scratch, "malformed.html")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("prints usage and exits non-zero when --out is missing", () => {
    const result = runCli([profilePath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage:");
  });
});
