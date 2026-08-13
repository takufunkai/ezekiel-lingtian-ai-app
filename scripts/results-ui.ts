#!/usr/bin/env tsx
/**
 * The stupidest possible results frontend: `npm run ui`, open the printed URL.
 *
 * Two filesystem-backed views, no database and no build step:
 *
 *   - `results/`  — every schema-valid profile dropped there, by hand, by
 *     `reconcile --out results/foo.json`, or pasted into the page's Import box.
 *   - `gathered/<slug>/` — one source set per topic, written by `npm run gather`:
 *     a `topic.json` manifest plus one `SourceDocument` per file in `sources/`.
 *
 * This page never fetches the web and never calls a model. Submitting a topic
 * looks on disk; if nothing has been gathered for it, the page says so and
 * prints the command to run instead of pretending.
 *
 * Everything under `gathered/` is untrusted — it comes from web search results —
 * so it is HTML-escaped on the way into the page, and a URL only becomes a live
 * `href` after its scheme is checked (see {@link safeHttpUrl}). The escaper and
 * the markup builders below are serialised into the page's inline script with
 * `String(fn)`, so the browser runs these exact functions and
 * `test/results-ui.test.ts` can test the code that actually ships.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasApiKey, API_KEY_ENV_VAR } from "../src/client.js";
import {
  tryReadJsonFile,
  validateProfile,
  validateSourceDocument,
  formatSchemaErrors,
} from "../src/schema.js";

const PORT = Number(process.env.PORT || 4177);
const RESULTS_DIR = join(process.cwd(), "results");
const GATHERED_DIR = join(process.cwd(), "gathered");

/** Where the page's two stores live. Injectable so tests can use a temp dir. */
export interface UiDirs {
  results: string;
  gathered: string;
}

// ---------------------------------------------------------------------------
// results/ — unchanged behaviour
// ---------------------------------------------------------------------------

function listResults(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = tryReadJsonFile(join(dir, f));
      const check = parsed.ok ? validateProfile(parsed.data) : null;
      return {
        file: f,
        mtime: statSync(join(dir, f)).mtimeMs,
        error: !parsed.ok ? parsed.error : check && !check.valid ? "schema-invalid" : null,
        profile: check?.valid ? check.data : null,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// Untrusted input: escaping, URL schemes, slugs
// ---------------------------------------------------------------------------

/**
 * HTML-escapes one value for interpolation into the page.
 *
 * Serialised into the inline script (see {@link CLIENT_FUNCTIONS}), so this is
 * the exact escaper the browser runs. Keep it self-contained: no imports, no
 * module-scope references, nothing the browser cannot resolve on its own.
 */
export function escapeHtml(value: unknown): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value).replace(/[&<>"']/g, (char) => map[char] ?? char);
}

/**
 * The value if it is an `http`/`https` URL, else `null`.
 *
 * Source URLs arrive from search results, so `javascript:`, `data:` and
 * scheme-relative `//host` values must never reach an `href`. Deliberately
 * strict: an absolute http(s) URL with no whitespace, quotes or angle brackets.
 * Applied on the server when building a response *and* in the browser right
 * before the `href` is written, so neither side can be the only guard.
 */
export function safeHttpUrl(value: unknown): string | null {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\/[^\s"'<>`\\]+$/i.test(url) ? url : null;
}

/** The first `http`/`https` URL in a blob of text (trailing punctuation trimmed). */
export function firstHttpUrlIn(text: unknown): string | null {
  const match = /https?:\/\/[^\s"'<>`\\]+/i.exec(typeof text === "string" ? text : "");
  return match ? safeHttpUrl(match[0].replace(/[.,;:!?)\]}]+$/, "")) : null;
}

/**
 * Directory name for a topic: lowercased, runs of non-alphanumerics collapsed
 * to a single dash. Same shape as the slug the Import box uses for filenames.
 */
export function slugifyTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/** A topic string accepted from the browser, or why it was rejected. */
export type TopicCheck = { ok: true; topic: string } | { ok: false; error: string };

/** Normalises and vets a submitted topic. Never throws. */
export function checkTopic(raw: unknown): TopicCheck {
  if (typeof raw !== "string") return { ok: false, error: "topic must be a string" };
  const topic = raw.replace(/\s+/g, " ").trim();
  if (!topic) return { ok: false, error: "type a topic first" };
  if (topic.length > 200) return { ok: false, error: "topic is longer than 200 characters" };
  // Whitespace was collapsed above, so anything left in this range is a control
  // character someone put there on purpose.
  if (/[\u0000-\u001f\u007f]/.test(topic)) {
    return { ok: false, error: "topic contains control characters" };
  }
  if (!slugifyTopic(topic)) {
    return { ok: false, error: "topic needs at least one letter or digit" };
  }
  return { ok: true, topic };
}

/** The command that would gather this topic, with the topic shell-quoted. */
export function gatherCommand(topic: string): string {
  return `npm run gather -- "${topic.replace(/([\\"$`])/g, "\\$1")}"`;
}

