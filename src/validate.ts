/**
 * Deterministic validation of a reconciled profile against the sources it cites.
 *
 * No model call happens here and none ever should: every check below is plain
 * code over the profile document and the input source texts. That is the whole
 * point of this module — it turns "the model hallucinated" from a vibe into a
 * specific, machine-readable violation with a JSON Pointer to the offending span.
 *
 * Schema shape is delegated to `validateProfile` in `./schema.js`. What lives here
 * are the cross-document checks a JSON Schema cannot express, because they need
 * the source texts the profile was produced from.
 *
 * Two source lists are in play and they must agree. The input set — the documents
 * actually supplied to the run — is the ground truth for whether a document exists
 * and what it says. The profile's own `sources` manifest is a *claim about* that
 * set, and the renderer resolves citation markers through it, so a citation the
 * manifest omits renders as an unresolvable marker. Both directions are checked.
 *
 * The semantic checks run even when the schema check fails, reading the document
 * defensively rather than trusting its shape. A profile with an uncited claim is
 * both a schema violation and a citation violation, and reporting only the former
 * would hide the interesting half.
 */

import { formatSchemaErrors, validateProfile } from "./schema.js";
import type { SourceDocument } from "./contract.js";

/** Every violation this validator can report. */
export const VIOLATION_CODES = [
  "SCHEMA_INVALID",
  "MANIFEST_SOURCE_NOT_IN_INPUT",
  "DUPLICATE_CLAIM_ID",
  "CLAIM_NO_CITATIONS",
  "UNKNOWN_SOURCE_ID",
  "SOURCE_NOT_IN_MANIFEST",
  "QUOTE_NOT_VERBATIM",
  "UNRESOLVED_CLAIM_ID",
  "DISPUTED_GROUP_UNDER_SOURCED",
  "CLAIM_NOT_GROUPED",
] as const;

export type ViolationCode = (typeof VIOLATION_CODES)[number];

/**
 * `error` fails the run. `warning` is a quality signal that does not, unless the
 * caller passes `strict`.
 */
export type ViolationSeverity = "error" | "warning";

/** One problem found in the profile. */
export interface Violation {
  code: ViolationCode;
  severity: ViolationSeverity;
  /** One line, safe to print. Names the ids and the offending value. */
  message: string;
  /** JSON Pointer (RFC 6901) into the profile document; `""` is the document root. */
  path: string;
  /** The claim, group, or source id this violation is about, when there is one. */
  subjectId?: string;
}

export interface ValidationReport {
  /** True when nothing blocking was found. This is what the CLI's exit code follows. */
  ok: boolean;
  errorCount: number;
  warningCount: number;
  /**
   * Deterministic order, following the document: schema errors, then the source
   * manifest, then claims, then groups, then grouping coverage. Within each of
   * those, array order. Same input, same report.
   */
  violations: Violation[];
}

