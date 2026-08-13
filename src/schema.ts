/**
 * Loads the JSON Schemas in `schema/` and exposes compiled validators.
 *
 * This is *schema* validation only — it answers "is this document shaped like the
 * contract?". The deterministic checks that need the source texts (every cited id
 * exists, every quote appears verbatim, every claim is grouped) belong to the
 * validator epic and live elsewhere.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as ajvFormatsModule from "ajv-formats";
import type { FixtureCase, ReconciledProfile, SourceDocument } from "./contract.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository's `schema/` directory. */
export const SCHEMA_DIR = join(here, "..", "schema");

export const CLAIMS_SCHEMA_PATH = join(SCHEMA_DIR, "claims.schema.json");
export const SOURCE_DOCUMENT_SCHEMA_PATH = join(SCHEMA_DIR, "source-document.schema.json");
export const FIXTURE_CASE_SCHEMA_PATH = join(SCHEMA_DIR, "fixture-case.schema.json");

/** Reads and parses a JSON file. Throws on malformed JSON. */
export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Reads a JSON file without throwing on malformed input.
 *
 * The fixture corpus is hand-written, so a trailing comma is a likely mistake.
 * Callers report it as a failure alongside schema violations rather than dying
 * with a stack trace part-way through a run.
 */
export function tryReadJsonFile(path: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const claimsSchema = readJsonFile(CLAIMS_SCHEMA_PATH) as Record<string, unknown>;
export const sourceDocumentSchema = readJsonFile(SOURCE_DOCUMENT_SCHEMA_PATH) as Record<
  string,
  unknown
>;
export const fixtureCaseSchema = readJsonFile(FIXTURE_CASE_SCHEMA_PATH) as Record<string, unknown>;

// ajv-formats ships CJS, so its callable export sits behind `.default` under Node ESM.
const addFormats = (ajvFormatsModule as unknown as { default: (ajv: Ajv2020) => void }).default;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const validateProfileFn: ValidateFunction = ajv.compile(claimsSchema);
const validateSourceDocumentFn: ValidateFunction = ajv.compile(sourceDocumentSchema);
const validateFixtureCaseFn: ValidateFunction = ajv.compile(fixtureCaseSchema);

/** Result of a schema check. Never throws — callers decide what a failure means. */
export type SchemaResult<T> =
  { valid: true; data: T; errors: [] } | { valid: false; data: null; errors: ErrorObject[] };

function run<T>(validate: ValidateFunction, data: unknown): SchemaResult<T> {
  if (validate(data)) {
    return { valid: true, data: data as T, errors: [] };
  }
  return { valid: false, data: null, errors: validate.errors ?? [] };
}

/** Checks a document against `schema/claims.schema.json`. */
export function validateProfile(data: unknown): SchemaResult<ReconciledProfile> {
  return run<ReconciledProfile>(validateProfileFn, data);
}

/** Checks a document against `schema/source-document.schema.json`. */
export function validateSourceDocument(data: unknown): SchemaResult<SourceDocument> {
  return run<SourceDocument>(validateSourceDocumentFn, data);
}

/** Checks a document against `schema/fixture-case.schema.json`. */
export function validateFixtureCase(data: unknown): SchemaResult<FixtureCase> {
  return run<FixtureCase>(validateFixtureCaseFn, data);
}

/** Renders ajv errors as one human-readable line each. */
export function formatSchemaErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    return `${where} ${error.message ?? "is invalid"}`;
  });
}
