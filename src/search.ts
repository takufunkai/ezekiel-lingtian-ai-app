/**
 * The source-gathering seam — the project's **optional** live input path.
 *
 * The fixture corpus stays the primary path: it has a boundary, it is
 * reproducible, and every test runs against it offline
 * (`docs/INITIAL_PROJECT_IDEA.md` rejected live retrieval as the primary input
 * for exactly those reasons, while sanctioning "one optional fetch path *after*
 * the fixture path passes"). This module is that path, and nothing in the
 * fixture pipeline imports it.
 *
 * The shape mirrors `ModelCaller` in `engine.ts`: {@link SourceGatherer} is a
 * one-function seam with two implementations — {@link createLiveGatherer}, which
 * asks the model to run the server-side web-search tool, and
 * {@link createReplayGatherer}, which reads canned results from disk so tests
 * never touch the network.
 *
 * **The live path is unverified.** Requests go through an OpenCode gateway
 * (`src/client.ts`), not the Anthropic API, and no successful call of any kind
 * has ever been made through it from this repository — there is no key on the
 * machine this was written on. Server-side web search may simply not be served
 * there. Every failure mode below therefore reports the gateway URL, the model,
 * and the tool type it asked for, so the first person with a key learns
 * something from the error instead of reading an opaque SDK stack trace.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_EFFORT, DEFAULT_MAX_TOKENS, getBaseUrl, getClient, getModel } from "./client.js";
import { STRUCTURED_OUTPUTS_BETA } from "./model-caller.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

/** One source found by a gatherer, before it becomes a `SourceDocument`. */
export interface GatheredSource {
  url: string;
  title: string;
  /** Publication date as `YYYY-MM-DD`, when the result carried a usable one. */
  date?: string;
  text: string;
}

/**
 * The retrieval seam: a topic in, sources out. Injected exactly like
 * `ModelCaller`, so the gather script is testable with canned results.
 */
export type SourceGatherer = (
  topic: string,
  opts?: { maxSources?: number },
) => Promise<GatheredSource[]>;

/**
 * The web-search tool type this SDK version actually ships.
 *
 * Verified against `node_modules/@anthropic-ai/sdk@0.71.2` — the union
 * `BetaToolUnion` contains `BetaWebSearchTool20250305` (`web_search_20250305`)
 * and no later web-search revision, so that is what is declared. Newer tool
 * types (e.g. a hypothetical `web_search_20260209`) are not expressible on this
 * SDK; upgrading the SDK is the way to reach them, not hand-writing the string.
 */
export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305" as const;

/** Tool name the model calls. Fixed by the tool type. */
export const WEB_SEARCH_TOOL_NAME = "web_search" as const;

/** Sources requested when the caller does not say. */
export const DEFAULT_MAX_SOURCES = 5;

/** Hard ceiling on sources per gather, so one call cannot balloon. */
export const MAX_SOURCES_LIMIT = 12;

/** Server-side search calls allowed per gather request. */
export const DEFAULT_MAX_SEARCH_USES = 6;

/**
 * Extra `create` calls allowed to resume a `pause_turn`.
 *
 * A server tool can pause a long-running turn; the documented continuation is
 * to send the paused assistant turn straight back. That is a loop, so it is
 * bounded here for the same reason the engine bounds its retries — an
 * unbounded one burns tokens on a gateway that may not support the tool at all.
 */
export const DEFAULT_MAX_CONTINUATIONS = 3;

/** Longest slug a topic maps to, so it is always a legal directory name. */
export const MAX_SLUG_LENGTH = 64;

/** Length a truncated slug is cut back to before its disambiguating digest. */
const TRUNCATED_SLUG_BASE_LENGTH = 48;

