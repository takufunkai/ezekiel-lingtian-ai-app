/**
 * Tests for the local results browser, with the topic intake added.
 *
 * Two things here are worth explaining:
 *
 *   1. The page renders itself client-side from an inline script. The escaper and
 *      the markup builders are real functions in `scripts/results-ui.ts` that are
 *      serialised into that script with `String(fn)`, so these tests can call the
 *      exact code the browser runs — and one test asserts the page really does
 *      embed each of them, so the two cannot drift apart.
 *   2. Content under `gathered/` comes from web search results, so every test that
 *      renders it feeds hostile input: a title that closes a tag and opens a
 *      `<script>`, and a `javascript:` URL that must never reach an `href`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PAGE,
  answerTopic,
  checkTopic,
  createUiServer,
  escapeHtml,
  firstHttpUrlIn,
  gatherCommand,
  gatheredSetHtml,
  gatheredSourceHtml,
  listGatheredSets,
  notGatheredHtml,
  readGatheredSet,
  resolveGatheredDir,
  safeHttpUrl,
  slugifyTopic,
  sourceUrlHtml,
  type GatheredSetView,
  type GatheredSourceView,
} from "../scripts/results-ui.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A title that escapes its element and opens a script, as a search hit might. */
const HOSTILE_TITLE = `</b><script>alert("title")</script>`;
/** A URL whose scheme must never become a live link. */
const HOSTILE_URL = "javascript:alert(document.cookie)";
const SAFE_URL = "https://example.com/a?b=1&c=2";

function source(overrides: Partial<GatheredSourceView> = {}): GatheredSourceView {
  return {
    id: "src-01",
    date: "2026-01-01",
    title: "A plain title",
    text: "Body text.",
    url: null,
    rejectedUrl: null,
    error: null,
    ...overrides,
  };
}

function set(overrides: Partial<GatheredSetView> = {}): GatheredSetView {
  return {
    slug: "a-topic",
    topic: "A topic",
    entity: "An Entity",
    gatheredAt: "2026-08-13T00:00:00Z",
    declaredCount: -1,
    sources: [],
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Escaping and URL schemes
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes every character that can break out of markup or an attribute", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("neutralises a script-injecting title", () => {
    const escaped = escapeHtml(HOSTILE_TITLE);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("stringifies non-strings rather than throwing", () => {
    expect(escapeHtml(3)).toBe("3");
    expect(escapeHtml(null)).toBe("null");
  });
});

describe("safeHttpUrl", () => {
  it("accepts http and https URLs unchanged", () => {
    expect(safeHttpUrl(SAFE_URL)).toBe(SAFE_URL);
    expect(safeHttpUrl("http://example.org/x")).toBe("http://example.org/x");
    expect(safeHttpUrl("  https://example.org/x  ")).toBe("https://example.org/x");
  });

  it("rejects every other scheme and shape", () => {
    for (const bad of [
      HOSTILE_URL,
      "JavaScript:alert(1)",
      "\tjavascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "//evil.example.com/x",
      "/relative/path",
      "example.com",
      'https://evil.example.com/" onmouseover="alert(1)',
      "",
      null,
      undefined,
      { toString: () => SAFE_URL },
    ]) {
      expect(safeHttpUrl(bad), `should reject ${String(bad)}`).toBeNull();
    }
  });
});

