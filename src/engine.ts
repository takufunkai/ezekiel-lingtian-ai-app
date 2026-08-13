/**
 * Claim extraction & reconciliation engine — the app's single LLM stage.
 *
 * Flow: load a fixture case file → load ONLY its referenced source documents →
 * build the prompt from model inputs (`toModelInput` strips author notes; the
 * case manifest — `expect`, `plantedFact`, `notes` — never crosses into prompt
 * construction) → call the model → validate the output against
 * `schema/claims.schema.json` with the compiled ajv validator.
 *
 * Schema violations are rejected and retried with bounded attempts — never
 * patched. After the last attempt the run fails hard with every attempt's
 * reasons logged; the CLI turns that into a non-zero exit.
 *
 * The model call is injected (`ModelCaller`), so the whole pipeline is testable
 * offline with canned responses. The live caller lives in `model-caller.ts`.
 */

import { dirname, join, resolve } from "node:path";
import { getModel } from "./client.js";
import type {
  Entity,
  FixtureCase,
  ModelSourceDocument,
  ReconciledProfile,
  SourceDocument,
} from "./contract.js";
import { toModelInput } from "./contract.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.js";
import {
  claimsSchema,
  formatSchemaErrors,
  tryReadJsonFile,
  validateFixtureCase,
  validateProfile,
  validateSourceDocument,
} from "./schema.js";

/** One request to the model. Everything the transport needs, nothing more. */
export interface ModelRequest {
  /** The versioned system prompt. */
  system: string;
  /** The user message: entity + stripped documents as deterministic JSON. */
  userMessage: string;
  /** Schema for transport-level structured output (already transport-sanitised). */
  outputSchema: Record<string, unknown>;
}

/**
 * The transport seam: takes one request, returns the model's raw text output.
 * The live implementation is `callLiveModel` in `model-caller.ts`; tests inject
 * canned responses.
 */
export type ModelCaller = (request: ModelRequest) => Promise<string>;

/** Attempts before the run fails hard. Bounded, and deliberately small. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface ReconcileOptions {
  callModel: ModelCaller;
  /** Total attempts (first try included). Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Where rejection reasons go. Defaults to stderr. */
  log?: (line: string) => void;
}

/** Why one attempt was rejected. */
export interface AttemptFailure {
  attempt: number;
  reasons: string[];
}

export type ReconcileOutcome =
  | { ok: true; profile: ReconciledProfile; attempts: number; failures: AttemptFailure[] }
  | { ok: false; attempts: number; failures: AttemptFailure[] };

/** A fixture case together with its loaded source documents. */
export interface LoadedCase {
  fixtureCase: FixtureCase;
  documents: SourceDocument[];
}

export type LoadCaseResult = { ok: true; value: LoadedCase } | { ok: false; errors: string[] };

/**
 * Loads a case file and every source document it references.
 *
 * Only schema-level checks happen here; the deterministic cross-checks (quotes
 * verbatim, cited ids exist) belong to the validator epic.
 */
export function loadCaseWithDocuments(casePath: string): LoadCaseResult {
  const absoluteCasePath = resolve(casePath);
  const parsed = tryReadJsonFile(absoluteCasePath);
  if (!parsed.ok) {
    return { ok: false, errors: [`case file: ${parsed.error}`] };
  }

  const caseResult = validateFixtureCase(parsed.data);
  if (!caseResult.valid) {
    return {
      ok: false,
      errors: formatSchemaErrors(caseResult.errors).map((line) => `case file: ${line}`),
    };
  }

  const fixtureCase = caseResult.data;
  const caseDir = dirname(absoluteCasePath);
  const documents: SourceDocument[] = [];
  const errors: string[] = [];

  for (const ref of fixtureCase.documents) {
    const docParsed = tryReadJsonFile(join(caseDir, ref));
    if (!docParsed.ok) {
      errors.push(`document "${ref}": ${docParsed.error}`);
      continue;
    }
    const docResult = validateSourceDocument(docParsed.data);
    if (!docResult.valid) {
      errors.push(
        ...formatSchemaErrors(docResult.errors).map((line) => `document "${ref}": ${line}`),
      );
      continue;
    }
    documents.push(docResult.data);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { fixtureCase, documents } };
}

/**
 * The single projection from a loaded case to model input.
 *
 * Only the entity and the stripped documents cross this line. The manifest —
 * `expect`, `plantedFact`, `scenario`, `notes` — is the answer key and stays
 * behind it; prompt construction (`buildUserMessage`) accepts nothing else.
 */
