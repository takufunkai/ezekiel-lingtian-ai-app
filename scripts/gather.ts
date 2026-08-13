#!/usr/bin/env tsx
/**
 * Optional live source gathering — `npm run gather -- "<topic>" [--out <dir>] [--max <n>]`.
 *
 * Turns a topic into a **gathered set** on disk: real source documents the
 * ordinary pipeline can then reconcile, validate and render. Layout:
 *
 * ```
 * gathered/<slug-of-topic>/
 *   sources/src-01.json   each a valid SourceDocument (schema/source-document.schema.json)
 *   topic.json            { topic, entity: { name }, gatheredAt, sources: [{ id, url, title }] }
 * ```
 *
 * **`topic.json` is deliberately not a `FixtureCase`.** A fixture case requires
 * `expect.questions` with at least one entry — the answer key the harness scores
 * against. A gathered set has no ground truth: nobody wrote down which questions
 * these pages answer or whether they agree. Emitting an `expect` block to make
 * the file validate would mean inventing an answer key, and Epic 6 would then
 * score runs against fiction. So a gathered set carries provenance only, in its
 * own shape, and `npm run reconcile -- --sources <dir>` consumes it without a
 * case file. Nothing here writes to `examples/`, and no schema changes.
 *
 * The retrieval itself is injected (`SourceGatherer` in `src/search.ts`):
 * `--replay <path>` reads canned results from disk, which is how the tests and
 * an offline demo exercise this script. Without `--replay` it uses the live
 * gatherer, which **has never been run** — there is no API key on the machine
 * this was written on, and the OpenCode gateway may not serve server-side web
 * search at all.
 *
 * Exit codes: 0 success, 1 gather failure, 2 usage error.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { API_KEY_ENV_VAR, hasApiKey } from "../src/client.js";
import type { SourceDocument } from "../src/contract.js";
import { formatSchemaErrors, validateSourceDocument } from "../src/schema.js";
import {
  clampMaxSources,
  createLiveGatherer,
  createReplayGatherer,
  slugify,
  type GatheredSource,
  type SourceGatherer,
} from "../src/search.js";

export const USAGE = [
  'usage: gather "<topic>" [--out <dir>] [--max <n>] [--entity "<name>"] [--replay <path>]',
  "",
  "  --out     root directory for gathered sets (default: gathered). The set is",
  "            written to <root>/<slug-of-topic>/",
  "  --max     how many sources to ask for (default: 5)",
  "  --entity  entity name recorded in topic.json (default: the topic itself)",
  "  --replay  read canned results from a JSON file or directory instead of",
  "            searching — no key, no network",
].join("\n");

/** Default root for gathered sets. Gitignored: retrieved data, not fixtures. */
export const DEFAULT_OUT_ROOT = "gathered";

export interface GatherArgs {
  topic: string;
  outRoot: string;
  maxSources: number;
  entityName?: string;
  replayPath?: string;
}

/** Parses CLI arguments (everything after the script name). Pure, for testing. */
export function parseGatherArgs(
  argv: string[],
): { ok: true; args: GatherArgs } | { ok: false; error: string } {
  let topic: string | undefined;
  let outRoot = DEFAULT_OUT_ROOT;
  let maxSources: number | undefined;
  let entityName: string | undefined;
  let replayPath: string | undefined;

  const valueOptions = new Map<string, (value: string) => string | undefined>([
    [
      "--out",
      (value) => {
        outRoot = value;
        return undefined;
      },
    ],
    [
      "--entity",
      (value) => {
        if (value.trim() === "") return "--entity requires a non-empty name";
        entityName = value.trim();
        return undefined;
      },
    ],
    [
      "--replay",
      (value) => {
        replayPath = value;
        return undefined;
      },
    ],
    [
      "--max",
      (value) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return `--max must be a positive integer, got "${value}"`;
        }
        maxSources = parsed;
        return undefined;
      },
    ],
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const handler = valueOptions.get(arg);
    if (handler) {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        return { ok: false, error: `${arg} requires a value` };
      }
      const error = handler(value);
      if (error !== undefined) {
        return { ok: false, error };
      }
    } else if (arg.startsWith("-")) {
      return { ok: false, error: `unknown option: ${arg}` };
    } else if (topic === undefined) {
      topic = arg;
    } else {
      return { ok: false, error: `unexpected extra argument: ${arg}` };
    }
  }

  if (topic === undefined || topic.trim() === "") {
    return { ok: false, error: 'missing "<topic>"' };
  }

  const args: GatherArgs = {
    topic: topic.trim(),
    outRoot,
    maxSources: clampMaxSources(maxSources),
  };
  if (entityName !== undefined) args.entityName = entityName;
  if (replayPath !== undefined) args.replayPath = replayPath;
  return { ok: true, args };
}