/**
 * Names Windows refuses as a path component, whatever the extension.
 * A topic of "NUL" must not produce an unopenable directory.
 */
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function digest(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

/**
 * Maps a topic to the slug that names both its gathered-set directory and its
 * replay fixture file.
 *
 * Guarantees, because the result is used as a path component: non-empty,
 * `[a-z0-9-]` only, never a Windows reserved name, at most
 * {@link MAX_SLUG_LENGTH} characters, and deterministic. Accented letters fold
 * to ASCII; scripts with no ASCII folding (CJK, emoji) leave nothing to fold,
 * so those topics fall back to a digest of the original string rather than
 * colliding on one shared name. Truncation also appends a digest, so two long
 * topics sharing a prefix stay distinct.
 */
export function slugify(topic: string): string {
  const folded = topic
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // the combining marks NFKD split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (folded === "") {
    return `topic-${digest(topic, 10)}`;
  }
  if (folded.length > MAX_SLUG_LENGTH) {
    const head = folded.slice(0, TRUNCATED_SLUG_BASE_LENGTH).replace(/-+$/, "");
    return `${head}-${digest(topic, 8)}`;
  }
  if (RESERVED_NAMES.has(folded)) {
    return `topic-${folded}`;
  }
  return folded;
}

/**
 * Narrows a value to a `YYYY-MM-DD` calendar date, or `undefined`.
 *
 * Search results date pages inconsistently (RFC 3339 stamps, relative "3 days
 * ago" strings, nothing at all). Anything that is not already an ISO calendar
 * date — or that is one but not a real day, like `2024-02-31` — is discarded
 * rather than guessed at: a wrong publication date is worse than no date, and
 * the caller decides what to do with the gap.
 */
export function normalizeSourceDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return undefined;
  }
  const iso = trimmed.slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  // The round trip rejects a well-formed but non-existent day, which `Date`
  // would otherwise roll over (2024-02-31 → 2024-03-02).
  return parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
}

/**
 * A URL reduced to what a provenance comparison should care about: scheme and
 * host case, a trailing slash, and a fragment are not differences.
 */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return url.trim();
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Coerces gatherer output — from the model or from a replay file — into
 * `GatheredSource[]`, rejecting anything malformed.
 *
 * Accepts either a bare array or `{ "sources": [...] }`, the two shapes the
 * structured-output call and the canned fixtures use. Throws with the offending
 * index named: a source with no `url` or no `text` cannot become a citable
 * document, so it is a failure rather than something to fill in.
 */