/**
 * Absolute path of one gathered set, or `null` when the slug is not a plain
 * directory name directly inside `gathered/`.
 *
 * The slug comes from the browser and selects a directory, so `..`, absolute
 * paths, either separator, NUL and anything that resolves outside the store are
 * refused *before* the filesystem is touched. The final `resolve` check is the
 * backstop: whatever the pattern let through must still sit one level inside.
 */
export function resolveGatheredDir(gatheredDir: string, slug: unknown): string | null {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 100) return null;
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null;
  const base = resolve(gatheredDir);
  const dir = resolve(base, slug);
  if (dir !== join(base, slug) || !dir.startsWith(base + sep)) return null;
  return dir;
}

// ---------------------------------------------------------------------------
// gathered/ — reading source sets off disk
// ---------------------------------------------------------------------------

/** One source of a gathered set, as the page sees it. */
export interface GatheredSourceView {
  id: string;
  date: string;
  title: string;
  text: string;
  /** Vetted `http`/`https` URL, safe to use as an `href`. */
  url: string | null;
  /** A URL that was present but failed the scheme check. Shown as inert text. */
  rejectedUrl: string | null;
  /** Why this file is not a valid `SourceDocument`, if it is not. */
  error: string | null;
}

/** One `gathered/<slug>/` directory, as the page sees it. */
export interface GatheredSetView {
  slug: string;
  topic: string;
  entity: string;
  gatheredAt: string;
  /** How many sources `topic.json` claims; `-1` when it does not say. */
  declaredCount: number;
  sources: GatheredSourceView[];
  /** A problem with the set as a whole (missing or malformed `topic.json`). */
  error: string | null;
}

