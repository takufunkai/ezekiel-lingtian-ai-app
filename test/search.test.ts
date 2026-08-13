/**
 * The source-gathering seam, entirely offline.
 *
 * Two kinds of test live here. The replay gatherer and the pure helpers are
 * tested for real. The live gatherer is tested against a **mocked SDK client**
 * (the pattern `test/client.test.ts` uses): that pins what this code puts on the
 * wire and how it reacts to each response shape, and it proves nothing about
 * whether the OpenCode gateway serves server-side web search. Nothing here
 * opens a socket, and no test needs an API key.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  ensureDotenv,
  getClient,
  resetClient,
} from "../src/client.js";
import {
  DEFAULT_MAX_SOURCES,
  MAX_SLUG_LENGTH,
  MAX_SOURCES_LIMIT,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE,
  canonicalUrl,
  clampMaxSources,
  createLiveGatherer,
  createReplayGatherer,
  extractSearchErrors,
  extractSearchResultUrls,
  normalizeSourceDate,
  parseGatheredSources,
  partitionByProvenance,
  slugify,
  usedWebSearch,
} from "../src/search.js";

const here = dirname(fileURLToPath(import.meta.url));
const replayDir = join(here, "fixtures", "gathered", "replay");

type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

function textBlock(text: string): ContentBlock {
  return { type: "text", text, citations: null };
}

function searchUseBlock(query: string): ContentBlock {
  return {
    type: "server_tool_use",
    id: "srvtoolu_01",
    caller: { type: "direct" },
    name: WEB_SEARCH_TOOL_NAME,
    input: { query },
  };
}

function searchResultBlock(...urls: string[]): ContentBlock {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_01",
    content: urls.map((url) => ({
      type: "web_search_result",
      url,
      title: `Title of ${url}`,
      page_age: null,
      encrypted_content: "opaque",
    })),
  };
}

function searchErrorBlock(code: "unavailable" | "max_uses_exceeded"): ContentBlock {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_01",
    content: { type: "web_search_tool_result_error", error_code: code },
  };
}

describe("slug generation", () => {
  const slugPattern = /^[a-z0-9][a-z0-9-]*$/;

  it("slugifies an ordinary topic", () => {
    expect(slugify("Nimbus Cartography Collective")).toBe("nimbus-cartography-collective");
  });

  it("collapses punctuation and trims separators instead of emitting them", () => {
    expect(slugify("  What's *new* @ Nimbus?!  ")).toBe("what-s-new-nimbus");
    expect(slugify("--hello--world--")).toBe("hello-world");
    expect(slugify("C++ / Rust: a comparison")).toBe("c-rust-a-comparison");
  });

  it("folds accents to ASCII rather than dropping the word", () => {
    expect(slugify("Café Münster Cooperativa Española")).toBe("cafe-munster-cooperativa-espanola");
  });

  it("falls back to a digest when nothing survives folding", () => {
    // CJK and emoji have no ASCII folding, so a naive slug would be empty and
    // every such topic would collide on one directory.
    const cjk = slugify("霖天股份有限公司");
    const emoji = slugify("🌍🗺️");
    for (const slug of [cjk, emoji, slugify(""), slugify("   "), slugify("!!!")]) {
      expect(slug).toMatch(slugPattern);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    }
    expect(cjk).not.toBe(emoji);
    expect(cjk.startsWith("topic-")).toBe(true);
  });

  it("bounds a very long topic and keeps distinct topics distinct", () => {
    const long = `${"cartography ".repeat(40)}collective`;
    const otherLong = `${"cartography ".repeat(40)}consortium`;
    expect(slugify(long).length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slugify(long)).toMatch(slugPattern);
    // Both share the first 48 characters; the digest suffix is what separates them.
    expect(slugify(long)).not.toBe(slugify(otherLong));
  });

  it("escapes Windows reserved device names, which cannot be directories", () => {
    expect(slugify("NUL")).toBe("topic-nul");
    expect(slugify("com1")).toBe("topic-com1");
    expect(slugify("console")).toBe("console");
  });

  it("is deterministic", () => {
    for (const topic of ["Nimbus", "", "霖天", "a".repeat(200)]) {
      expect(slugify(topic)).toBe(slugify(topic));
    }
  });
});

describe("date normalisation", () => {
  it("keeps a calendar date and the date part of a timestamp", () => {
    expect(normalizeSourceDate("2021-03-14")).toBe("2021-03-14");
    expect(normalizeSourceDate("2022-06-02T09:30:00Z")).toBe("2022-06-02");
    expect(normalizeSourceDate(" 1999-12-31 ")).toBe("1999-12-31");
  });

  it("discards anything it would have to guess at", () => {
    for (const value of [
      "3 days ago",
      "March 2021",
      "2021",
      "2021-3-4",
      "",
      undefined,
      null,
      20210314,
    ]) {
      expect(normalizeSourceDate(value)).toBeUndefined();
    }
  });

  it("rejects a well-formed date that is not a real day", () => {
    // `new Date` would roll 2024-02-31 forward to 2024-03-02 — a silently wrong
    // publication date is worse than none.
    expect(normalizeSourceDate("2024-02-31")).toBeUndefined();
    expect(normalizeSourceDate("2024-13-01")).toBeUndefined();
    expect(normalizeSourceDate("2024-02-29")).toBe("2024-02-29");
  });
});

describe("gatherer output parsing", () => {
  it("accepts both the object and the bare-array shape", () => {
    const one = parseGatheredSources(
      '{"sources":[{"url":"https://e.org/a","title":"A","text":"body"}]}',
    );
    const two = parseGatheredSources('[{"url":"https://e.org/a","title":"A","text":"body"}]');
    expect(one).toEqual(two);
    expect(one[0]).toEqual({ url: "https://e.org/a", title: "A", text: "body" });
  });

  it("omits `date` entirely when the result had no usable one", () => {
    const [source] = parseGatheredSources(
      '[{"url":"https://e.org/a","title":"A","text":"body","date":"last spring"}]',
    );
    expect(source && "date" in source).toBe(false);
  });

  it("rejects a source that cannot become a citable document, naming its index", () => {
    const cases: [string, RegExp][] = [
      ['[{"title":"A","text":"b"}]', /sources\[0\] has no "url"/],
      ['[{"url":"https://e.org/a","text":"b"}]', /sources\[0\] .* has no "title"/],
      ['[{"url":"https://e.org/a","title":"A"}]', /sources\[0\] .* has no "text"/],
      ['[{"url":"https://e.org/a","title":"A","text":"   "}]', /has no "text"/],
      ['{"sources":[{"url":"u","title":"t","text":"x"},"nope"]}', /sources\[1\] is not an object/],
      ['{"nope":1}', /expected an array of sources/],
      ["not json at all", /is not valid JSON/],
    ];
    for (const [raw, pattern] of cases) {
      expect(() => parseGatheredSources(raw)).toThrow(pattern);
    }
  });
});

describe("provenance", () => {
  it("treats a trailing slash, a fragment and host case as the same URL", () => {
    expect(canonicalUrl("HTTPS://Example.ORG/a/")).toBe(canonicalUrl("https://example.org/a"));
    expect(canonicalUrl("https://example.org/a#top")).toBe(canonicalUrl("https://example.org/a"));
    expect(canonicalUrl("not a url")).toBe("not a url");
  });

  it("keeps only sources whose URL search actually returned", () => {
    const sources = [
      { url: "https://example.org/real/", title: "Real", text: "t" },
      { url: "https://example.org/invented", title: "Invented", text: "t" },
    ];
    const { kept, dropped } = partitionByProvenance(
      sources,
      new Set([canonicalUrl("https://example.org/real")]),
    );
    expect(kept.map((source) => source.title)).toEqual(["Real"]);
    expect(dropped.map((source) => source.title)).toEqual(["Invented"]);
  });

  it("reads the URLs, the errors and the tool use out of response content", () => {
    const content = [
      searchUseBlock("nimbus"),
      searchResultBlock("https://example.org/a", "https://example.org/b/"),
      textBlock("{}"),
    ];
    expect([...extractSearchResultUrls(content)].sort()).toEqual([
      "https://example.org/a",
      "https://example.org/b",
    ]);
    expect(extractSearchErrors(content)).toEqual([]);
    expect(usedWebSearch(content)).toBe(true);

    expect(usedWebSearch([textBlock("{}")])).toBe(false);
    expect(extractSearchErrors([searchErrorBlock("unavailable")])).toEqual(["unavailable"]);
  });
});

describe("source-count clamping", () => {
  it("defaults, floors and caps the requested count", () => {
    expect(clampMaxSources(undefined)).toBe(DEFAULT_MAX_SOURCES);
    expect(clampMaxSources(Number.NaN)).toBe(DEFAULT_MAX_SOURCES);
    expect(clampMaxSources(0)).toBe(1);
    expect(clampMaxSources(-4)).toBe(1);
    expect(clampMaxSources(3.7)).toBe(3);
    expect(clampMaxSources(9999)).toBe(MAX_SOURCES_LIMIT);
  });
});

describe("the replay gatherer", () => {
  it("reads the canned file named by the topic's slug", async () => {
    const sources = await createReplayGatherer(replayDir)("Nimbus Cartography Collective");
    expect(sources).toHaveLength(3);
    expect(sources[0]?.url).toBe("https://example.org/nimbus/history");
    expect(sources[0]?.date).toBe("2021-03-14");
    // A timestamped date is reduced to a calendar date; a missing one stays missing.
    expect(sources[1]?.date).toBe("2022-06-02");
    expect(sources[2] && "date" in sources[2]).toBe(false);
  });

  it("falls back to default.json for a topic with no canned file", async () => {
    const sources = await createReplayGatherer(replayDir)("some other topic");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.title).toMatch(/Fallback source/);
  });

  it("honours maxSources", async () => {
    const sources = await createReplayGatherer(replayDir)("Nimbus Cartography Collective", {
      maxSources: 2,
    });
    expect(sources).toHaveLength(2);
  });

  it("accepts a single file, used for every topic", async () => {
    const gather = createReplayGatherer(join(replayDir, "default.json"));
    expect(await gather("anything at all")).toHaveLength(1);
  });

  it("fails clearly when the replay path is missing", async () => {
    await expect(createReplayGatherer(join(here, "nope"))("t")).rejects.toThrow(
      /replay path does not exist/,
    );
  });

  it("lists what it did find when a directory has no matching file", async () => {
    const empty = join(here, "fixtures", "gathered");
    await expect(createReplayGatherer(empty)("Nimbus Cartography Collective")).rejects.toThrow(
      /no replay file for topic .* expected nimbus-cartography-collective\.json or default\.json/,
    );
  });
});

/**
 * The live path with a mocked SDK. This pins the request and the branching, and
 * says nothing about whether the gateway implements server-side web search —
 * that is unknown and untestable here, because no key exists.
 */
