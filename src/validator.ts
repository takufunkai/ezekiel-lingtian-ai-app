/**
 * Deterministic validator for reconciliation output. No LLM anywhere.
 *
 * `validate(profile, sourceDocuments)` is the pure core the engine pipeline (#3)
 * and the test harness (#6) import. It re-checks the JSON Schema first (reusing
 * `validateProfile` from `src/schema.ts`), then runs the referential checks the
 * schema cannot express:
 *
 *   1. every citation's `sourceId` exists in the profile's `sources` manifest
 *      AND among the input documents;
 *   2. every citation's `quote` appears verbatim (exact substring) in the text
 *      of the source it cites;
 *   3. every claim has at least one citation (the schema also catches this — it
 *      is reported as a violation rather than aborting the referential pass);
 *   4. every group's `claimIds` resolve to existing claims, no claim is left
 *      ungrouped, and no claim belongs to two groups;
 *   5. a `disputed` group's member claims together cite at least two distinct
 *      sources.
 *
 * The referential pass traverses the document defensively, so a profile that
 * fails schema validation but still parses produces violations instead of a
 * crash. Case-specific expectations (`requiredSourceIds`, `excludedSourceIds`)
 * are deliberately NOT checked here — they belong to the test harness (#6); the
 * validator is case-independent (profile + documents only).
 *
 * `validateFiles(profilePath, sourcesPath)` is the file-facing wrapper the CLI
 * (`scripts/validate.ts`) uses: it loads the profile and the sources (a
 * directory of source documents, or a fixture-case file whose `documents` are
 * resolved relative to it), reporting malformed JSON and unreadable inputs as
 * violations rather than throwing.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  formatSchemaErrors,
  tryReadJsonFile,
  validateFixtureCase,
  validateProfile,
  validateSourceDocument,
} from "./schema.js";
import type { SourceDocument } from "./contract.js";

/**
 * Machine-readable violation codes.
 *
 * Codes produced by the pure core (`validate`):
 * - `schema` — the profile fails `claims.schema.json` (one violation per error).
 * - `citation-source-not-in-manifest` — a citation's `sourceId` is missing from
 *   the profile's `sources` manifest.
 * - `citation-source-not-in-input` — a citation's `sourceId` matches none of the
 *   input documents.
 * - `manifest-source-not-in-input` — a `sources` manifest entry names a source
 *   that is not among the input documents (a fabricated manifest entry).
 * - `quote-not-verbatim` — a citation's `quote` is not an exact substring of the
 *   cited source's `text`.
 * - `claim-uncited` — a claim has zero citations.
 * - `group-unknown-claim` — a group's `claimIds` references a claim id that does
 *   not exist.
 * - `claim-ungrouped` — a claim belongs to no group.
 * - `claim-in-multiple-groups` — a claim id appears in more than one group.
 * - `duplicate-id` — an id is declared twice (input documents, `sources`
 *   manifest, `claims`, or `groups`), which makes references ambiguous.
 * - `disputed-group-single-source` — a `disputed` group's member claims cite
 *   fewer than two distinct sources between them.
 *
 * Codes produced only by the file-facing layer (`loadSourceDocuments` /
 * `validateFiles`):
 * - `input-missing` — a required file or directory does not exist, or a sources
 *   directory contains no `.json` files.
 * - `input-not-json` — a file exists but is not valid JSON.
 * - `input-invalid-source` — a source document file fails
 *   `source-document.schema.json`.
 * - `input-invalid-case` — the `--sources` file is neither a directory nor a
 *   valid fixture case.
 */
export type ViolationCode =
  | "schema"
  | "citation-source-not-in-manifest"
  | "citation-source-not-in-input"
  | "manifest-source-not-in-input"
  | "quote-not-verbatim"
  | "claim-uncited"
  | "group-unknown-claim"
  | "claim-ungrouped"
  | "claim-in-multiple-groups"
  | "duplicate-id"
  | "disputed-group-single-source"
  | "input-missing"
  | "input-not-json"
  | "input-invalid-source"
  | "input-invalid-case";