export interface ValidateOutputOptions {
  /** Promote warnings to failures, so an ungrouped claim also fails the run. */
  strict?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a field as an array, treating anything else as empty. */
function readArray(container: Record<string, unknown>, key: string): unknown[] {
  const value = container[key];
  return Array.isArray(value) ? value : [];
}

/** Reads a field as a string, or `undefined` if it is missing or another type. */
function readString(container: Record<string, unknown>, key: string): string | undefined {
  const value = container[key];
  return typeof value === "string" ? value : undefined;
}

/** Shortens a quote for a one-line message without hiding which quote it was. */
function excerpt(value: string, limit = 60): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Explains a near miss, when there was one.
 *
 * The check itself stays strict — a quote that matches only after case folding or
 * whitespace normalisation is still not verbatim, and still fails. This only makes
 * the message actionable, because "the model reflowed the whitespace" and "the
 * model invented the sentence" want very different fixes.
 */
function nearMissHint(text: string, quote: string): string {
  if (text.toLowerCase().includes(quote.toLowerCase())) {
    return " (differs only in letter case)";
  }
  const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
  if (collapse(text).includes(collapse(quote))) {
    return " (differs only in whitespace)";
  }
  return "";
}

/**
 * Checks a reconciled profile against the source documents that produced it.
 *
 * `sources` is the authoritative input set: the documents actually supplied to the
 * run. A citation naming anything else is a fabrication, and a manifest entry
 * naming anything else is an invented document.
 *
 * Never throws, never reads the filesystem, and never calls a model. `profile` is
 * `unknown` on purpose so a raw `JSON.parse` result can be passed straight in.
 */
export function validateOutput(
  profile: unknown,
  sources: readonly SourceDocument[],
  options: ValidateOutputOptions = {},
): ValidationReport {
  const strict = options.strict === true;
  const violations: Violation[] = [];

  const schema = validateProfile(profile);
  for (const error of schema.errors) {
    const [line] = formatSchemaErrors([error]);
    violations.push({
      code: "SCHEMA_INVALID",
      severity: "error",
      message: `does not match claims.schema.json: ${line ?? "is invalid"}`,
      path: error.instancePath,
    });
  }

  const document: Record<string, unknown> = isRecord(profile) ? profile : {};
  const sourceTexts = new Map(sources.map((source) => [source.id, source.text]));

  // The manifest is a claim about the input set, and the renderer resolves citation
  // markers through it, so an entry naming a document nobody supplied is a made-up
  // provenance line that will be rendered to a reader as if it were real. Unlike an
  // ungrouped claim, it asserts the existence of something that does not exist, so
  // it is an error even when no claim cites it.
  const manifestIds = new Set<string>();
  for (const [sourceIndex, entry] of readArray(document, "sources").entries()) {
    if (!isRecord(entry)) continue;

    const sourceId = readString(entry, "id");
    if (sourceId === undefined) continue;
    manifestIds.add(sourceId);

    if (!sourceTexts.has(sourceId)) {
      violations.push({
        code: "MANIFEST_SOURCE_NOT_IN_INPUT",
        severity: "error",
        message: `the sources manifest lists "${sourceId}", which was never supplied as an input document`,
        path: `/sources/${sourceIndex}/id`,
        subjectId: sourceId,
      });
    }
  }

  // First pass over the claims: the citation checks, plus the two indexes the group
  // checks need — claim id to its position, and each claim's cited input sources.
  // The second index is keyed by *position*, not id: two claims sharing an id must
  // not pool their sources into one inflated total (see DUPLICATE_CLAIM_ID below).
  const claimPositions = new Map<string, number>();
  const citedSourceIds = new Map<number, Set<string>>();

  for (const [claimIndex, entry] of readArray(document, "claims").entries()) {
    if (!isRecord(entry)) continue;

    const claimPath = `/claims/${claimIndex}`;
    const claimId = readString(entry, "id");
    const claim = claimId ?? claimPath;
    if (claimId !== undefined) {
      // `claims.schema.json` has no uniqueness constraint on claim ids, so this has
      // to be caught here. A shared id makes `claimIds` ambiguous: a group naming it
      // cannot say which claim it means, and the resolution below has to pick one.
      if (claimPositions.has(claimId)) {
        violations.push({
          code: "DUPLICATE_CLAIM_ID",
          severity: "error",
          message: `claim id "${claimId}" is used by more than one claim, so a group listing it cannot say which one it means`,
          path: `${claimPath}/id`,
          subjectId: claimId,
        });
      } else {
        claimPositions.set(claimId, claimIndex);
      }
    }

    const citations = readArray(entry, "citations");
    if (citations.length === 0) {
      violations.push({
        code: "CLAIM_NO_CITATIONS",
        severity: "error",
        message: `claim ${claim} carries no citation, so nothing in the sources supports it`,
        path: `${claimPath}/citations`,
        subjectId: claimId,
      });
    }

    for (const [citationIndex, raw] of citations.entries()) {
      if (!isRecord(raw)) continue;

      const citationPath = `${claimPath}/citations/${citationIndex}`;
      const sourceId = readString(raw, "sourceId");
      if (sourceId === undefined) continue;

      const text = sourceTexts.get(sourceId);
      if (text === undefined) {
        violations.push({
          code: "UNKNOWN_SOURCE_ID",
          severity: "error",
          message: `claim ${claim} cites "${sourceId}", which is not one of the ${sources.length} input source document(s)`,
          path: `${citationPath}/sourceId`,
          subjectId: claimId,
        });
        continue;
      }

      // Only real sources count towards a group's source spread, so a dispute
      // propped up by a fabricated id is reported as under-sourced as well.
      const cited = citedSourceIds.get(claimIndex) ?? new Set<string>();
      cited.add(sourceId);
      citedSourceIds.set(claimIndex, cited);

      // The document exists, but the profile's own manifest does not admit to it.
      // The renderer resolves citation markers through the manifest, so this is the
      // difference between a footnote and an unresolvable marker on the page.
      if (!manifestIds.has(sourceId)) {
        violations.push({
          code: "SOURCE_NOT_IN_MANIFEST",
          severity: "error",
          message: `claim ${claim} cites input document "${sourceId}", which the profile's own sources manifest omits, so the citation cannot be resolved`,
          path: `${citationPath}/sourceId`,
          subjectId: claimId,
        });
      }

      const quote = readString(raw, "quote");
      if (quote === undefined) continue;
      if (!text.includes(quote)) {
        violations.push({
          code: "QUOTE_NOT_VERBATIM",
          severity: "error",
          message: `claim ${claim} quotes "${excerpt(quote)}", which is not a verbatim substring of ${sourceId}${nearMissHint(text, quote)}`,
          path: `${citationPath}/quote`,
          subjectId: claimId,
        });
      }
    }
  }

  const groupedClaimIds = new Set<string>();

  for (const [groupIndex, entry] of readArray(document, "groups").entries()) {
    if (!isRecord(entry)) continue;

    const groupPath = `/groups/${groupIndex}`;
    const groupId = readString(entry, "id");
    const group = groupId ?? groupPath;
    const spread = new Set<string>();

    for (const [memberIndex, memberId] of readArray(entry, "claimIds").entries()) {
      if (typeof memberId !== "string") continue;
      groupedClaimIds.add(memberId);

      const position = claimPositions.get(memberId);
      if (position === undefined) {
        violations.push({
          code: "UNRESOLVED_CLAIM_ID",
          severity: "error",
          message: `group ${group} lists claim id "${memberId}", which matches no claim in the profile`,
          path: `${groupPath}/claimIds/${memberIndex}`,
          subjectId: groupId,
        });
        continue;
      }

      // Deliberately the sources of the *one* claim the id resolves to, so a
      // duplicate id cannot lend a group evidence from a second claim.
      for (const sourceId of citedSourceIds.get(position) ?? []) spread.add(sourceId);
    }

    if (readString(entry, "status") === "disputed" && spread.size < 2) {
      violations.push({
        code: "DISPUTED_GROUP_UNDER_SOURCED",
        severity: "error",
        message: `disputed group ${group} draws on ${spread.size} input source(s); a real dispute needs at least two, otherwise it is one document arguing with itself`,
        path: `${groupPath}/claimIds`,
        subjectId: groupId,
      });
    }
  }

  // A claim in no group is a coverage defect, not a fabrication: everything it
  // says is still cited and verbatim, it is simply dropped by the renderer, which
  // walks groups. Grouping every claim is not part of the contract either — the
  // schema says nothing about the union of `claimIds` covering `claims`. So this
  // is a warning that `--strict` can promote, not a hard failure that would sink
  // an otherwise honest profile. Keyed by id, so a claim that is unreachable only
  // because it shares an id is reported as DUPLICATE_CLAIM_ID instead — the same
  // defect, named accurately.
  for (const [claimId, claimIndex] of claimPositions) {
    if (groupedClaimIds.has(claimId)) continue;
    violations.push({
      code: "CLAIM_NOT_GROUPED",
      severity: "warning",
      message: `claim ${claimId} belongs to no group, so the rendered profile will never show it`,
      path: `/claims/${claimIndex}`,
      subjectId: claimId,
    });
  }

  const errorCount = violations.filter((violation) => violation.severity === "error").length;
  const warningCount = violations.length - errorCount;

  return {
    ok: errorCount === 0 && (!strict || warningCount === 0),
    errorCount,
    warningCount,
    violations,
  };
}

/** One line per violation, in report order. Shared by the CLI and the tests. */
export function formatViolations(report: ValidationReport): string[] {
  return report.violations.map((violation) => {
    const label = violation.severity === "error" ? "error" : "warn ";
    const where = violation.path === "" ? "(root)" : violation.path;
    return `${label}  ${violation.code}  ${where}  ${violation.message}`;
  });
}
