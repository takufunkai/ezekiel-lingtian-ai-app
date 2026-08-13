/**
 * The live `ModelCaller`: one structured-output call through the OpenCode gateway.
 *
 * This is the only module besides `scripts/smoke.ts` that talks to the provider.
 * It targets the beta surface the pinned SDK (0.71.x) actually ships:
 * `client.beta.messages.create` with a top-level `output_format`
 * (`BetaJSONOutputFormat`) — that SDK version has no `output_config.format`.
 *
 * Request shape notes for `claude-opus-5` (verified against current API docs):
 *   - `thinking` is omitted: the model thinks by default, and both
 *     `{type: "enabled", budget_tokens}` and adaptive-style configs are not
 *     expressible/accepted on this SDK+model pairing.
 *   - `temperature`/`top_p`/`top_k` are omitted: the model rejects them (400),
 *     so determinism is pinned via `MODEL` and `DEFAULT_EFFORT` instead.
 */

import { DEFAULT_EFFORT, DEFAULT_MAX_TOKENS, getClient, getModel } from "./client.js";
import type { ModelRequest } from "./engine.js";

/** Beta flag that turns on transport-level structured outputs. */
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-11-13";

/**
 * Sends one reconciliation request and returns the raw text of the response.
 *
 * Throws on transport problems (refusal, truncation, no text) — the engine
 * records a thrown error as a rejected attempt and retries within its bound.
 */
export async function callLiveModel(request: ModelRequest): Promise<string> {
  const client = getClient();

  const response = await client.beta.messages.create({
    model: getModel(),
    max_tokens: DEFAULT_MAX_TOKENS,
    betas: [STRUCTURED_OUTPUTS_BETA],
    output_format: { type: "json_schema", schema: request.outputSchema },
    output_config: { effort: DEFAULT_EFFORT },
    system: request.system,
    messages: [{ role: "user", content: request.userMessage }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("model declined the request (stop_reason: refusal)");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`model output truncated at ${DEFAULT_MAX_TOKENS} tokens`);
  }

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  if (text.length === 0) {
    throw new Error(`model response contained no text (stop_reason: ${response.stop_reason})`);
  }
  return text;
}