/** One entry in a gathered set's provenance manifest. */
export interface GatheredSourceRef {
  id: string;
  url: string;
  title: string;
}

/**
 * `topic.json` — what a gathered set records instead of an answer key.
 *
 * The one contract the results UI reads. Keys in this exact shape:
 * `{ topic, entity: { name }, gatheredAt, sources: [{ id, url, title }] }`.
 */
export interface GatheredTopic {
  topic: string;
  entity: { name: string };
  /** ISO 8601 date-time the set was gathered. */
  gatheredAt: string;
  sources: GatheredSourceRef[];
}

/** `src-01`, `src-02`, … — always matches the schema's id pattern. */
export function sourceIdFor(index: number): string {
  return `src-${String(index + 1).padStart(2, "0")}`;
}

/**
 * Turns one gathered source into a `SourceDocument`.
 *
 * Two decisions worth knowing:
 *
 * - **`date` never lies about being a publication date.** The schema requires
 *   `date`, so a result that carried no usable publication date gets the
 *   retrieval date, and `notes` says so in words. Guessing a publication date
 *   would corrupt the one field the renderer shows next to a citation.
 * - **The URL lives in `notes`.** `notes` is the only field `toModelInput`
 *   strips, so provenance is recorded without ever becoming prompt text — the
 *   model reconciles the text, not the domain it came from.
 */
export function toSourceDocument(
  source: GatheredSource,
  index: number,
  gatheredAt: string,
): SourceDocument {
  const retrievedOn = gatheredAt.slice(0, 10);
  const dated = source.date !== undefined;
  return {
    id: sourceIdFor(index),
    date: source.date ?? retrievedOn,
    title: source.title,
    text: source.text,
    notes: dated
      ? `Gathered from ${source.url} at ${gatheredAt}. date is the publication date reported by search.`
      : `Gathered from ${source.url} at ${gatheredAt}. The result carried no publication date, so date is the retrieval date.`,
  };
}

export interface GatherToDirectoryOptions {
  topic: string;
  /** Retrieval seam. Tests and `--replay` inject; live runs pass the live one. */
  gather: SourceGatherer;
  /** Root the `<slug>/` directory is created under. */
  outRoot?: string;
  maxSources?: number;
  entityName?: string;
  /** Fixed clock, so tests can assert `gatheredAt`. Defaults to now. */
  now?: Date;
  log?: (line: string) => void;
}

export interface GatherResult {
  /** Absolute path of the gathered set directory. */
  dir: string;
  /** Absolute path of `topic.json`. */
  topicPath: string;
  /** Absolute paths of the written source documents, in order. */
  documentPaths: string[];
  topic: GatheredTopic;
  documents: SourceDocument[];
  /** Sources rejected before writing, with the reason. */
  rejected: string[];
}

/**
 * Gathers a topic and writes the set. The whole script minus argument parsing,
 * so tests drive it directly with a replay gatherer and a temp directory.
 *
 * A source whose document would violate `source-document.schema.json` is
 * rejected with its reason, never patched into shape — the same rule the engine
 * applies to model output. If nothing survives, this throws rather than writing
 * an empty set.
 */