export function coerceGatheredSources(data: unknown, where: string): GatheredSource[] {
  const list = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        Array.isArray((data as { sources?: unknown }).sources)
      ? ((data as { sources: unknown[] }).sources as unknown[])
      : undefined;
  if (list === undefined) {
    throw new Error(`${where}: expected an array of sources or an object with a "sources" array`);
  }

  return list.map((entry, index) => {
    const at = `${where}: sources[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const url = readString(record, "url")?.trim();
    const title = readString(record, "title")?.trim();
    const text = readString(record, "text");
    if (!url) {
      throw new Error(`${at} has no "url"`);
    }
    if (!title) {
      throw new Error(`${at} ("${url}") has no "title"`);
    }
    if (text === undefined || text.trim() === "") {
      throw new Error(`${at} ("${url}") has no "text"`);
    }
    const date = normalizeSourceDate(record["date"]);
    return date === undefined ? { url, title, text } : { url, title, date, text };
  });
}

/** Parses a gatherer's raw JSON text into sources. Throws on bad JSON or shape. */
export function parseGatheredSources(raw: string, where = "gatherer output"): GatheredSource[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return coerceGatheredSources(data, where);
}

/** Every URL the server-side search actually returned, canonicalised. */
export function extractSearchResultUrls(content: readonly ContentBlock[]): Set<string> {
  const urls = new Set<string>();
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    const results = block.content;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      urls.add(canonicalUrl(result.url));
    }
  }
  return urls;
}

/** Error codes the search tool itself reported, if any. */
export function extractSearchErrors(content: readonly ContentBlock[]): string[] {
  const codes: string[] = [];
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    const results = block.content;
    if (!Array.isArray(results)) {
      codes.push(results.error_code);
    }
  }
  return codes;
}

/** True when the model invoked the server-side web-search tool at least once. */
export function usedWebSearch(content: readonly ContentBlock[]): boolean {
  return content.some(
    (block) => block.type === "server_tool_use" && block.name === WEB_SEARCH_TOOL_NAME,
  );
}

/**
 * Splits sources by whether search actually returned their URL.
 *
 * This is the same rule the output validator applies to citations, one stage
 * earlier: a URL the model produced that no search result contained is a
 * fabricated source, and it must not enter the corpus as a document that later
 * looks like provenance. Dropped, never rewritten.
 */
export function partitionByProvenance(
  sources: readonly GatheredSource[],
  searchUrls: ReadonlySet<string>,
): { kept: GatheredSource[]; dropped: GatheredSource[] } {
  const kept: GatheredSource[] = [];
  const dropped: GatheredSource[] = [];
  for (const source of sources) {
    (searchUrls.has(canonicalUrl(source.url)) ? kept : dropped).push(source);
  }
  return { kept, dropped };
}

/** Clamps a requested source count into `1..MAX_SOURCES_LIMIT`. */
export function clampMaxSources(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_SOURCES;
  }
  return Math.min(MAX_SOURCES_LIMIT, Math.max(1, Math.floor(requested)));
}

/**
 * Wire schema for the gather call.
 *
 * Deliberately free of the keywords the structured-output transport rejects
 * (`pattern`, `minItems`, `minLength`, …) — see `TRANSPORT_UNSUPPORTED_KEYWORDS`
 * in `engine.ts`. The real check is {@link coerceGatheredSources} plus, for the
 * documents this becomes, `validateSourceDocument` in `scripts/gather.ts`.
 */
export const GATHERED_SOURCES_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["sources"],
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "title", "text"],
        properties: {
          url: { type: "string", description: "Exact URL of a page the search returned." },
          title: { type: "string", description: "Title of that page." },
          date: {
            type: "string",
            description:
              "Publication date as YYYY-MM-DD. Omit the field entirely if the page does not state one — never guess.",
          },
          text: {
            type: "string",
            description:
              "Verbatim extract from that page, copied character for character. Never paraphrased or summarised.",
          },
        },
      },
    },
  },
};

/**
 * System prompt for the gather call.
 *
 * This is retrieval instruction only. The frozen reconciliation prompt
 * (`prompts/reconcile.v1.md`) is untouched by this path — a gathered set goes
 * through the ordinary engine afterwards, with that same prompt.
 */
export const GATHER_SYSTEM_PROMPT = [
  "You collect source material. You do not summarise, reconcile, or judge it.",
  "",
  "Use the web_search tool to find independent pages about the requested topic, then",
  "report what you found. Rules:",
  "",
  "- Report ONLY pages that appeared in your search results. Never construct, guess,",
  "  or complete a URL. A URL that was not in a search result is a fabrication and is",
  "  discarded by the caller.",
  "- `text` must be a verbatim extract from the page — copied character for character,",
  "  several sentences at least. Downstream code checks quotes against this string as",
  "  exact substrings, so a paraphrase silently destroys every citation drawn from it.",
  "- `date` is the page's stated publication date as YYYY-MM-DD. If the page does not",
  "  state one, omit the field. Never infer a date from context.",
  "- Prefer independent pages over several pages from one publisher: the point is to",
  "  see where sources agree and where they disagree.",
  "- If search returns nothing usable, return an empty `sources` array.",
].join("\n");

/** Builds the user message for a gather call. */
export function buildGatherMessage(topic: string, maxSources: number): string {
  return [
    `Topic: ${topic}`,
    "",
    `Find up to ${maxSources} independent sources about this topic and report them in the`,
    "required JSON shape. Search first; report only what the search returned.",
  ].join("\n");
}

export interface LiveGathererOptions {
  /** Where progress and rejection lines go. Defaults to stderr. */
  log?: (line: string) => void;
  /** Server-side search calls per request. Defaults to {@link DEFAULT_MAX_SEARCH_USES}. */
  maxSearchUses?: number;
  /** `pause_turn` resumptions allowed. Defaults to {@link DEFAULT_MAX_CONTINUATIONS}. */
  maxContinuations?: number;
}

/**
 * Describes a failed gather call in terms someone can act on.
 *
 * The SDK's own message ("404 page not found") says nothing about *why* on a
 * gateway that may not implement server tools, so the gateway URL, the model,
 * and the tool type asked for are all named, together with the fact that this
 * path has never been exercised.
 */
function gatewayFailure(error: unknown, model: string, gateway: string): Error {
  const status = (error as { status?: number }).status;
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `live source gathering failed${status === undefined ? "" : ` (HTTP ${status})`}: ${detail}\n` +
      `  gateway:   ${gateway}\n` +
      `  model:     ${model}\n` +
      `  tool type: ${WEB_SEARCH_TOOL_TYPE} (server-side, executed by the provider)\n` +
      `  This gateway is OpenCode, not the Anthropic API, and no call through it has ever\n` +
      `  been verified from this repository — server-side web search may not be served\n` +
      `  there at all. Use --replay with canned results, or run the fixture path\n` +
      `  (npm run reconcile -- examples/set-a-agreement.case.json --out out.json).`,
  );
}

/**
 * The live gatherer: one structured-output call with the server-side web-search
 * tool declared, resumed while the turn pauses.
 *
 * Web search is a *server* tool: it is declared in `tools` and the provider runs
 * it, returning `server_tool_use` / `web_search_tool_result` content blocks. This
 * code never executes a search itself; it reads those blocks to know which URLs
 * were really returned, and holds the model's reported sources against them.
 *
 * **Unexercised.** Written against the SDK's types and the documented block
 * shapes; never run, because no API key exists on this machine.
 */
export function createLiveGatherer(options: LiveGathererOptions = {}): SourceGatherer {
  const log = options.log ?? ((line: string) => console.error(line));
  const maxSearchUses = options.maxSearchUses ?? DEFAULT_MAX_SEARCH_USES;
  const maxContinuations = options.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;

  return async (topic, opts) => {
    const maxSources = clampMaxSources(opts?.maxSources);
    const client = getClient(); // throws its own actionable message when the key is missing
    const model = getModel();
    const gateway = getBaseUrl();

    log(
      `gather: gateway=${gateway} model=${model} tool=${WEB_SEARCH_TOOL_TYPE} max-sources=${maxSources}`,
    );

    const messages: MessageParam[] = [
      { role: "user", content: buildGatherMessage(topic, maxSources) },
    ];
    const searchUrls = new Set<string>();
    let sawSearch = false;

    for (let turn = 1; turn <= maxContinuations + 1; turn += 1) {
      let response: Awaited<ReturnType<typeof client.beta.messages.create>>;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          betas: [STRUCTURED_OUTPUTS_BETA],
          output_format: { type: "json_schema", schema: GATHERED_SOURCES_SCHEMA },
          output_config: { effort: DEFAULT_EFFORT },
          tools: [
            {
              type: WEB_SEARCH_TOOL_TYPE,
              name: WEB_SEARCH_TOOL_NAME,
              max_uses: maxSearchUses,
            },
          ],
          system: GATHER_SYSTEM_PROMPT,
          messages,
        });
      } catch (error) {
        throw gatewayFailure(error, model, gateway);
      }

      // Refusal and truncation are checked before any content is read, as
      // `model-caller.ts` does: a truncated turn's JSON is garbage, and reading
      // it would turn a clear transport failure into a confusing parse error.
      if (response.stop_reason === "refusal") {
        throw new Error(`model declined to gather sources for this topic (stop_reason: refusal)`);
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(
          `gather output truncated at ${DEFAULT_MAX_TOKENS} tokens — lower --max and try again`,
        );
      }

      for (const url of extractSearchResultUrls(response.content)) {
        searchUrls.add(url);
      }
      sawSearch = sawSearch || usedWebSearch(response.content);
      const searchErrors = extractSearchErrors(response.content);
      if (searchErrors.length > 0) {
        throw new Error(
          `the ${WEB_SEARCH_TOOL_TYPE} tool reported: ${searchErrors.join(", ")} (gateway ${gateway})`,
        );
      }

      // A server tool can pause a long turn. The documented resumption is to
      // send the paused assistant turn straight back, unmodified.
      if (response.stop_reason === "pause_turn") {
        if (turn > maxContinuations) {
          throw new Error(
            `gather did not finish within ${maxContinuations + 1} turn(s) — the turn kept ` +
              `pausing (stop_reason: pause_turn). Raise maxContinuations or lower --max.`,
          );
        }
        log(`gather: turn ${turn} paused; resuming`);
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      if (!sawSearch) {
        throw new Error(
          `the gateway answered but never invoked the server-side ${WEB_SEARCH_TOOL_NAME} tool ` +
            `(${WEB_SEARCH_TOOL_TYPE}), so nothing was retrieved.\n` +
            `  gateway: ${gateway}\n` +
            `  This is the expected symptom of a gateway that accepts the tool declaration but ` +
            `does not implement server-side web search. That is unverified either way: no call ` +
            `through this gateway has ever succeeded from this repository.`,
        );
      }

      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      if (text.length === 0) {
        throw new Error(`gather response contained no text (stop_reason: ${response.stop_reason})`);
      }

      const reported = parseGatheredSources(text, "gather response");
      const { kept, dropped } = partitionByProvenance(reported, searchUrls);
      for (const source of dropped) {
        log(
          `gather: dropped "${source.url}" — that URL was not in any search result ` +
            `(fabricated source; not written)`,
        );
      }
      if (kept.length === 0) {
        throw new Error(
          reported.length === 0
            ? `search returned nothing usable for this topic`
            : `every reported source cited a URL that search never returned (${reported.length} dropped)`,
        );
      }
      return kept.slice(0, maxSources);
    }

    // Unreachable: the loop either returns or throws.
    throw new Error("gather ended without a result");
  };
}

/**
 * A gatherer that reads canned results from disk. No network, ever.
 *
 * `path` is either a single JSON file (used for every topic) or a directory
 * holding `<slug-of-topic>.json`, with `default.json` as the fallback. Either
 * shape may be a bare array or `{ "sources": [...] }`. This is what the tests
 * use, and what `npm run gather -- "<topic>" --replay <path>` uses to exercise
 * the writing path without a key.
 */
export function createReplayGatherer(path: string): SourceGatherer {
  return async (topic, opts) => {
    const maxSources = clampMaxSources(opts?.maxSources);
    if (!existsSync(path)) {
      throw new Error(`replay path does not exist: ${path}`);
    }

    let file = path;
    if (statSync(path).isDirectory()) {
      const slug = slugify(topic);
      const candidates = [join(path, `${slug}.json`), join(path, "default.json")];
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found === undefined) {
        const available = readdirSync(path)
          .filter((name) => name.endsWith(".json"))
          .sort();
        throw new Error(
          `no replay file for topic "${topic}" in ${path} — expected ${slug}.json or default.json` +
            (available.length > 0 ? ` (found: ${available.join(", ")})` : " (directory is empty)"),
        );
      }
      file = found;
    }

    const raw = readFileSync(file, "utf8");
    return parseGatheredSources(raw, `replay file ${file}`).slice(0, maxSources);
  };
}