describe("the live gatherer (mocked transport — never a real call)", () => {
  ensureDotenv();
  const managed = [API_KEY_ENV_VAR, BASE_URL_ENV_VAR] as const;
  const originals = new Map(managed.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    resetClient();
    for (const name of managed) delete process.env[name];
    process.env[API_KEY_ENV_VAR] = "test-key";
    process.env[BASE_URL_ENV_VAR] = "https://gateway.example/zen";
  });

  afterEach(() => {
    for (const name of managed) {
      const value = originals.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetClient();
    vi.restoreAllMocks();
  });

  function mockResponses(...responses: { stop_reason: string; content: ContentBlock[] }[]) {
    const create = vi.spyOn(getClient().beta.messages, "create");
    for (const response of responses) {
      create.mockResolvedValueOnce(response as never);
    }
    return create;
  }

  const goodPayload = JSON.stringify({
    sources: [
      {
        url: "https://example.org/a",
        title: "A",
        date: "2021-03-14",
        text: "Some verbatim body text.",
      },
    ],
  });

  it("declares the web-search tool this SDK ships, as a server-side tool", async () => {
    const create = mockResponses({
      stop_reason: "end_turn",
      content: [
        searchUseBlock("nimbus"),
        searchResultBlock("https://example.org/a"),
        textBlock(goodPayload),
      ],
    });

    const sources = await createLiveGatherer({ log: () => {} })("Nimbus", { maxSources: 3 });
    expect(sources).toEqual([
      {
        url: "https://example.org/a",
        title: "A",
        date: "2021-03-14",
        text: "Some verbatim body text.",
      },
    ]);

    const body = create.mock.calls[0]![0];
    expect(body.tools).toEqual([
      { type: WEB_SEARCH_TOOL_TYPE, name: WEB_SEARCH_TOOL_NAME, max_uses: expect.any(Number) },
    ]);
    // The tool type must be the one this SDK version actually defines.
    expect(WEB_SEARCH_TOOL_TYPE).toBe("web_search_20250305");
    // Structured output goes top-level, as in model-caller.ts — this SDK has no
    // output_config.format.
    expect(body.output_format?.type).toBe("json_schema");
    expect(body.betas).toContain("structured-outputs-2025-11-13");
  });

  it("resumes a paused turn, bounded, and fails loudly when it never settles", async () => {
    const paused = {
      stop_reason: "pause_turn",
      content: [searchUseBlock("nimbus"), searchResultBlock("https://example.org/a")],
    };
    const create = mockResponses(paused, {
      stop_reason: "end_turn",
      content: [textBlock(goodPayload)],
    });

    await expect(
      createLiveGatherer({ log: () => {} })("Nimbus", { maxSources: 1 }),
    ).resolves.toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    // The paused assistant turn is sent straight back, unmodified.
    const secondBody = create.mock.calls[1]![0];
    expect(secondBody.messages).toHaveLength(2);
    expect(secondBody.messages[1]?.role).toBe("assistant");

    resetClient();
    const alwaysPaused = vi.spyOn(getClient().beta.messages, "create");
    alwaysPaused.mockResolvedValue(paused as never);
    await expect(
      createLiveGatherer({ log: () => {}, maxContinuations: 1 })("Nimbus"),
    ).rejects.toThrow(/kept\s+pausing/);
    expect(alwaysPaused).toHaveBeenCalledTimes(2);
  });

  it("says the gateway never ran the tool, rather than returning nothing", async () => {
    mockResponses({ stop_reason: "end_turn", content: [textBlock(goodPayload)] });
    await expect(createLiveGatherer({ log: () => {} })("Nimbus")).rejects.toThrow(
      /never invoked the server-side web_search tool \(web_search_20250305\)/,
    );
  });

  it("names the gateway and the tool type when the call itself fails", async () => {
    const create = vi.spyOn(getClient().beta.messages, "create");
    create.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const gather = createLiveGatherer({ log: () => {} });
    await expect(gather("Nimbus")).rejects.toThrow(/HTTP 404/);
    await expect(gather("Nimbus")).rejects.toThrow(/gateway:\s+https:\/\/gateway\.example\/zen/);
    await expect(gather("Nimbus")).rejects.toThrow(/web_search_20250305/);
  });

  it("surfaces a tool-level error code", async () => {
    mockResponses({
      stop_reason: "end_turn",
      content: [searchUseBlock("n"), searchErrorBlock("max_uses_exceeded")],
    });
    await expect(createLiveGatherer({ log: () => {} })("Nimbus")).rejects.toThrow(
      /max_uses_exceeded/,
    );
  });

  it("handles refusal and truncation before reading content, as model-caller does", async () => {
    mockResponses({ stop_reason: "refusal", content: [] });
    await expect(createLiveGatherer({ log: () => {} })("Nimbus")).rejects.toThrow(
      /stop_reason: refusal/,
    );

    resetClient();
    vi.spyOn(getClient().beta.messages, "create").mockResolvedValue({
      stop_reason: "max_tokens",
      content: [textBlock('{"sour')],
    } as never);
    await expect(createLiveGatherer({ log: () => {} })("Nimbus")).rejects.toThrow(/truncated/);
  });

  it("drops a source whose URL search never returned, and logs the drop", async () => {
    mockResponses({
      stop_reason: "end_turn",
      content: [
        searchUseBlock("n"),
        searchResultBlock("https://example.org/a"),
        textBlock(
          JSON.stringify({
            sources: [
              { url: "https://example.org/a", title: "A", text: "real body" },
              { url: "https://example.org/invented", title: "Invented", text: "made up" },
            ],
          }),
        ),
      ],
    });

    const lines: string[] = [];
    const sources = await createLiveGatherer({ log: (line) => lines.push(line) })("Nimbus");
    expect(sources.map((source) => source.url)).toEqual(["https://example.org/a"]);
    expect(lines.join("\n")).toMatch(/dropped "https:\/\/example\.org\/invented"/);
  });

  it("fails when every reported source was fabricated", async () => {
    mockResponses({
      stop_reason: "end_turn",
      content: [
        searchUseBlock("n"),
        searchResultBlock("https://example.org/a"),
        textBlock(
          JSON.stringify({
            sources: [{ url: "https://example.org/invented", title: "I", text: "made up" }],
          }),
        ),
      ],
    });
    await expect(createLiveGatherer({ log: () => {} })("Nimbus")).rejects.toThrow(
      /cited a URL that search never returned/,
    );
  });
});