describe("firstHttpUrlIn", () => {
  it("pulls a URL out of a document's notes and drops trailing punctuation", () => {
    expect(firstHttpUrlIn("retrieved from https://example.com/page.html.")).toBe(
      "https://example.com/page.html",
    );
  });

  it("finds nothing in notes with no URL, and never returns a hostile one", () => {
    expect(firstHttpUrlIn("no link here")).toBeNull();
    expect(firstHttpUrlIn(`see ${HOSTILE_URL}`)).toBeNull();
    expect(firstHttpUrlIn(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The markup builders the browser runs
// ---------------------------------------------------------------------------

describe("the page ships the builders these tests exercise", () => {
  const shipped = [
    escapeHtml,
    safeHttpUrl,
    sourceUrlHtml,
    gatheredSourceHtml,
    gatheredSetHtml,
    notGatheredHtml,
  ];

  it.each(shipped.map((fn) => [fn.name, fn] as const))(
    "%s is embedded verbatim in the served page",
    (_name, fn) => {
      expect(PAGE).toContain(String(fn));
    },
  );

  it("still serves one self-contained page with no external requests", () => {
    expect(PAGE).toContain("<!doctype html>");
    expect(PAGE).not.toMatch(/<script[^>]+src=/);
    expect(PAGE).not.toMatch(/<link[^>]+href=/);
  });
});

describe("sourceUrlHtml", () => {
  it("links a safe URL, escaping it inside the href", () => {
    const html = sourceUrlHtml(source({ url: SAFE_URL }));
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("never builds an href from a non-http scheme, even if one reaches the view", () => {
    const html = sourceUrlHtml(source({ url: HOSTILE_URL, rejectedUrl: HOSTILE_URL }));
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<a ");
    expect(html).toContain("URL not http(s)");
    // Kept as inert text inside <code>, so an operator can still see what came
    // back, but nothing in the page can navigate to it.
    expect(html).toContain(`<code class="url">${HOSTILE_URL}</code>`);
  });

  it("says so when a source has no URL at all", () => {
    expect(sourceUrlHtml(source())).toContain("no URL recorded");
  });
});

describe("gatheredSourceHtml", () => {
  it("escapes a hostile title and a hostile body", () => {
    const html = gatheredSourceHtml(
      source({
        title: HOSTILE_TITLE,
        text: `<iframe src="${HOSTILE_URL}"></iframe>`,
        url: HOSTILE_URL,
        rejectedUrl: HOSTILE_URL,
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;iframe");
  });

  it("shows title, date and text of a well-formed source", () => {
    const html = gatheredSourceHtml(source({ title: "Kopitiam opens", text: "It opened." }));
    expect(html).toContain("Kopitiam opens");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("It opened.");
  });

  it("flags a source that is off-contract without hiding it", () => {
    const html = gatheredSourceHtml(source({ error: "/date must match format" }));
    expect(html).toContain("off-contract");
    expect(html).toContain("/date must match format");
  });
});

describe("gatheredSetHtml", () => {
  it("escapes the topic and the entity name", () => {
    const html = gatheredSetHtml(
      set({ topic: HOSTILE_TITLE, entity: `<img src=x onerror="alert(1)">` }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("reports the count, the gather time and the directory", () => {
    const html = gatheredSetHtml(set({ sources: [source(), source({ id: "src-02" })] }));
    expect(html).toContain("2 sources");
    expect(html).toContain("2026-08-13T00:00:00Z");
    expect(html).toContain("gathered/a-topic/");
  });

  it("says plainly when a set has no source documents", () => {
    expect(gatheredSetHtml(set())).toContain("no source documents");
  });

  it("notes a manifest that claims more sources than are on disk", () => {
    const html = gatheredSetHtml(set({ declaredCount: 5, sources: [source()] }));
    expect(html).toContain("1 source (topic.json lists 5)");
  });
});

describe("notGatheredHtml", () => {
  const answer = {
    topic: HOSTILE_TITLE,
    slug: "b-script-alert-title-script",
    command: gatherCommand(HOSTILE_TITLE),
    keyEnvVar: "OPENCODE_API_KEY",
    hasKey: false,
  };

  it("prints the command to run and escapes the topic inside it", () => {
    const html = notGatheredHtml(answer);
    expect(html).toContain("npm run gather -- ");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("states that nothing was fetched", () => {
    expect(notGatheredHtml(answer)).toContain("never searches the web");
  });

  it("names the missing key when there is none", () => {
    expect(notGatheredHtml(answer)).toContain("OPENCODE_API_KEY is not set");
    expect(notGatheredHtml(answer)).toContain(".env.example");
  });

  it("says the command should work when a key is present", () => {
    expect(notGatheredHtml({ ...answer, hasKey: true })).toContain("OPENCODE_API_KEY is set");
  });
});

describe("gatherCommand", () => {
  it("quotes the topic", () => {
    expect(gatherCommand("Toast Junction Kopitiam")).toBe(
      'npm run gather -- "Toast Junction Kopitiam"',
    );
  });

  it("escapes a quote in the topic instead of ending the argument early", () => {
    expect(gatherCommand('a " b')).toBe('npm run gather -- "a \\" b"');
  });
});

// ---------------------------------------------------------------------------
// Slugs and path traversal
// ---------------------------------------------------------------------------

describe("slugifyTopic", () => {
  it("lowercases and collapses runs of non-alphanumerics", () => {
    expect(slugifyTopic("Toast Junction Kopitiam")).toBe("toast-junction-kopitiam");
    expect(slugifyTopic("  Ampersand & Co.  ")).toBe("ampersand-co");
  });

  it("cannot produce a slug that escapes the store", () => {
    for (const topic of ["../../etc/passwd", "..", "./..", "C:\\Windows", "%2e%2e%2f"]) {
      const slug = slugifyTopic(topic);
      expect(slug).not.toContain("..");
      expect(slug).not.toContain("/");
      expect(slug).not.toContain("\\");
    }
  });
});

describe("checkTopic", () => {
  it("accepts a topic and collapses its whitespace", () => {
    expect(checkTopic("  Toast   Junction  ")).toEqual({ ok: true, topic: "Toast Junction" });
  });

  it("rejects empty, oversized, non-string, unsluggable and control-char topics", () => {
    expect(checkTopic("   ").ok).toBe(false);
    expect(checkTopic("x".repeat(201)).ok).toBe(false);
    expect(checkTopic(42).ok).toBe(false);
    expect(checkTopic("!!!").ok).toBe(false);
    expect(checkTopic(`a${String.fromCharCode(0)}b`).ok).toBe(false);
  });
});

describe("resolveGatheredDir", () => {
  const base = join(repoRoot, "gathered");

  it("resolves a plain slug to a directory directly inside the store", () => {
    expect(resolveGatheredDir(base, "toast-junction")).toBe(join(base, "toast-junction"));
    expect(resolveGatheredDir(base, "a.b_c-1")).toBe(join(base, "a.b_c-1"));
  });

  it("refuses anything that could leave the store", () => {
    for (const slug of [
      "..",
      "../results",
      "../../package.json",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "C:\\Windows",
      "sub/../../x",
      `x${String.fromCharCode(0)}`,
      ".hidden",
      "-leading-dash",
      "",
      "x".repeat(101),
      42,
      null,
      undefined,
    ]) {
      expect(resolveGatheredDir(base, slug), `should refuse ${String(slug)}`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Reading gathered/ off disk
// ---------------------------------------------------------------------------

let store: string;
let gatheredDir: string;
let resultsDir: string;

/** Writes one `gathered/<slug>/` set the way `npm run gather` is specified to. */
function writeSet(
  slug: string,
  manifest: unknown,
  sources: Record<string, Record<string, unknown>>,
): void {
  mkdirSync(join(gatheredDir, slug, "sources"), { recursive: true });
  writeFileSync(join(gatheredDir, slug, "topic.json"), JSON.stringify(manifest, null, 2));
  for (const [name, doc] of Object.entries(sources)) {
    writeFileSync(join(gatheredDir, slug, "sources", `${name}.json`), JSON.stringify(doc, null, 2));
  }
}

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "results-ui-"));
  gatheredDir = join(store, "gathered");
  resultsDir = join(store, "results");
  mkdirSync(resultsDir, { recursive: true });

  writeSet(
    "toast-junction-kopitiam",
    {
      topic: "Toast Junction Kopitiam",
      entity: { name: "Toast Junction Kopitiam" },
      gatheredAt: "2026-08-13T09:00:00Z",
      sources: [
        { id: "src-02", url: SAFE_URL, title: "Second" },
        { id: "src-01", url: "https://example.org/first", title: "First" },
      ],
    },
    {
      "src-01": {
        id: "src-01",
        date: "2026-01-01",
        title: "First",
        text: "The kopitiam opened in 2019.",
      },
      "src-02": { id: "src-02", date: "2026-01-02", title: "Second", text: "It opened in 2020." },
      "src-03": {
        id: "src-03",
        date: "2026-01-03",
        title: "Third, unlisted",
        text: "A third account.",
        notes: "retrieved from https://notes.example.com/third",
      },
    },
  );

  writeSet(
    "hostile-set",
    {
      topic: HOSTILE_TITLE,
      entity: { name: `<img src=x onerror="alert(1)">` },
      gatheredAt: "2026-08-13T10:00:00Z",
      sources: [{ id: "src-01", url: HOSTILE_URL, title: HOSTILE_TITLE }],
    },
    {
      "src-01": {
        id: "src-01",
        date: "2026-02-01",
        title: HOSTILE_TITLE,
        text: `<iframe src="${HOSTILE_URL}"></iframe>`,
      },
    },
  );

  // A set the gather command got half-way through: no manifest, one bad file.
  mkdirSync(join(gatheredDir, "broken-set", "sources"), { recursive: true });
  writeFileSync(join(gatheredDir, "broken-set", "sources", "a.json"), "{ not json");
  writeFileSync(
    join(gatheredDir, "broken-set", "sources", "b.json"),
    JSON.stringify({ id: "b", title: "Missing text and date" }),
  );
});

afterAll(() => {
  rmSync(store, { recursive: true, force: true });
});

describe("listGatheredSets", () => {
  it("returns nothing when there is no gathered/ directory at all", () => {
    expect(listGatheredSets(join(store, "no-such-dir"))).toEqual([]);
  });

  it("summarises each set with topic, entity, count and gather time", () => {
    const sets = listGatheredSets(gatheredDir);
    const toast = sets.find((s) => s.slug === "toast-junction-kopitiam");
    expect(toast).toBeDefined();
    expect(toast?.topic).toBe("Toast Junction Kopitiam");
    expect(toast?.entity).toBe("Toast Junction Kopitiam");
    expect(toast?.sourceCount).toBe(3);
    expect(toast?.gatheredAt).toBe("2026-08-13T09:00:00Z");
    expect(sets.map((s) => s.slug).sort()).toEqual([
      "broken-set",
      "hostile-set",
      "toast-junction-kopitiam",
    ]);
  });

  it("omits the source bodies from the list", () => {
    for (const summary of listGatheredSets(gatheredDir)) {
      expect(summary).not.toHaveProperty("sources");
    }
  });
});

describe("readGatheredSet", () => {
  it("orders sources the way topic.json lists them, unlisted ones last", () => {
    const read = readGatheredSet(gatheredDir, "toast-junction-kopitiam");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.set.sources.map((s) => s.id)).toEqual(["src-02", "src-01", "src-03"]);
    expect(read.set.error).toBeNull();
  });

  it("takes each URL from topic.json, falling back to a URL in the notes", () => {
    const read = readGatheredSet(gatheredDir, "toast-junction-kopitiam");
    if (!read.ok) throw new Error("expected a set");
    const byId = new Map(read.set.sources.map((s) => [s.id, s]));
    expect(byId.get("src-02")?.url).toBe(SAFE_URL);
    expect(byId.get("src-01")?.url).toBe("https://example.org/first");
    expect(byId.get("src-03")?.url).toBe("https://notes.example.com/third");
  });

  it("drops a hostile URL from the manifest and keeps it only as inert text", () => {
    const read = readGatheredSet(gatheredDir, "hostile-set");
    if (!read.ok) throw new Error("expected a set");
    const first = read.set.sources[0];
    expect(first?.url).toBeNull();
    expect(first?.rejectedUrl).toBe(HOSTILE_URL);
    // And the rendered page contains no href for it.
    expect(gatheredSetHtml(read.set)).not.toContain('href="javascript');
  });

  it("reports a set with no manifest and flags the unreadable files", () => {
    const read = readGatheredSet(gatheredDir, "broken-set");
    if (!read.ok) throw new Error("expected a set");
    expect(read.set.error).toContain("no topic.json");
    expect(read.set.topic).toBe("broken-set");
    expect(read.set.sources).toHaveLength(2);
    expect(read.set.sources[0]?.error).toContain("not valid JSON");
    expect(read.set.sources[1]?.error).toContain("text");
  });

  it("refuses a traversing slug before touching the filesystem", () => {
    const read = readGatheredSet(gatheredDir, "../results");
    expect(read).toEqual({ ok: false, status: 400, error: "not a gathered-set name" });
  });

  it("reports a slug that simply is not there as missing, not as an error", () => {
    const read = readGatheredSet(gatheredDir, "never-gathered");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.status).toBe(404);
  });
});

describe("answerTopic", () => {
  it("finds a set by its slug", () => {
    const answer = answerTopic(gatheredDir, "Toast Junction Kopitiam");
    expect(answer.found).toBe(true);
    expect(answer.set?.slug).toBe("toast-junction-kopitiam");
  });

  it("falls back to the manifest's own topic string when the slug differs", () => {
    // `hostile-set` is not what slugifyTopic() makes of its topic, so this only
    // resolves through the topic-string fallback.
    const answer = answerTopic(gatheredDir, HOSTILE_TITLE);
    expect(answer.slug).not.toBe("hostile-set");
    expect(answer.found).toBe(true);
    expect(answer.set?.slug).toBe("hostile-set");
  });

  it("returns the command and the key requirement when nothing is gathered", () => {
    const answer = answerTopic(gatheredDir, "Merlion Mobility Coop");
    expect(answer.found).toBe(false);
    expect(answer.set).toBeNull();
    expect(answer.command).toBe('npm run gather -- "Merlion Mobility Coop"');
    expect(answer.keyEnvVar).toBe("OPENCODE_API_KEY");
    expect(typeof answer.hasKey).toBe("boolean");
  });

  it("does not create anything on disk", () => {
    answerTopic(join(store, "absent"), "Some Topic");
    expect(listGatheredSets(join(store, "absent"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

/** One GET with the request line written by hand, bypassing URL normalisation. */
function rawGet(origin: string, path: string): Promise<string> {
  const port = Number(new URL(origin).port);
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (raw += chunk));
    socket.on("end", () => done(raw));
    socket.on("error", fail);
  });
}

describe("the server", () => {
  let origin: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = createUiServer({ results: join(repoRoot, "results"), gathered: gatheredDir });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((done) => server.close(() => done()));
  });

  afterAll(async () => {
    await close();
  });

  it("still lists the committed profiles in results/", async () => {
    const res = await fetch(`${origin}/api/results`);
    const items = (await res.json()) as { file: string; error: string | null; profile: unknown }[];
    expect(res.status).toBe(200);
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((i) => i.error !== null)).toEqual([]);
    expect(items.every((i) => i.profile !== null)).toBe(true);
  });

  it("still rejects an off-schema import rather than patching it", async () => {
    const res = await fetch(`${origin}/api/results`, {
      method: "POST",
      body: JSON.stringify({ entity: { name: "No schema version" } }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("rejected") });
  });

  it("serves the page for anything else", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(PAGE);
  });

  it("lists gathered sets", async () => {
    const res = await fetch(`${origin}/api/gathered`);
    const body = (await res.json()) as { exists: boolean; sets: { slug: string }[] };
    expect(body.exists).toBe(true);
    expect(body.sets.map((s) => s.slug)).toContain("toast-junction-kopitiam");
  });

  it("reports an absent store as absent instead of failing", async () => {
    const server = createUiServer({
      results: resultsDir,
      gathered: join(store, "definitely-absent"),
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/gathered`)).json()) as {
      exists: boolean;
      sets: unknown[];
    };
    expect(body).toEqual({ exists: false, sets: [] });
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("serves one set with its sources", async () => {
    const res = await fetch(`${origin}/api/gathered/toast-junction-kopitiam`);
    const body = (await res.json()) as GatheredSetView;
    expect(res.status).toBe(200);
    expect(body.sources).toHaveLength(3);
    expect(body.sources[0]?.text).toContain("It opened in 2020.");
  });

  it("404s a set that does not exist", async () => {
    const res = await fetch(`${origin}/api/gathered/never-gathered`);
    expect(res.status).toBe(404);
  });

  it("refuses an encoded traversal in the slug", async () => {
    for (const attempt of [
      "..%2F..%2Fpackage.json",
      "%2e%2e%2fresults",
      "%2Fetc%2Fpasswd",
      "sub%2F..%2F..%2Fx",
      "%00",
      "..%5C..%5Cpackage.json",
    ]) {
      const res = await fetch(`${origin}/api/gathered/${attempt}`, { redirect: "manual" });
      expect([400, 404], `slug ${attempt} returned ${res.status}`).toContain(res.status);
      const body = await res.text();
      // Nothing outside gathered/ ever comes back, in particular no file content.
      expect(body).not.toContain("cited-profile-reconciler");
      expect(body).not.toContain("root:");
    }
  });

  it("refuses a raw, unencoded traversal that no URL parser normalised away", async () => {
    // `fetch` resolves `..` in a path before sending, so the only way to put a
    // literal `../` on the wire is to write the request line by hand.
    for (const path of [
      "/api/gathered/../../package.json",
      "/api/gathered/..%2f..%2ftsconfig.json",
      "/api/gathered/../results/out.json",
    ]) {
      const raw = await rawGet(origin, path);
      expect(raw.split("\r\n")[0], `path ${path}`).toContain("400");
      expect(raw).not.toContain("cited-profile-reconciler");
      expect(raw).not.toContain("schemaVersion");
    }
  });

  it("answers a gathered topic with its sources", async () => {
    const res = await fetch(`${origin}/api/topic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "  Toast Junction Kopitiam " }),
    });
    const body = (await res.json()) as { found: boolean; set: GatheredSetView | null };
    expect(res.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.set?.sources).toHaveLength(3);
  });

  it("answers an ungathered topic with the command and the key requirement", async () => {
    const res = await fetch(`${origin}/api/topic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Pasir Lane Hawker Archive" }),
    });
    const body = (await res.json()) as {
      found: boolean;
      command: string;
      keyEnvVar: string;
      slug: string;
    };
    expect(body.found).toBe(false);
    expect(body.command).toBe('npm run gather -- "Pasir Lane Hawker Archive"');
    expect(body.keyEnvVar).toBe("OPENCODE_API_KEY");
    expect(body.slug).toBe("pasir-lane-hawker-archive");
  });

  it("never leaks the key itself, only whether there is one", async () => {
    const res = await fetch(`${origin}/api/topic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Anything" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("key");
    expect(typeof body["hasKey"]).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain(String(process.env["OPENCODE_API_KEY"] ?? "\0"));
  });

  it("rejects a bad topic with a reason and no directory read", async () => {
    for (const [topic, expected] of [
      ["   ", "type a topic first"],
      ["!!!", "letter or digit"],
      ["x".repeat(400), "longer than"],
    ] as const) {
      const res = await fetch(`${origin}/api/topic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining(expected),
      });
    }
  });

  it("rejects a topic body that is not JSON", async () => {
    const res = await fetch(`${origin}/api/topic`, { method: "POST", body: "{ not json" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The inline script, run against a stub DOM
// ---------------------------------------------------------------------------

interface FakeElement {
  innerHTML: string;
  textContent: string;
  value: string;
}

interface ClientApi {
  load: () => Promise<void>;
  askTopic: () => Promise<void>;
  openSet: (slug: string) => Promise<void>;
}

/**
 * Evaluates the page's inline script with stubbed `document`, `fetch` and
 * `setInterval`, so the call sites — not just the builders — are covered: a
 * missing `esc()` anywhere in the list column would show up here.
 */
function runClientScript(routes: Record<string, unknown>): {
  api: ClientApi;
  el: (id: string) => FakeElement;
} {
  const open = PAGE.indexOf("<script>");
  const closeTag = PAGE.lastIndexOf("</script>");
  expect(open).toBeGreaterThan(-1);
  const script = PAGE.slice(open + "<script>".length, closeTag);

  const elements = new Map<string, FakeElement>();
  const el = (id: string): FakeElement => {
    let found = elements.get(id);
    if (!found) {
      found = { innerHTML: "", textContent: "", value: "" };
      elements.set(id, found);
    }
    return found;
  };
  const fakeFetch = async (url: string): Promise<{ json: () => Promise<unknown> }> => {
    const key = String(url).split("?")[0] ?? "";
    if (!(key in routes)) throw new Error(`unstubbed fetch: ${key}`);
    return { json: async () => routes[key] };
  };
  const factory = new Function(
    "document",
    "fetch",
    "setInterval",
    `${script}\nreturn { load, askTopic, openSet };`,
  ) as (doc: unknown, f: unknown, s: unknown) => ClientApi;
  const api = factory({ getElementById: el }, fakeFetch, () => 0);
  return { api, el };
}

describe("the inline script", () => {
  const hostileSummary = {
    slug: "hostile-set",
    topic: HOSTILE_TITLE,
    entity: `<img src=x onerror="alert(1)">`,
    gatheredAt: "2026-08-13T10:00:00Z",
    declaredCount: 1,
    sourceCount: 1,
    error: null,
  };

  it("escapes a hostile topic and entity in the list column", async () => {
    const { api, el } = runClientScript({
      "/api/results": [],
      "/api/gathered": { exists: true, sets: [hostileSummary] },
    });
    await api.load();
    const html = el("list").innerHTML;
    expect(html).toContain("Gather sources for a topic");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says plainly when there is no gathered/ directory", async () => {
    const { api, el } = runClientScript({
      "/api/results": [],
      "/api/gathered": { exists: false, sets: [] },
    });
    await api.load();
    expect(el("list").innerHTML).toContain("No <code>gathered/</code> directory yet");
  });

  it("shows the gather command when a submitted topic is not on disk", async () => {
    const { api, el } = runClientScript({
      "/api/results": [],
      "/api/gathered": { exists: true, sets: [] },
      "/api/topic": {
        topic: HOSTILE_TITLE,
        slug: "b-script-alert-title-script",
        found: false,
        set: null,
        command: gatherCommand(HOSTILE_TITLE),
        keyEnvVar: "OPENCODE_API_KEY",
        hasKey: false,
        gatheredDirExists: true,
      },
    });
    await api.load();
    el("topic").value = HOSTILE_TITLE;
    await api.askTopic();
    const html = el("detail").innerHTML;
    expect(html).toContain("npm run gather --");
    expect(html).toContain("OPENCODE_API_KEY is not set");
    expect(html).not.toContain("<script>");
  });

  it("renders the sources of a set opened from the list", async () => {
    const { api, el } = runClientScript({
      "/api/results": [],
      "/api/gathered": { exists: true, sets: [hostileSummary] },
      "/api/gathered/hostile-set": set({
        slug: "hostile-set",
        topic: HOSTILE_TITLE,
        sources: [
          source({
            title: HOSTILE_TITLE,
            text: "hostile body",
            url: HOSTILE_URL,
            rejectedUrl: HOSTILE_URL,
          }),
          source({ id: "src-02", title: "Fine", text: "fine body", url: SAFE_URL }),
        ],
      }),
    });
    await api.load();
    await api.openSet("hostile-set");
    const html = el("detail").innerHTML;
    expect(html).toContain("hostile body");
    expect(html).toContain("fine body");
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain("<script>");
  });

  it("surfaces the server's refusal when a set cannot be read", async () => {
    const { api, el } = runClientScript({
      "/api/results": [],
      "/api/gathered": { exists: true, sets: [] },
      "/api/gathered/nope": { error: "no gathered set with that name" },
    });
    await api.load();
    await api.openSet("nope");
    expect(el("detail").innerHTML).toContain("no gathered set with that name");
  });
});