/** One machine-readable rule violation. */
export interface Violation {
  code: ViolationCode;
  /**
   * Where the violation sits: a JSON-pointer-style path into the profile
   * (e.g. `/claims/0/citations/1/quote`, `""` for the document root) for
   * validation violations, or the offending file path for `input-*` codes.
   */
  path: string;
  /** Human-readable explanation. The `code` is the field to branch on. */
  message: string;
  /** Id of the claim involved, when one is known. */
  claimId?: string;
  /** Id of the group involved, when one is known. */
  groupId?: string;
  /** Id of the source involved, when one is known. */
  sourceId?: string;
}

/** Result of one validation run. `valid` is true iff `violations` is empty. */
export interface ValidationReport {
  valid: boolean;
  violations: Violation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Validates a reconciliation output against the schema and the referential
 * rules listed in the module doc. Pure: no file system, no network.
 *
 * @param profile the parsed reconciliation JSON (accepted as `unknown` so the
 *   schema re-check is part of this function's job, not the caller's)
 * @param documents the source documents that were the input to the run
 */
export function validate(profile: unknown, documents: readonly SourceDocument[]): ValidationReport {
  const violations: Violation[] = [];

  const schemaResult = validateProfile(profile);
  if (!schemaResult.valid) {
    for (const error of schemaResult.errors) {
      violations.push({
        code: "schema",
        path: error.instancePath,
        message: `${error.instancePath === "" ? "(root)" : error.instancePath} ${error.message ?? "is invalid"}`,
      });
    }
  }

  // Referential checks. Traversal is defensive: fields that are missing or of
  // the wrong type were already reported by the schema pass above, so they are
  // skipped here rather than crashing the run.
  if (!isRecord(profile)) {
    return { valid: violations.length === 0, violations };
  }

  const docById = new Map<string, SourceDocument>();
  for (const doc of documents) {
    if (docById.has(doc.id)) {
      violations.push({
        code: "duplicate-id",
        path: "",
        message: `input documents declare the source id "${doc.id}" more than once`,
        sourceId: doc.id,
      });
      continue;
    }
    docById.set(doc.id, doc);
  }

  // --- sources manifest ---
  const manifestIds = new Set<string>();
  asArray(profile.sources).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const id = asString(entry.id);
    if (id === undefined) return;
    if (manifestIds.has(id)) {
      violations.push({
        code: "duplicate-id",
        path: `/sources/${index}`,
        message: `the sources manifest declares "${id}" more than once`,
        sourceId: id,
      });
    }
    manifestIds.add(id);
    if (!docById.has(id)) {
      violations.push({
        code: "manifest-source-not-in-input",
        path: `/sources/${index}`,
        message: `the sources manifest lists "${id}", which is not among the input documents`,
        sourceId: id,
      });
    }
  });

  // --- claims and citations ---
  const claimById = new Map<string, Record<string, unknown>>();
  asArray(profile.claims).forEach((claim, index) => {
    if (!isRecord(claim)) return;
    const claimId = asString(claim.id);
    if (claimId !== undefined) {
      if (claimById.has(claimId)) {
        violations.push({
          code: "duplicate-id",
          path: `/claims/${index}`,
          message: `the claim id "${claimId}" is declared more than once`,
          claimId,
        });
      } else {
        claimById.set(claimId, claim);
      }
    }

    const citations = asArray(claim.citations);
    if (citations.length === 0) {
      violations.push({
        code: "claim-uncited",
        path: `/claims/${index}/citations`,
        message: `claim "${claimId ?? `#${index}`}" has no citations`,
        ...(claimId !== undefined && { claimId }),
      });
    }

    citations.forEach((citation, citationIndex) => {
      if (!isRecord(citation)) return;
      const sourceId = asString(citation.sourceId);
      if (sourceId === undefined) return;
      const citationPath = `/claims/${index}/citations/${citationIndex}`;

      if (!manifestIds.has(sourceId)) {
        violations.push({
          code: "citation-source-not-in-manifest",
          path: citationPath,
          message: `citation cites "${sourceId}", which is not in the profile's sources manifest`,
          ...(claimId !== undefined && { claimId }),
          sourceId,
        });
      }

      const doc = docById.get(sourceId);
      if (doc === undefined) {
        violations.push({
          code: "citation-source-not-in-input",
          path: citationPath,
          message: `citation cites "${sourceId}", which is not among the input documents`,
          ...(claimId !== undefined && { claimId }),
          sourceId,
        });
        return;
      }

      const quote = asString(citation.quote);
      if (quote !== undefined && !doc.text.includes(quote)) {
        violations.push({
          code: "quote-not-verbatim",
          path: `${citationPath}/quote`,
          message: `quote is not a verbatim substring of source "${sourceId}": "${quote}"`,
          ...(claimId !== undefined && { claimId }),
          sourceId,
        });
      }
    });
  });

  // --- groups ---
  const groupIds = new Set<string>();
  const groupsByClaim = new Map<string, string[]>();
  asArray(profile.groups).forEach((group, index) => {
    if (!isRecord(group)) return;
    const groupId = asString(group.id);
    if (groupId !== undefined) {
      if (groupIds.has(groupId)) {
        violations.push({
          code: "duplicate-id",
          path: `/groups/${index}`,
          message: `the group id "${groupId}" is declared more than once`,
          groupId,
        });
      }
      groupIds.add(groupId);
    }

    const memberIds: string[] = [];
    asArray(group.claimIds).forEach((value, claimIdIndex) => {
      const claimId = asString(value);
      if (claimId === undefined) return;
      if (!claimById.has(claimId)) {
        violations.push({
          code: "group-unknown-claim",
          path: `/groups/${index}/claimIds/${claimIdIndex}`,
          message: `group "${groupId ?? `#${index}`}" references claim "${claimId}", which does not exist`,
          ...(groupId !== undefined && { groupId }),
          claimId,
        });
        return;
      }
      memberIds.push(claimId);
      const memberships = groupsByClaim.get(claimId) ?? [];
      memberships.push(groupId ?? `#${index}`);
      groupsByClaim.set(claimId, memberships);
    });

    // A disputed group must draw on at least two distinct sources between its
    // member claims. Distinctness is by cited sourceId string; whether each id
    // actually resolves is reported separately by the citation checks above.
    if (group.status === "disputed") {
      const distinctSources = new Set<string>();
      for (const claimId of memberIds) {
        for (const citation of asArray(claimById.get(claimId)?.citations)) {
          if (!isRecord(citation)) continue;
          const sourceId = asString(citation.sourceId);
          if (sourceId !== undefined) distinctSources.add(sourceId);
        }
      }
      if (distinctSources.size < 2) {
        violations.push({
          code: "disputed-group-single-source",
          path: `/groups/${index}`,
          message:
            `disputed group "${groupId ?? `#${index}`}" cites ` +
            `${distinctSources.size} distinct source(s); a dispute needs at least 2`,
          ...(groupId !== undefined && { groupId }),
        });
      }
    }
  });

  // --- claim <-> group coverage ---
  const claimIndexById = new Map(
    asArray(profile.claims).flatMap((claim, index) => {
      const id = isRecord(claim) ? asString(claim.id) : undefined;
      return id === undefined ? [] : [[id, index] as const];
    }),
  );
  for (const [claimId, index] of claimIndexById) {
    const memberships = groupsByClaim.get(claimId) ?? [];
    if (memberships.length === 0) {
      violations.push({
        code: "claim-ungrouped",
        path: `/claims/${index}`,
        message: `claim "${claimId}" belongs to no group`,
        claimId,
      });
    } else if (memberships.length > 1) {
      violations.push({
        code: "claim-in-multiple-groups",
        path: `/claims/${index}`,
        message: `claim "${claimId}" belongs to ${memberships.length} groups: ${memberships.join(", ")}`,
        claimId,
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

/** Source documents loaded from disk, plus any problems hit while loading. */
export interface LoadedSources {
  documents: SourceDocument[];
  violations: Violation[];
}

/** Loads one source-document file, reporting problems as violations. */
function loadSourceDocument(path: string, into: LoadedSources): void {
  if (!existsSync(path)) {
    into.violations.push({
      code: "input-missing",
      path,
      message: "source document file does not exist",
    });
    return;
  }
  const parsed = tryReadJsonFile(path);
  if (!parsed.ok) {
    into.violations.push({
      code: "input-not-json",
      path,
      message: `not valid JSON: ${parsed.error}`,
    });
    return;
  }
  const result = validateSourceDocument(parsed.data);
  if (!result.valid) {
    into.violations.push({
      code: "input-invalid-source",
      path,
      message: `does not match source-document.schema.json: ${formatSchemaErrors(result.errors).join("; ")}`,
    });
    return;
  }
  into.documents.push(result.data);
}

/**
 * Loads the input source documents named by `--sources`: either a directory of
 * `*.json` source-document files, or a fixture-case file whose `documents` are
 * resolved relative to it. Never throws — every problem becomes a violation.
 */
export function loadSourceDocuments(sourcesPath: string): LoadedSources {
  const loaded: LoadedSources = { documents: [], violations: [] };

  if (!existsSync(sourcesPath)) {
    loaded.violations.push({
      code: "input-missing",
      path: sourcesPath,
      message: "sources path does not exist",
    });
    return loaded;
  }

  if (statSync(sourcesPath).isDirectory()) {
    const names = readdirSync(sourcesPath)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (names.length === 0) {
      loaded.violations.push({
        code: "input-missing",
        path: sourcesPath,
        message: "sources directory contains no .json files",
      });
      return loaded;
    }
    for (const name of names) {
      loadSourceDocument(join(sourcesPath, name), loaded);
    }
    return loaded;
  }

  const parsed = tryReadJsonFile(sourcesPath);
  if (!parsed.ok) {
    loaded.violations.push({
      code: "input-not-json",
      path: sourcesPath,
      message: `not valid JSON: ${parsed.error}`,
    });
    return loaded;
  }
  const caseResult = validateFixtureCase(parsed.data);
  if (!caseResult.valid) {
    loaded.violations.push({
      code: "input-invalid-case",
      path: sourcesPath,
      message:
        "is neither a directory nor a valid fixture case: " +
        formatSchemaErrors(caseResult.errors).join("; "),
    });
    return loaded;
  }
  const caseDir = dirname(sourcesPath);
  for (const ref of caseResult.data.documents) {
    loadSourceDocument(join(caseDir, ref), loaded);
  }
  return loaded;
}

/**
 * File-facing validation used by the CLI: loads the profile and the sources,
 * then runs {@link validate}. Input problems (missing files, malformed JSON,
 * invalid source documents) are reported as violations alongside the
 * validation results. When some source files fail to load, the citation checks
 * run against the documents that did load — the `input-*` violation explains
 * any knock-on `citation-source-not-in-input` findings.
 */
export function validateFiles(profilePath: string, sourcesPath: string): ValidationReport {
  const violations: Violation[] = [];

  const sources = loadSourceDocuments(sourcesPath);
  violations.push(...sources.violations);

  if (!existsSync(profilePath)) {
    violations.push({
      code: "input-missing",
      path: profilePath,
      message: "profile file does not exist",
    });
    return { valid: false, violations };
  }
  const parsed = tryReadJsonFile(profilePath);
  if (!parsed.ok) {
    violations.push({
      code: "input-not-json",
      path: profilePath,
      message: `not valid JSON: ${parsed.error}`,
    });
    return { valid: false, violations };
  }

  violations.push(...validate(parsed.data, sources.documents).violations);
  return { valid: violations.length === 0, violations };
}
