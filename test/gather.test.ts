/**
 * `npm run gather` — the writing half of the optional live path, offline.
 *
 * Every test drives `gatherToDirectory` with the replay gatherer and a temp
 * directory, so nothing here needs a key or a network. The load-bearing
 * assertions are that each written document validates against
 * `schema/source-document.schema.json`, and that `topic.json` is exactly the
 * shape the results UI is coded against — and is *not* a `FixtureCase`.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUT_ROOT,
  gatherToDirectory,
  parseGatherArgs,
  sourceIdFor,
  toSourceDocument,
  type GatheredTopic,
} from "../scripts/gather.js";
import { validateFixtureCase, validateSourceDocument } from "../src/schema.js";
import { createReplayGatherer, slugify, type SourceGatherer } from "../src/search.js";

const here = dirname(fileURLToPath(import.meta.url));
const replayDir = join(here, "fixtures", "gathered", "replay");
const replay = createReplayGatherer(replayDir);
const TOPIC = "Nimbus Cartography Collective";
const NOW = new Date("2026-08-13T12:00:00.000Z");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "gather-test-"));
}

async function gatherFixture(overrides: Partial<Parameters<typeof gatherToDirectory>[0]> = {}) {
  return gatherToDirectory({
    topic: TOPIC,
    gather: replay,
    outRoot: tempRoot(),
    now: NOW,
    log: () => {},
    ...overrides,
  });
}

function readTopic(path: string): GatheredTopic {
  return JSON.parse(readFileSync(path, "utf8")) as GatheredTopic;
}

describe("gathered sets on disk", () => {
  it("writes documents under <root>/<slug>/sources and a topic.json beside them", async () => {
    const root = tempRoot();
    const result = await gatherFixture({ outRoot: root });

    expect(result.dir).toBe(join(root, slugify(TOPIC)));
    expect(readdirSync(join(result.dir, "sources")).sort()).toEqual([
      "src-01.json",
      "src-02.json",
      "src-03.json",
    ]);
    expect(result.topicPath).toBe(join(result.dir, "topic.json"));
    expect(result.documentPaths).toHaveLength(3);
  });

  it("writes source documents that validate against the committed schema", async () => {
    const result = await gatherFixture();

    for (const path of result.documentPaths) {
      const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const validation = validateSourceDocument(document);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    }
    expect(result.documents.map((document) => document.id)).toEqual(["src-01", "src-02", "src-03"]);
  });

  it("keeps a reported publication date and falls back to the retrieval date, saying which", async () => {
    const result = await gatherFixture();
    const [first, second, third] = result.documents;

    expect(first?.date).toBe("2021-03-14");
    expect(second?.date).toBe("2022-06-02"); // timestamp reduced to a calendar date
    // The third canned source has no date at all. The schema requires one, so it
    // gets the retrieval date — and the note says so rather than passing it off
    // as a publication date.
    expect(third?.date).toBe("2026-08-13");
    expect(third?.notes).toMatch(/no publication date, so date is the retrieval date/);
    expect(first?.notes).toMatch(/publication date reported by search/);
  });

  it("records the source URL in notes, which never reaches the model", async () => {
    const result = await gatherFixture();
    // `toModelInput` strips exactly one field, `notes`, so provenance recorded
    // there cannot become prompt text.
    expect(result.documents[0]?.notes).toContain("https://example.org/nimbus/history");
    for (const document of result.documents) {
      expect(document.text).not.toContain("https://example.org");
    }
  });

  it("writes topic.json in exactly the documented shape", async () => {
    const result = await gatherFixture();
    const manifest = readTopic(result.topicPath);

    expect(Object.keys(manifest)).toEqual(["topic", "entity", "gatheredAt", "sources"]);
    expect(manifest.topic).toBe(TOPIC);
    expect(manifest.entity).toEqual({ name: TOPIC });
    expect(manifest.gatheredAt).toBe(NOW.toISOString());
    expect(manifest.sources).toEqual([
      {
        id: "src-01",
        url: "https://example.org/nimbus/history",
        title: "Nimbus Cartography Collective: A Brief History",
      },
      {
        id: "src-02",
        url: "https://news.example.com/2022/nimbus-profile?utm_source=feed#top",
        title: "Ten years of open maps",
      },
      {
        id: "src-03",
        url: "https://blog.example.net/undated-nimbus-note",
        title: "A note on Nimbus's datasets",
      },
    ]);
    for (const entry of manifest.sources) {
      expect(Object.keys(entry)).toEqual(["id", "url", "title"]);
    }
  });

  it("is deliberately NOT a fixture case, and does not fake an answer key", async () => {
    const result = await gatherFixture();
    const manifest = readTopic(result.topicPath) as unknown as Record<string, unknown>;

    // A FixtureCase requires `expect.questions` with at least one entry. A
    // gathered set has no ground truth, so it must not pretend to be one:
    // inventing questions here would score Epic 6 against fiction.
    expect(manifest["expect"]).toBeUndefined();
    expect(manifest["scenario"]).toBeUndefined();
    expect(validateFixtureCase(manifest).valid).toBe(false);
  });

  it("uses --entity for the entity name and the topic otherwise", async () => {
    const named = await gatherFixture({ entityName: "  Nimbus Collective  " });
    expect(readTopic(named.topicPath).entity).toEqual({ name: "Nimbus Collective" });
    expect(readTopic(named.topicPath).topic).toBe(TOPIC);
  });

  it("honours maxSources", async () => {
    const result = await gatherFixture({ maxSources: 2 });
    expect(result.documents).toHaveLength(2);
    expect(readTopic(result.topicPath).sources).toHaveLength(2);
  });

  it("slugs awkward topics into directories that can actually be created", async () => {
    const root = tempRoot();
    for (const topic of [
      "霖天股份有限公司",
      "NUL",
      "What's *new*?!",
      `${"long ".repeat(40)}tail`,
    ]) {
      const result = await gatherToDirectory({
        topic,
        gather: replay, // falls back to default.json
        outRoot: root,
        now: NOW,
        log: () => {},
      });
      expect(result.dir).toBe(join(root, slugify(topic)));
      expect(readdirSync(join(result.dir, "sources"))).toEqual(["src-01.json"]);
      expect(readTopic(result.topicPath).topic).toBe(topic);
    }
  });

  it("rejects a source that would violate the schema instead of patching it", async () => {
    const oversizedTitle: SourceGatherer = async () => [
      { url: "https://example.org/a", title: "T".repeat(400), text: "body" },
      { url: "https://example.org/b", title: "Fine", text: "body" },
    ];
    const lines: string[] = [];
    const result = await gatherFixture({
      gather: oversizedTitle,
      log: (line) => lines.push(line),
    });

    // Ids are assigned from the survivors, so the set is src-01..src-0N with no
    // gaps and the manifest's id → url mapping stays correct.
    expect(result.documents.map((document) => document.id)).toEqual(["src-01"]);
    expect(readTopic(result.topicPath).sources).toEqual([
      { id: "src-01", url: "https://example.org/b", title: "Fine" },
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/rejected https:\/\/example\.org\/a/);
  });

  it("fails rather than writing an empty set", async () => {
    const nothing: SourceGatherer = async () => [];
    await expect(gatherFixture({ gather: nothing })).rejects.toThrow(/no sources gathered/);

    const allBad: SourceGatherer = async () => [
      { url: "https://example.org/a", title: "T".repeat(400), text: "body" },
    ];
    await expect(gatherFixture({ gather: allBad })).rejects.toThrow(
      /failed source-document\.schema\.json/,
    );
  });

  it("clears a previous run's documents so stale sources cannot leak into the next reconcile", async () => {
    const root = tempRoot();
    const first = await gatherFixture({ outRoot: root });
    writeFileSync(join(first.dir, "sources", "src-99.json"), "{}\n");
    expect(readdirSync(join(first.dir, "sources"))).toContain("src-99.json");

    const second = await gatherFixture({ outRoot: root, maxSources: 1 });
    expect(second.dir).toBe(first.dir);
    expect(readdirSync(join(second.dir, "sources"))).toEqual(["src-01.json"]);
  });
});

describe("gather ids and documents", () => {
  it("numbers ids so they always match the schema's id pattern", () => {
    expect([0, 1, 9, 11].map(sourceIdFor)).toEqual(["src-01", "src-02", "src-10", "src-12"]);
    for (const id of [0, 5, 42].map(sourceIdFor)) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    }
  });

  it("builds a document with only the contract's fields", () => {
    const document = toSourceDocument(
      { url: "https://example.org/a", title: "A", date: "2020-05-06", text: "body" },
      0,
      NOW.toISOString(),
    );
    expect(Object.keys(document).sort()).toEqual(["date", "id", "notes", "text", "title"]);
    expect(validateSourceDocument(document).valid).toBe(true);
  });
});

describe("gather argument parsing", () => {
  it("takes a topic and defaults the rest", () => {
    expect(parseGatherArgs(["Nimbus Cartography Collective"])).toEqual({
      ok: true,
      args: { topic: "Nimbus Cartography Collective", outRoot: DEFAULT_OUT_ROOT, maxSources: 5 },
    });
  });

  it("reads --out, --max, --entity and --replay in any order", () => {
    expect(
      parseGatherArgs(["--max", "3", "--replay", "r", "Nimbus", "--out", "g", "--entity", " N "]),
    ).toEqual({
      ok: true,
      args: {
        topic: "Nimbus",
        outRoot: "g",
        maxSources: 3,
        entityName: "N",
        replayPath: "r",
      },
    });
  });

  it("rejects malformed arguments", () => {
    for (const argv of [
      [],
      ["   "],
      ["--out", "g"],
      ["Nimbus", "--max"],
      ["Nimbus", "--max", "0"],
      ["Nimbus", "--max", "two"],
      ["Nimbus", "--max", "2.5"],
      ["Nimbus", "--entity", "  "],
      ["Nimbus", "--bogus"],
      ["Nimbus", "extra"],
    ]) {
      expect(parseGatherArgs(argv).ok, argv.join(" ")).toBe(false);
    }
  });

  it("caps an absurd --max rather than asking for a thousand pages", () => {
    const parsed = parseGatherArgs(["Nimbus", "--max", "9999"]);
    expect(parsed.ok && parsed.args.maxSources).toBe(12);
  });
});
