import { deepFreeze } from "./freeze.js";
import { isRecord } from "./guards.js";
import type { ModelProposal, PayeeHint } from "./types.js";

/** Unicode code points, as JSON Schema `maxLength` counts them (not UTF-16 units). */
export const MAX_REASONING_CHARS = 2000;

export class ProposalParseError extends Error {
  override name = "ProposalParseError";
}

/**
 * JSON schema sent as `response_format.json_schema.schema` to NEAR AI Cloud. It is part of the request
 * bytes that check A8 rebuilds, so it is deep-frozen: nothing in the process can change it.
 */
export const MODEL_PROPOSAL_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["action", "mandate_id", "amount", "payee_hint", "reasoning", "confidence"],
  properties: {
    action: { type: "string", enum: ["pay", "hold", "refuse"] },
    mandate_id: { type: ["integer", "null"], minimum: 1 }, // vault mandate ids start at 1
    amount: { type: ["string", "null"], pattern: "^[1-9][0-9]*$" },
    payee_hint: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            near_account: { type: "string" },
            chain: { type: "string", enum: ["base", "solana"] },
            address: { type: "string" },
            name: { type: "string" },
          },
        },
      ],
    },
    reasoning: { type: "string", maxLength: MAX_REASONING_CHARS },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const);

/**
 * Keeps the first `max` code points. A cut by UTF-16 units can split a surrogate pair and leave a lone
 * surrogate, which canonicalJson refuses, so a model answer could then never be written to the ledger.
 */
function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text; // units >= code points, so this is already short enough
  let count = 0;
  let end = 0;
  for (const point of text) {
    if (count === max) break;
    count += 1;
    end += point.length;
  }
  return text.slice(0, end);
}

/** Matches only a lone surrogate: with the u flag a valid pair is one code point outside this range. */
const LONE_SURROGATE_RE = /[\u{D800}-\u{DFFF}]/u;

/**
 * canonicalJson refuses a lone surrogate, so one that reached the ledger body would make writing the
 * entry throw. A model answer holding one (the JSON escape \ud800) fails here, at parse time, instead.
 */
function assertWellFormed(text: string, field: string): void {
  if (LONE_SURROGATE_RE.test(text)) {
    throw new ProposalParseError(`${field} contains a lone surrogate (ill-formed Unicode)`);
  }
}

function parseHint(value: unknown): PayeeHint | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new ProposalParseError("payee_hint must be an object or null");
  const hint: PayeeHint = {};
  for (const key of ["near_account", "address", "name"] as const) {
    const field = value[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== "string")
      throw new ProposalParseError(`payee_hint.${key} must be a string`);
    assertWellFormed(field, `payee_hint.${key}`);
    hint[key] = field;
  }
  const chain = value.chain;
  if (chain !== undefined && chain !== null) {
    if (chain !== "base" && chain !== "solana")
      throw new ProposalParseError("payee_hint.chain must be base or solana");
    hint.chain = chain;
  }
  return hint;
}

export function parseModelProposal(value: unknown): ModelProposal {
  if (!isRecord(value)) throw new ProposalParseError("proposal must be a JSON object");
  const action = value.action;
  if (action !== "pay" && action !== "hold" && action !== "refuse") {
    throw new ProposalParseError("action must be pay, hold or refuse");
  }
  let mandateId: number | null = null;
  const rawMandate = value.mandate_id;
  if (rawMandate !== null && rawMandate !== undefined) {
    if (typeof rawMandate !== "number" || !Number.isSafeInteger(rawMandate) || rawMandate < 1) {
      throw new ProposalParseError("mandate_id must be an integer >= 1 or null");
    }
    mandateId = rawMandate;
  }
  let amount: string | null = null;
  const rawAmount = value.amount;
  if (rawAmount !== null && rawAmount !== undefined) {
    if (typeof rawAmount !== "string" || !/^[1-9][0-9]{0,38}$/.test(rawAmount)) {
      throw new ProposalParseError(
        "amount must be a positive integer string in smallest units, or null",
      );
    }
    amount = rawAmount;
  }
  const reasoning = value.reasoning;
  if (typeof reasoning !== "string") throw new ProposalParseError("reasoning must be a string");
  assertWellFormed(reasoning, "reasoning");
  const confidence = value.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new ProposalParseError("confidence must be a number in [0, 1]");
  }
  return {
    action,
    mandate_id: mandateId,
    amount,
    payee_hint: parseHint(value.payee_hint),
    reasoning: truncateCodePoints(reasoning, MAX_REASONING_CHARS),
    confidence,
  };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Model content may wrap the JSON in prose or <think> blocks; take the outermost object. A <think> block
 * that is never closed runs to the end of the text and is dropped with everything after it.
 */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== "string") throw new ProposalParseError("model output is not text");
  const direct = tryParse(text.trim());
  if (direct.ok) return direct.value;
  const cleaned = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new ProposalParseError("no JSON object in the model output");
  const inner = tryParse(cleaned.slice(start, end + 1));
  if (!inner.ok) throw new ProposalParseError("model output is not valid JSON");
  return inner.value;
}
