/**
 * Prompt construction for the reconciliation engine.
 *
 * System prompts live in `prompts/reconcile.<version>.md` — versioned, frozen
 * files. A version is never edited once it has produced recorded evidence; the
 * prompt-iteration epic (#7) adds new versions instead. The active version is
 * `DEFAULT_PROMPT_VERSION`, overridable per run with the `PROMPT_VERSION` env
 * var (e.g. `PROMPT_VERSION=v1 npm run reconcile -- ...`) so before/after
 * comparisons can run both versions against the identical pipeline.
 *
 * This module builds the user message from model inputs only: it accepts
 * `ModelSourceDocument` (never `SourceDocument`) and knows nothing about fixture
 * cases, so author notes and the case manifest's answer key are structurally
 * unreachable from prompt text.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entity, ModelSourceDocument } from "./contract.js";

/**
 * The prompt version used when `PROMPT_VERSION` is not set — the current best
 * per the evidence in `docs/prompt-iteration.md`. Change it only alongside new
 * recorded evidence.
 */
export const DEFAULT_PROMPT_VERSION = "v1";

/** Env var selecting the prompt version for a run (e.g. `PROMPT_VERSION=v1`). */
export const PROMPT_VERSION_ENV_VAR = "PROMPT_VERSION";

/** Versions look like `v1`, `v2`, ... — anything else is a configuration bug. */
const VERSION_PATTERN = /^v\d+$/;

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the versioned prompt file for `version`. */
export function promptPathFor(version: string): string {
  return join(here, "..", "prompts", `reconcile.${version}.md`);
}

/**
 * The prompt version in effect: `PROMPT_VERSION` from the env when set, else
 * {@link DEFAULT_PROMPT_VERSION}.
 *
 * @throws if the configured value is not a `v<number>` tag.
 */
export function getPromptVersion(): string {
  const version = process.env[PROMPT_VERSION_ENV_VAR] || DEFAULT_PROMPT_VERSION;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `${PROMPT_VERSION_ENV_VAR}="${version}" is not a prompt version tag (expected v1, v2, ...)`,
    );
  }
  return version;
}

const promptCache = new Map<string, string>();

/**
 * The system prompt for the version in effect, read once per version from its
 * frozen file.
 *
 * @throws if the versioned prompt file does not exist.
 */
export function getSystemPrompt(): string {
  const version = getPromptVersion();
  let prompt = promptCache.get(version);
  if (prompt === undefined) {
    prompt = readFileSync(promptPathFor(version), "utf8");
    promptCache.set(version, prompt);
  }
  return prompt;
}

/**
 * Builds the user message: the entity plus the documents, as deterministic JSON.
 *
 * This is the only function that turns documents into prompt text. Its parameter
 * type is the whole guarantee — `ModelSourceDocument` has no `notes` field, so
 * nothing this function serialises can contain author notes or expectations.
 */
export function buildUserMessage(entity: Entity, documents: ModelSourceDocument[]): string {
  const input = {
    entity,
    documents: documents.map((doc) => ({
      id: doc.id,
      date: doc.date,
      title: doc.title,
      text: doc.text,
    })),
  };
  return [
    "Reconcile the following source documents about the given entity.",
    "",
    JSON.stringify(input, null, 2),
  ].join("\n");
}