export async function gatherToDirectory(options: GatherToDirectoryOptions): Promise<GatherResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  const maxSources = clampMaxSources(options.maxSources);
  const gatheredAt = (options.now ?? new Date()).toISOString();
  const topic = options.topic.trim();
  if (topic === "") {
    throw new Error("topic is empty");
  }

  const gathered = await options.gather(topic, { maxSources });

  // Kept as pairs: a rejected source must not shift the id→url mapping the
  // manifest records, and ids are assigned from the surviving count so the
  // written set is always src-01..src-0N with no gaps.
  const kept: { document: SourceDocument; source: GatheredSource }[] = [];
  const rejected: string[] = [];
  for (const [index, source] of gathered.slice(0, maxSources).entries()) {
    const document = toSourceDocument(source, kept.length, gatheredAt);
    const result = validateSourceDocument(document);
    if (!result.valid) {
      const reasons = formatSchemaErrors(result.errors).join("; ");
      rejected.push(`source ${index + 1} (${source.url}): ${reasons}`);
      log(`gather: rejected ${source.url} — ${reasons}`);
      continue;
    }
    kept.push({ document, source });
  }
  const documents = kept.map((entry) => entry.document);

  if (documents.length === 0) {
    throw new Error(
      gathered.length === 0
        ? `no sources gathered for "${topic}"`
        : `all ${gathered.length} gathered source(s) failed source-document.schema.json:\n  ` +
            rejected.join("\n  "),
    );
  }

  const slug = slugify(topic);
  const dir = resolve(options.outRoot ?? DEFAULT_OUT_ROOT, slug);
  const sourcesDir = join(dir, "sources");
  mkdirSync(sourcesDir, { recursive: true });

  // A re-gather of the same topic must not leave a previous run's extra
  // documents behind, where they would silently become inputs to the next
  // reconcile. Only this set's own `*.json` files are removed.
  for (const name of readdirSync(sourcesDir)) {
    if (name.endsWith(".json")) {
      rmSync(join(sourcesDir, name));
    }
  }

  const documentPaths = documents.map((document) => {
    const path = join(sourcesDir, `${document.id}.json`);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    return path;
  });

  const topicManifest: GatheredTopic = {
    topic,
    entity: { name: options.entityName?.trim() || topic },
    gatheredAt,
    sources: kept.map(({ document, source }) => ({
      id: document.id,
      url: source.url,
      title: document.title,
    })),
  };
  const topicPath = join(dir, "topic.json");
  writeFileSync(topicPath, `${JSON.stringify(topicManifest, null, 2)}\n`);

  return { dir, topicPath, documentPaths, topic: topicManifest, documents, rejected };
}

async function main(): Promise<number> {
  const parsed = parseGatherArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`gather: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { topic, outRoot, maxSources, entityName, replayPath } = parsed.args;

  let gatherer: SourceGatherer;
  if (replayPath !== undefined) {
    console.error(`gather: replay=${replayPath} (offline; no key, no network)`);
    gatherer = createReplayGatherer(replayPath);
  } else {
    if (!hasApiKey()) {
      console.error(
        `gather: ${API_KEY_ENV_VAR} is not set — copy .env.example to .env and add your key, ` +
          `or pass --replay <path> to gather from canned results. No call made.`,
      );
      return 1;
    }
    console.error(
      "gather: live path — this has never been exercised: the OpenCode gateway may not " +
        "serve server-side web search. See README → Optional live source gathering.",
    );
    gatherer = createLiveGatherer();
  }

  try {
    const options: GatherToDirectoryOptions = { topic, outRoot, maxSources, gather: gatherer };
    if (entityName !== undefined) options.entityName = entityName;
    const result = await gatherToDirectory(options);
    for (const path of result.documentPaths) {
      console.error(`gather:   wrote ${path}`);
    }
    console.error(`gather:   wrote ${result.topicPath}`);
    console.error(
      `gather: ok — ${result.documents.length} source(s) in ${result.dir}` +
        (result.rejected.length > 0 ? `, ${result.rejected.length} rejected` : ""),
    );
    console.error(
      `gather: next — npm run reconcile -- --sources ${result.dir} --out out.json ` +
        `(the reconcile step validates citations against these documents)`,
    );
    return 0;
  } catch (error) {
    console.error(`gather: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`gather: unexpected error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    },
  );
}
