/**
 * TypeScript mirror of the JSON Schemas in `schema/`.
 *
 * The JSON Schema files are the source of truth. These types are hand-written to
 * match them, and `test/contract.test.ts` enforces that they stay in sync: it
 * compares the schema's declared `properties` keys against exhaustive key lists
 * derived from the types below. A field added to one side but not the other
 * fails either the type-check or the test.
 *
 * When you change the contract:
 *   1. edit the `.schema.json` file,
 *   2. edit the matching type here,
 *   3. update the `*_KEYS` list in `test/contract.test.ts`,
 *   4. run `npm run typecheck && npm test`.
 */

/** Current contract version. Must equal `schemaVersion` in claims.schema.json. */
export const SCHEMA_VERSION = "1.0.0" as const;

/** One local source document. Each fixture file holds exactly one of these. */
export interface SourceDocument {
  /** Stable id, unique within a fixture case. Claims cite this value. */
  id: string;
  /** Publication date, `YYYY-MM-DD`. */
  date: string;
  /** Human-readable title, rendered next to citations. */
  title: string;
  /** Full body text. Quote spans must appear verbatim in this string. */
  text: string;
  /** Optional author notes. Never sent to the model or rendered. */
  notes?: string;
}

/** The entity the profile is about. */
export interface Entity {
  name: string;
  /** Other names the sources use for the same entity. */
  aliases?: string[];
}

/** One entry in the profile's source manifest. */
export interface SourceRef {
  id: string;
  date: string;
  title: string;
}

/** One supporting source for a claim, with the verbatim span that supports it. */
export interface Citation {
  /** Must match a `SourceRef.id` in the profile's `sources`. */
  sourceId: string;
  /** Exact substring of that source's `text`. */
  quote: string;
}

/** One atomic, self-contained factual assertion. */
export interface Claim {
  id: string;
  text: string;
  /** At least one; one entry per supporting source. */
  citations: Citation[];
}

/** Whether the sources agree on the answer to a group's question. */
export type GroupStatus = "agreed" | "disputed";

/** Claims that answer the same underlying question. */
export interface ClaimGroup {
  id: string;
  /** The underlying question, phrased as a question. */
  question: string;
  status: GroupStatus;
  /** Ids of member claims. A `disputed` group holds at least two. */
  claimIds: string[];
}

/** The complete structured output of one reconciliation run. */
export interface ReconciledProfile {
  schemaVersion: typeof SCHEMA_VERSION;
  entity: Entity;
  /** RFC 3339 date-time. */
  generatedAt: string;
  /** Model id that produced this profile; absent for hand-written documents. */
  model?: string;
  sources: SourceRef[];
  claims: Claim[];
  groups: ClaimGroup[];
}