export function caseToModelInput(loaded: LoadedCase): {
  entity: Entity;
  documents: ModelSourceDocument[];
} {
  const { entity } = loaded.fixtureCase;
  return {
    // Copied field by field for the same reason as toModelInput: a field added
    // to the case's entity later must opt in here to reach the model.
    entity: entity.aliases ? { name: entity.name, aliases: entity.aliases } : { name: entity.name },
    documents: loaded.documents.map(toModelInput),
  };
}

/**
 * JSON Schema keywords the structured-outputs transport does not accept.
 * They are stripped from the wire schema only — ajv still enforces the full
 * contract locally, and a violation is rejected and retried.
 */
const TRANSPORT_UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "allOf",
  "if",
  "then",
  "else",
]);

function stripUnsupported(node: unknown, isNameMap: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => stripUnsupported(entry, false));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!isNameMap && TRANSPORT_UNSUPPORTED_KEYWORDS.has(key)) {
      continue;
    }
    // Under `properties` and `$defs` the keys are names, not keywords — never
    // strip them, and their values are schemas again.
    const childIsNameMap = !isNameMap && (key === "properties" || key === "$defs");
    out[key] = stripUnsupported(value, childIsNameMap);
  }
  return out;
}

/**
 * Derives the wire schema for transport-level structured output from a full
 * contract schema. Best-effort enforcement only — the authoritative check is
 * `validateProfile` against the unmodified schema.
 */
export function toTransportSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return stripUnsupported(schema, false) as Record<string, unknown>;
}

/** The wire schema for reconciliation runs, derived from claims.schema.json. */
export const CLAIMS_TRANSPORT_SCHEMA = toTransportSchema(claimsSchema);

/**
 * Runs one reconciliation: prompt the model, validate, retry on violation.
 *
 * Each attempt sends the identical request. A schema-invalid response is never
 * repaired — it is logged and thrown away, and after `maxAttempts` rejections
 * the outcome is a hard failure carrying every attempt's reasons.
 */
export async function reconcile(
  loaded: LoadedCase,
  options: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const { callModel, maxAttempts = DEFAULT_MAX_ATTEMPTS } = options;
  const log = options.log ?? ((line: string) => console.error(line));

  const { entity, documents } = caseToModelInput(loaded);
  const request: ModelRequest = {
    system: SYSTEM_PROMPT,
    userMessage: buildUserMessage(entity, documents),
    outputSchema: CLAIMS_TRANSPORT_SCHEMA,
  };

  const failures: AttemptFailure[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reject = (reasons: string[]): void => {
      failures.push({ attempt, reasons });
      for (const reason of reasons) {
        log(`attempt ${attempt}/${maxAttempts} rejected: ${reason}`);
      }
    };

    let raw: string;
    try {
      raw = await callModel(request);
    } catch (error) {
      reject([`model call failed: ${error instanceof Error ? error.message : String(error)}`]);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      reject([
        `model output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
      continue;
    }

    const result = validateProfile(parsed);
    if (!result.valid) {
      reject(formatSchemaErrors(result.errors).map((line) => `schema violation: ${line}`));
      continue;
    }

    // Schema-valid. Stamp the run metadata; claim content is never touched.
    // getModel(), not the MODEL fallback constant: the profile must record the
    // model that actually produced it.
    const profile: ReconciledProfile = { ...result.data, model: getModel() };
    return { ok: true, profile, attempts: attempt, failures };
  }

  log(`giving up: ${maxAttempts} attempt(s) all failed schema validation`);
  return { ok: false, attempts: maxAttempts, failures };
}

export type CaseRunOutcome =
  | { ok: true; profile: ReconciledProfile; attempts: number }
  | { ok: false; stage: "load" | "model"; errors: string[] };

/** Convenience wrapper: load a case file, reconcile it, flatten the outcome. */
export async function reconcileCaseFile(
  casePath: string,
  options: ReconcileOptions,
): Promise<CaseRunOutcome> {
  const loaded = loadCaseWithDocuments(casePath);
  if (!loaded.ok) {
    return { ok: false, stage: "load", errors: loaded.errors };
  }

  const outcome = await reconcile(loaded.value, options);
  if (!outcome.ok) {
    return {
      ok: false,
      stage: "model",
      errors: outcome.failures.flatMap((failure) =>
        failure.reasons.map((reason) => `attempt ${failure.attempt}: ${reason}`),
      ),
    };
  }
  return { ok: true, profile: outcome.profile, attempts: outcome.attempts };
}
