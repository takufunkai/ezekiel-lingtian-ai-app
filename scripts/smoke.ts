#!/usr/bin/env tsx
/**
 * Live gateway smoke test — `npm run smoke`.
 *
 * Makes ONE tiny beta structured-output call and prints what the gateway
 * supports: does it serve the configured model, and does it pass
 * transport-level structured outputs through? Requires `OPENCODE_API_KEY` in
 * `.env`; exits 2 without making any call when the key is missing. Never
 * wired into CI.
 */

import { DEFAULT_EFFORT, getBaseUrl, getClient, getModel, hasApiKey } from "../src/client.js";
import { STRUCTURED_OUTPUTS_BETA } from "../src/model-caller.js";

const tinySchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "modelFamily"],
  properties: {
    ok: { type: "boolean" },
    modelFamily: { type: "string" },
  },
};

if (!hasApiKey()) {
  console.error("smoke: OPENCODE_API_KEY is not set (copy .env.example to .env). No call made.");
  process.exit(2);
}

const model = getModel();

console.log(`smoke: gateway   ${getBaseUrl()}`);
console.log(`smoke: model     ${model}`);
console.log(`smoke: beta      ${STRUCTURED_OUTPUTS_BETA}`);
console.log(`smoke: effort    ${DEFAULT_EFFORT}`);

try {
  const response = await getClient().beta.messages.create({
    model,
    max_tokens: 256,
    betas: [STRUCTURED_OUTPUTS_BETA],
    output_format: { type: "json_schema", schema: tinySchema },
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: 'Reply with JSON: set "ok" to true and "modelFamily" to the model family you are.',
      },
    ],
  });

  console.log(`smoke: served-by   ${response.model}`);
  console.log(`smoke: stop_reason ${response.stop_reason}`);
  console.log(
    `smoke: usage       in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  );

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  console.log(`smoke: text        ${text}`);

  const servesModel = response.model.includes(model);
  let structuredOk = false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    structuredOk = typeof parsed.ok === "boolean" && typeof parsed.modelFamily === "string";
  } catch {
    structuredOk = false;
  }

  console.log(`smoke: gateway serves ${model}:            ${servesModel ? "yes" : "UNCLEAR"}`);
  console.log(`smoke: structured output passed through:  ${structuredOk ? "yes" : "NO"}`);
  process.exit(structuredOk ? 0 : 1);
} catch (error) {
  const status = (error as { status?: number }).status;
  console.error(`smoke: FAILED${status === undefined ? "" : ` (HTTP ${status})`}`);
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
