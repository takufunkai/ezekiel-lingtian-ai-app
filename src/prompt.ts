/**
 * Prompt construction for the reconciliation engine.
 *
 * The system prompt lives in `prompts/reconcile.v1.md` — a versioned, frozen file
 * (the prompt-iteration epic, #7, adds new versions rather than editing v1). This
 * module builds the user message from model inputs only: it accepts
 * `ModelSourceDocument` (never `SourceDocument`) and knows nothing about fixture
 * cases, so author notes and the case manifest's answer key are structurally
 * unreachable from prompt text.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entity, ModelSourceDocument } from "./contract.js";

/** Version tag of the active prompt. Frozen; epic #7 introduces v2. */
export const PROMPT_VERSION = "v1" as const;

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the versioned prompt file. */
export const PROMPT_PATH = join(here, "..", "prompts", `reconcile.${PROMPT_VERSION}.md`);

/** The system prompt, read once from the versioned prompt file. */
export const SYSTEM_PROMPT = readFileSync(PROMPT_PATH, "utf8");

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