/** A gathered set without its source bodies, for the list column. */
export type GatheredSummary = Omit<GatheredSetView, "sources"> & { sourceCount: number };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Slug directories present under `gathered/`, sorted newest-first by mtime. */
export function listGatheredSlugs(gatheredDir: string): string[] {
  if (!existsSync(gatheredDir)) return [];
  return readdirSync(gatheredDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && resolveGatheredDir(gatheredDir, e.name) !== null)
    .map((e) => ({ name: e.name, mtime: statSync(join(gatheredDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => e.name);
}

export type GatheredRead =
  { ok: true; set: GatheredSetView } | { ok: false; status: number; error: string };

/**
 * Reads one gathered set. A malformed `topic.json` or a source file that is not
 * a `SourceDocument` is reported in place rather than hiding the whole set —
 * the writer of these files is a separate command, so a partial set is a state
 * the page has to be able to show.
 */
export function readGatheredSet(gatheredDir: string, slug: unknown): GatheredRead {
  const dir = resolveGatheredDir(gatheredDir, slug);
  if (!dir) return { ok: false, status: 400, error: "not a gathered-set name" };
  if (!existsSync(dir)) return { ok: false, status: 404, error: "no gathered set with that name" };
  const name = String(slug);

  const set: GatheredSetView = {
    slug: name,
    topic: name,
    entity: "",
    gatheredAt: "",
    declaredCount: -1,
    sources: [],
    error: null,
  };

  /** id → URL, from the manifest's own source list. */
  const urlById = new Map<string, string>();
  const order: string[] = [];
  const manifestPath = join(dir, "topic.json");
  if (!existsSync(manifestPath)) {
    set.error = "no topic.json in this directory";
  } else {
    const parsed = tryReadJsonFile(manifestPath);
    if (!parsed.ok) {
      set.error = `topic.json is not valid JSON: ${parsed.error}`;
    } else {
      const manifest = asRecord(parsed.data);
      set.topic = asString(manifest["topic"]) || name;
      set.entity = asString(asRecord(manifest["entity"])["name"]);
      set.gatheredAt = asString(manifest["gatheredAt"]);
      const declared = manifest["sources"];
      if (Array.isArray(declared)) {
        set.declaredCount = declared.length;
        for (const entry of declared) {
          const record = asRecord(entry);
          const id = asString(record["id"]);
          if (!id) continue;
          order.push(id);
          const url = asString(record["url"]);
          if (url) urlById.set(id, url);
        }
      }
    }
  }

  const sourcesDir = join(dir, "sources");
  const files = existsSync(sourcesDir)
    ? readdirSync(sourcesDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  const views = files.map((file) => readGatheredSource(join(sourcesDir, file), file, urlById));
  // Manifest order first, then anything on disk the manifest did not list.
  const rank = (view: GatheredSourceView) => {
    const at = order.indexOf(view.id);
    return at === -1 ? order.length : at;
  };
  set.sources = views
    .map((view, index) => ({ view, index }))
    .sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index)
    .map((entry) => entry.view);
  return { ok: true, set };
}

function readGatheredSource(
  path: string,
  file: string,
  urlById: Map<string, string>,
): GatheredSourceView {
  const parsed = tryReadJsonFile(path);
  if (!parsed.ok) {
    return {
      id: file.replace(/\.json$/, ""),
      date: "",
      title: file,
      text: "",
      url: null,
      rejectedUrl: null,
      error: `not valid JSON: ${parsed.error}`,
    };
  }
  const doc = asRecord(parsed.data);
  const check = validateSourceDocument(parsed.data);
  const id = asString(doc["id"]) || file.replace(/\.json$/, "");
  // Contract order: the manifest's URL for this id, then a URL the document
  // carries itself, then the first URL in `notes` (only the URL is read — the
  // note text itself stays out of the page, as `SourceDocument` intends).
  const candidate = urlById.get(id) || asString(doc["url"]);
  const url = safeHttpUrl(candidate) ?? firstHttpUrlIn(doc["notes"]);
  const rejected = candidate && !safeHttpUrl(candidate) ? candidate : null;
  return {
    id,
    date: asString(doc["date"]),
    title: asString(doc["title"]) || file,
    text: asString(doc["text"]),
    url,
    rejectedUrl: url ? null : rejected,
    error: check.valid ? null : formatSchemaErrors(check.errors).slice(0, 3).join("; "),
  };
}

/** Every gathered set, bodies omitted. */
export function listGatheredSets(gatheredDir: string): GatheredSummary[] {
  return listGatheredSlugs(gatheredDir).flatMap((slug) => {
    const read = readGatheredSet(gatheredDir, slug);
    if (!read.ok) return [];
    const { sources, ...rest } = read.set;
    return [{ ...rest, sourceCount: sources.length }];
  });
}

/** What the page needs to answer "has this topic been gathered?". */
export interface TopicAnswer {
  topic: string;
  slug: string;
  found: boolean;
  set: GatheredSetView | null;
  command: string;
  keyEnvVar: string;
  hasKey: boolean;
  gatheredDirExists: boolean;
}

/**
 * Looks a topic up on disk. Never gathers anything.
 *
 * Tries the slug first, then falls back to matching a manifest's `topic` string
 * exactly (case-insensitively) — the gather command owns the slug spelling, and
 * a set is still the right answer when its directory name is spelled otherwise.
 */
export function answerTopic(gatheredDir: string, topic: string): TopicAnswer {
  const slug = slugifyTopic(topic);
  let set: GatheredSetView | null = null;
  const direct = readGatheredSet(gatheredDir, slug);
  if (direct.ok) {
    set = direct.set;
  } else {
    const wanted = topic.toLowerCase();
    for (const candidate of listGatheredSlugs(gatheredDir)) {
      const read = readGatheredSet(gatheredDir, candidate);
      if (read.ok && read.set.topic.trim().toLowerCase() === wanted) {
        set = read.set;
        break;
      }
    }
  }
  return {
    topic,
    slug,
    found: set !== null,
    set,
    command: gatherCommand(topic),
    keyEnvVar: API_KEY_ENV_VAR,
    hasKey: hasApiKey(),
    gatheredDirExists: existsSync(gatheredDir),
  };
}

// ---------------------------------------------------------------------------
// Markup builders — shipped to the browser verbatim (see CLIENT_FUNCTIONS)
// ---------------------------------------------------------------------------

/** A source's URL as a live link, inert text, or nothing. */
export function sourceUrlHtml(source: GatheredSourceView): string {
  const safe = safeHttpUrl(source.url);
  if (safe) {
    const href = escapeHtml(safe);
    return `<a class="url" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
  }
  if (source.rejectedUrl) {
    return `<span class="badge w">URL not http(s)</span> <code class="url">${escapeHtml(
      source.rejectedUrl,
    )}</code>`;
  }
  return `<span class="url dim">no URL recorded</span>`;
}

/** One source: title, date, URL, body text. */
export function gatheredSourceHtml(source: GatheredSourceView): string {
  const bad = source.error ? `<p class="serr">off-contract: ${escapeHtml(source.error)}</p>` : "";
  return (
    `<div class="gsrc"><div class="gsh"><b>${escapeHtml(source.title)}</b>` +
    `<span class="badge">${escapeHtml(source.id)}</span></div>` +
    `<p class="gmeta">${escapeHtml(source.date || "no date")} · ${sourceUrlHtml(source)}</p>` +
    bad +
    `<div class="stext">${escapeHtml(source.text)}</div></div>`
  );
}

/** The detail pane for one gathered set. */
export function gatheredSetHtml(set: GatheredSetView): string {
  const counted =
    set.declaredCount >= 0 && set.declaredCount !== set.sources.length
      ? ` (topic.json lists ${escapeHtml(set.declaredCount)})`
      : "";
  const bad = set.error ? `<p class="serr">${escapeHtml(set.error)}</p>` : "";
  const body = set.sources.length
    ? set.sources.map(gatheredSourceHtml).join("")
    : `<p class="empty">This set has no source documents in <code>sources/</code>.</p>`;
  return (
    `<h2>${escapeHtml(set.topic)}</h2>` +
    `<div class="meta">${escapeHtml(set.entity || "no entity recorded")} · ` +
    `${escapeHtml(set.sources.length)} source${set.sources.length === 1 ? "" : "s"}${counted}` +
    ` · gathered ` +
    `${escapeHtml(set.gatheredAt || "at an unrecorded time")} · ` +
    `<code>gathered/${escapeHtml(set.slug)}/</code></div>` +
    bad +
    `<section><h4>Sources</h4>${body}</section>`
  );
}

/** The detail pane when nothing has been gathered for the submitted topic. */
export function notGatheredHtml(answer: {
  topic: string;
  slug: string;
  command: string;
  keyEnvVar: string;
  hasKey: boolean;
}): string {
  const key = answer.hasKey
    ? `<span class="badge">${escapeHtml(answer.keyEnvVar)} is set</span> in this server's environment, so the command above should run.`
    : `<span class="badge w">${escapeHtml(answer.keyEnvVar)} is not set</span> — copy <code>.env.example</code> to <code>.env</code> and put a real key in it first.`;
  return (
    `<h2>Not gathered yet</h2>` +
    `<div class="meta">Nothing on disk for “${escapeHtml(answer.topic)}” ` +
    `(looked in <code>gathered/${escapeHtml(answer.slug)}/</code>).</div>` +
    `<section><h4>Nothing was fetched</h4>` +
    `<p>This page only reads the filesystem — it never searches the web and never ` +
    `calls a model. To gather sources for this topic, run:</p>` +
    `<pre class="cmd">${escapeHtml(answer.command)}</pre>` +
    `<p class="note">${key}</p>` +
    `<p class="note">The set appears here as soon as ` +
    `<code>gathered/${escapeHtml(answer.slug)}/</code> exists; this page reloads on its own.</p>` +
    `</section>`
  );
}

/** The functions above, as source, for the page's inline script. */
const CLIENT_FUNCTIONS = [
  escapeHtml,
  safeHttpUrl,
  sourceUrlHtml,
  gatheredSourceHtml,
  gatheredSetHtml,
  notGatheredHtml,
]
  .map((fn) => String(fn))
  .join("\n");

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => done(body));
  });
}

/** Builds the server. Exported so a test can listen on an ephemeral port. */
export function createUiServer(dirs: UiDirs): Server {
  return createServer((req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const json = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && path === "/api/results") {
      return json(200, listResults(dirs.results));
    }

    if (req.method === "GET" && path === "/api/gathered") {
      return json(200, {
        exists: existsSync(dirs.gathered),
        sets: listGatheredSets(dirs.gathered),
      });
    }

    if (req.method === "GET" && path.startsWith("/api/gathered/")) {
      let slug: string;
      try {
        slug = decodeURIComponent(path.slice("/api/gathered/".length));
      } catch {
        return json(400, { error: "not a gathered-set name" });
      }
      const read = readGatheredSet(dirs.gathered, slug);
      return read.ok ? json(200, read.set) : json(read.status, { error: read.error });
    }

    if (req.method === "POST" && path === "/api/topic") {
      readBody(req).then((body) => {
        let submitted: unknown = body;
        try {
          submitted = (JSON.parse(body) as { topic?: unknown }).topic;
        } catch {
          return json(400, { error: "not valid JSON" });
        }
        const check = checkTopic(submitted);
        if (!check.ok) return json(400, { error: check.error });
        return json(200, answerTopic(dirs.gathered, check.topic));
      });
      return;
    }

    if (req.method === "POST" && path === "/api/results") {
      readBody(req).then((body) => {
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          return json(400, { error: "not valid JSON" });
        }
        const check = validateProfile(data);
        if (!check.valid) {
          return json(422, {
            error: "schema violations (rejected, not patched)",
            details: formatSchemaErrors(check.errors).slice(0, 5),
          });
        }
        const slug = slugifyTopic(check.data.entity.name).slice(0, 40) || "profile";
        const file = `${slug}-${Date.now()}.json`;
        mkdirSync(dirs.results, { recursive: true });
        writeFileSync(join(dirs.results, file), JSON.stringify(check.data, null, 2));
        return json(200, { ok: true, file });
      });
      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
}

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconciled Profiles</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1c1b19;--mut:#77736b;--line:#e5e2db;--acc:#0e7c66;--warn:#b4552d;--warnbg:#fbeee7;--accbg:#e9f4f1}
@media(prefers-color-scheme:dark){:root{--bg:#171614;--card:#201f1c;--ink:#ece9e3;--mut:#9b968c;--line:#33312c;--acc:#4cc2a7;--warn:#e08d63;--warnbg:#3a251a;--accbg:#1d332d}}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
header{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline}
header h1{font-size:18px}header small{color:var(--mut)}
main{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 62px)}
#list{border-right:1px solid var(--line);padding:16px;overflow-y:auto}
h5{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:16px 0 8px}
h5:first-child{margin-top:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer}
.card:hover,.card.sel{border-color:var(--acc)}.card h3{font-size:14px}.card p{font-size:12px;color:var(--mut)}
.card.static,.card.static:hover{cursor:default;border-color:var(--line)}
.badge{display:inline-block;font-size:11px;border-radius:99px;padding:1px 8px;margin-left:6px;background:var(--accbg);color:var(--acc)}
.badge.w{background:var(--warnbg);color:var(--warn)}
#detail{padding:26px 34px;max-width:820px}#detail h2{font-size:22px;margin-bottom:2px}
.meta{color:var(--mut);font-size:13px;margin-bottom:22px}
section{margin-bottom:26px}section>h4{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin-bottom:10px}
.grp{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:12px 16px;margin-bottom:10px}
.grp.disp{border-left-color:var(--warn)}.grp .q{font-weight:600;font-size:14px;margin-bottom:6px}
.claim{margin:6px 0 6px 4px;padding-left:10px;border-left:2px solid var(--line);font-size:14px}
.cite{font-size:11px;background:var(--accbg);color:var(--acc);border-radius:5px;padding:0 6px;margin-left:5px;white-space:nowrap;text-decoration:none}
.src{font-size:13px;color:var(--mut);margin:3px 0}.src b{color:var(--ink)}
.gsrc{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:12px 16px;margin-bottom:10px}
.gsh{font-size:14px;margin-bottom:2px}.gmeta{font-size:12px;color:var(--mut);margin-bottom:8px}
.url{font-size:12px}a.url{color:var(--acc)}.url.dim{color:var(--mut)}
.stext{white-space:pre-wrap;font-size:14px;max-height:16em;overflow-y:auto;border-top:1px solid var(--line);padding-top:8px}
.serr{font-size:12px;color:var(--warn);margin-bottom:6px}
input[type=text]{width:100%;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:13px inherit}
textarea{width:100%;height:70px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px;font:12px ui-monospace,monospace}
button{background:var(--acc);color:#fff;border:0;border-radius:7px;padding:6px 14px;font-size:13px;cursor:pointer;margin-top:6px}
pre.cmd{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:13px ui-monospace,monospace;overflow-x:auto;margin-bottom:10px}
code{font:12px ui-monospace,monospace}p.note{font-size:13px;color:var(--mut);margin-top:8px}
#msg,#tmsg{font-size:12px;color:var(--warn);margin-top:4px}.empty{color:var(--mut);padding:40px;text-align:center}
#detail p+p{margin-top:8px}
</style></head><body>
<header><h1>Reconciled Profiles</h1><small>filesystem-backed · results/ + gathered/</small></header>
<main><div id="list"></div><div id="detail"><p class="empty">Select a result</p></div></main>
<script>
${CLIENT_FUNCTIONS}
const esc=escapeHtml;
let items=[],gathered={exists:false,sets:[]},sel=null,view=null,listJson="";
async function load(){
  const [r,g]=await Promise.all([fetch("/api/results"),fetch("/api/gathered")]);
  items=await r.json();gathered=await g.json();
  const fresh=JSON.stringify([items.map(i=>[i.file,i.mtime,i.error]),gathered]);
  if(fresh!==listJson){listJson=fresh;renderList()}
  if(!view&&items.length){pick(items.find(i=>i.profile)?.file)}
}
function renderList(){
  const topic='<h5>Gather sources for a topic</h5><div class="card static">'+
    '<input type="text" id="topic" placeholder="e.g. Toast Junction Kopitiam" '+
    'onkeydown="if(event.key===\\'Enter\\')askTopic()">'+
    '<button onclick="askTopic()">Look for sources</button><div id="tmsg"></div></div>';
  const sets=gathered.sets.map(s=>
    '<div class="card'+(view&&view.slug===s.slug?" sel":"")+'" onclick="openSet(\\''+encodeURIComponent(s.slug)+'\\')">'+
    '<h3>'+esc(s.topic)+(s.error?'<span class="badge w">incomplete</span>':"")+'</h3>'+
    '<p>'+esc(s.entity||"no entity")+' · '+esc(s.sourceCount)+(s.sourceCount===1?' source · ':' sources · ')+
    (s.gatheredAt?new Date(s.gatheredAt).toLocaleString():"time unrecorded")+'</p></div>').join("");
  const noSets=!gathered.exists
    ? '<div class="card static"><p>No <code>gathered/</code> directory yet — nothing has been gathered on this machine. Submit a topic above to see the command that creates one.</p></div>'
    : (gathered.sets.length?"":'<div class="card static"><p><code>gathered/</code> is empty. Submit a topic above to see the command that fills it.</p></div>');
  const cards=items.map(i=>{
    if(!i.profile)return '<div class="card static"><h3>'+esc(i.file)+'</h3><p>unreadable: '+esc(i.error)+'</p></div>';
    const d=i.profile.groups.filter(g=>g.status==="disputed").length;
    return '<div class="card'+(sel===i.file?" sel":"")+'" onclick="pick(\\''+esc(i.file)+'\\')">'+
      '<h3>'+esc(i.profile.entity.name)+(d?'<span class="badge w">'+d+' disputed</span>':'<span class="badge">clean</span>')+'</h3>'+
      '<p>'+esc(i.profile.model||"hand-written")+' · '+esc(i.profile.claims.length)+' claims · '+new Date(i.profile.generatedAt).toLocaleString()+'</p></div>';
  }).join("");
  document.getElementById("list").innerHTML=topic+
    '<h5>Gathered sources</h5>'+sets+noSets+
    '<h5>Reconciled profiles</h5>'+cards+
    '<div class="card static"><h3>Import result</h3><textarea id="paste" placeholder="paste a reconciled profile JSON"></textarea>'+
    '<button onclick="imp()">Store</button><div id="msg"></div></div>';
}
function show(html){document.getElementById("detail").innerHTML=html}
async function askTopic(){
  const el=document.getElementById("topic"),msg=document.getElementById("tmsg");
  const r=await fetch("/api/topic",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({topic:el?el.value:""})});
  const j=await r.json();
  if(j.error){msg.textContent=j.error;return}
  msg.textContent="";sel=null;
  if(j.found){view={kind:"set",slug:j.set.slug};show(gatheredSetHtml(j.set))}
  else{view={kind:"missing",slug:j.slug};show(notGatheredHtml(j))}
  load();
}
async function openSet(slug){
  const r=await fetch("/api/gathered/"+slug);const j=await r.json();
  if(j.error){show('<p class="empty">'+esc(j.error)+'</p>');return}
  sel=null;view={kind:"set",slug:j.slug};renderList();show(gatheredSetHtml(j));
}
function pick(f){sel=f;view=null;renderList();const p=items.find(i=>i.file===f)?.profile;if(!p)return;
  const claim=id=>p.claims.find(c=>c.id===id);
  const claimHtml=c=>c?'<div class="claim">'+esc(c.text)+c.citations.map(x=>'<a class="cite" href="#src-'+esc(x.sourceId)+'" title="'+esc(x.quote)+'">'+esc(x.sourceId)+'</a>').join("")+'</div>':"";
  const grp=g=>'<div class="grp'+(g.status==="disputed"?" disp":"")+'"><div class="q">'+esc(g.question)+'</div>'+g.claimIds.map(id=>claimHtml(claim(id))).join("")+'</div>';
  const agreed=p.groups.filter(g=>g.status==="agreed"),disp=p.groups.filter(g=>g.status==="disputed");
  show('<h2>'+esc(p.entity.name)+'</h2><div class="meta">'+esc((p.entity.aliases||[]).join(", "))+
    (p.entity.aliases?.length?" · ":"")+esc(p.model||"hand-written")+' · '+esc(p.generatedAt)+'</div>'+
    (disp.length?'<section><h4>⚠ Disputed ('+disp.length+')</h4>'+disp.map(grp).join("")+'</section>':"")+
    '<section><h4>Agreed ('+agreed.length+')</h4>'+agreed.map(grp).join("")+'</section>'+
    '<section><h4>Sources</h4>'+p.sources.map(s=>'<p class="src" id="src-'+esc(s.id)+'"><b>'+esc(s.id)+'</b> · '+esc(s.date)+' · '+esc(s.title)+'</p>').join("")+'</section>');
}
async function imp(){const r=await fetch("/api/results",{method:"POST",body:document.getElementById("paste").value});
  const j=await r.json();document.getElementById("msg").textContent=j.error?j.error+(j.details?": "+j.details.join("; "):""):"stored ✓";if(j.ok)load();}
load();setInterval(load,4000);
</script></body></html>`;

/** The page, for tests that assert what the browser is actually served. */
export { PAGE };

function main(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  // Seed: if a fresh `out.json` sits in the repo root and the store is empty, adopt it.
  if (existsSync("out.json") && readdirSync(RESULTS_DIR).length === 0) {
    copyFileSync("out.json", join(RESULTS_DIR, "out.json"));
  }
  createUiServer({ results: RESULTS_DIR, gathered: GATHERED_DIR }).listen(PORT, () =>
    console.log(
      `results ui → http://localhost:${PORT}  (profiles in ${RESULTS_DIR}, gathered sets in ${GATHERED_DIR})`,
    ),
  );
}

// Only serve when run directly; importing this file (tests) must not open a port.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
