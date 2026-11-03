import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/hash.js";
import { extractJsonObject, ProposalParseError, parseModelProposal } from "../src/proposal.js";

// GOLDEN VECTORS FOR LEDGER v 1 (interfaces section 7, "Parser contract (A7)").
//
// Check A7 re-runs extractJsonObject and parseModelProposal on the model response that is stored in every
// ledger entry, long after the entry was written. What those two functions accept, how they normalise and
// where they cut the reasoning is therefore part of what an old entry means. They are frozen for ledger `v` 1.
//
// If a test in this file fails, a behaviour change reached the verifier. Do NOT edit the expected values to
// match it. A change needs a new ledger `v`, and A7 must then dispatch on the entry's `v` so that every
// existing entry still verifies as it did.

const FULL =
  '{"action":"pay","mandate_id":1,"amount":"25000000","payee_hint":{"near_account":"vendor.testnet","name":"Vendor"},"reasoning":"Matches PO-1001.","confidence":0.92}';

const FULL_PARSED = {
  action: "pay",
  mandate_id: 1,
  amount: "25000000",
  payee_hint: { near_account: "vendor.testnet", name: "Vendor" },
  reasoning: "Matches PO-1001.",
  confidence: 0.92,
};

/** canonicalJson of FULL_PARSED and its sha256: what A7 compares for every one of the "pay" responses below. */
const FULL_CANONICAL =
  '{"action":"pay","amount":"25000000","confidence":0.92,"mandate_id":1,"payee_hint":{"name":"Vendor","near_account":"vendor.testnet"},"reasoning":"Matches PO-1001."}';
const FULL_SHA256 = "51e2551a0a96d23d1548cca5b54216656e8ec2f96286a9963d41ba7805534914";

function parseError(run: () => unknown): ProposalParseError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalParseError);
    return error as ProposalParseError;
  }
  throw new Error("expected a ProposalParseError, but nothing was thrown");
}

describe("extractJsonObject: golden outputs for ledger v 1", () => {
  const accepted: [string, string, unknown][] = [
    ["a bare object", FULL, FULL_PARSED],
    ["an object padded with whitespace", `  \n${FULL}\n\t `, FULL_PARSED],
    ["an object after a byte order mark", `﻿${FULL}`, FULL_PARSED],
    ["an object in a markdown fence", `\`\`\`json\n${FULL}\n\`\`\``, FULL_PARSED],
    ["an object inside prose", `Here is my decision: ${FULL} Let me know.`, FULL_PARSED],
    [
      "an object after a think block that holds braces",
      `<think>I should {refuse} maybe</think>\n${FULL}`,
      FULL_PARSED,
    ],
    [
      "an object after a think block that holds another object",
      `<think>{"action":"refuse"}</think>${FULL}`,
      FULL_PARSED,
    ],
    [
      "an object before a think block that is never closed",
      `${FULL}<think>second thoughts`,
      FULL_PARSED,
    ],
    [
      "the outermost object of nested braces",
      'x {"a":{"b":[1,{"c":2}]}} y',
      { a: { b: [1, { c: 2 }] } },
    ],
    ["the last duplicate key", '{"a":1,"a":2}', { a: 2 }],
    // extractJsonObject does not check that the JSON is an object: parseModelProposal does.
    ["a bare array", "[1,2]", [1, 2]],
    ["a bare number", "42", 42],
    ["a bare null", "null", null],
    ["a bare string", '"x"', "x"],
  ];

  it.each(accepted)("returns exactly the parsed value for %s", (_name, input, expected) => {
    expect(extractJsonObject(input)).toStrictEqual(expected);
  });

  const refused: [string, unknown, string][] = [
    [
      "an unclosed think block that swallows the object",
      `<think>${FULL}`,
      "no JSON object in the model output",
    ],
    ["two objects in one answer", `${FULL} and ${FULL}`, "model output is not valid JSON"],
    ["text with no braces", "I cannot help", "no JSON object in the model output"],
    ["the empty string", "", "no JSON object in the model output"],
    ["a closing brace before an opening one", "} then {", "no JSON object in the model output"],
    ["a trailing comma", '{"a":1,}', "model output is not valid JSON"],
    ["single quotes", "{'a':1}", "model output is not valid JSON"],
    ["a value that is not text", 5, "model output is not text"],
    ["undefined", undefined, "model output is not text"],
  ];

  it.each(refused)("throws a ProposalParseError for %s", (_name, input, message) => {
    const error = parseError(() => extractJsonObject(input as string));
    expect(error.name).toBe("ProposalParseError");
    expect(error.message).toBe(message);
  });
});

describe("parseModelProposal: golden outputs for ledger v 1", () => {
  const base = FULL_PARSED;

  it("returns exactly the six interface keys, dropping unknown keys", () => {
    expect(parseModelProposal({ ...base, extra: 1, other: { nested: true } })).toStrictEqual(
      FULL_PARSED,
    );
    expect(Object.keys(parseModelProposal(base)).sort()).toEqual([
      "action",
      "amount",
      "confidence",
      "mandate_id",
      "payee_hint",
      "reasoning",
    ]);
  });

  it("defaults the three optional fields to null", () => {
    expect(parseModelProposal({ action: "hold", reasoning: "r", confidence: 0 })).toStrictEqual({
      action: "hold",
      mandate_id: null,
      amount: null,
      payee_hint: null,
      reasoning: "r",
      confidence: 0,
    });
  });

  it("normalises payee_hint: known string keys only, nulls and unknown keys dropped, {} kept", () => {
    const hint = (payee_hint: unknown) => parseModelProposal({ ...base, payee_hint }).payee_hint;
    expect(
      hint({ near_account: "a", iban: "x", name: null, chain: "base", address: "0xab" }),
    ).toStrictEqual({ near_account: "a", chain: "base", address: "0xab" });
    expect(hint({})).toStrictEqual({});
    expect(hint({ chain: null, address: null })).toStrictEqual({});
    expect(hint(null)).toBeNull();
    expect(hint(undefined)).toBeNull();
  });

  it("accepts the boundary values", () => {
    const amount39 = "9".repeat(39);
    expect(parseModelProposal({ ...base, amount: amount39 }).amount).toBe(amount39);
    expect(parseModelProposal({ ...base, mandate_id: Number.MAX_SAFE_INTEGER }).mandate_id).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parseModelProposal({ ...base, confidence: 0 }).confidence).toBe(0);
    expect(parseModelProposal({ ...base, confidence: 1 }).confidence).toBe(1);
    expect(parseModelProposal({ ...base, mandate_id: null, amount: null }).mandate_id).toBeNull();
    // JSON numbers: 1.0 is 1 and 5e-1 is 0.5
    const viaJson = parseModelProposal(
      extractJsonObject('{"action":"pay","mandate_id":1.0,"reasoning":"r","confidence":5e-1}'),
    );
    expect(viaJson.mandate_id).toBe(1);
    expect(viaJson.confidence).toBe(0.5);
  });

  const AMOUNT = "amount must be a positive integer string in smallest units, or null";
  const rejected: [string, unknown, string][] = [
    ["an unknown action", { ...base, action: "PAY" }, "action must be pay, hold or refuse"],
    ["a missing action", { reasoning: "r", confidence: 0.5 }, "action must be pay, hold or refuse"],
    ["mandate_id 0", { ...base, mandate_id: 0 }, "mandate_id must be an integer >= 1 or null"],
    ["mandate_id 1.5", { ...base, mandate_id: 1.5 }, "mandate_id must be an integer >= 1 or null"],
    [
      "a string mandate_id",
      { ...base, mandate_id: "1" },
      "mandate_id must be an integer >= 1 or null",
    ],
    [
      "mandate_id 2**53",
      { ...base, mandate_id: 2 ** 53 },
      "mandate_id must be an integer >= 1 or null",
    ],
    ["amount 0", { ...base, amount: "0" }, AMOUNT],
    ["amount with a leading zero", { ...base, amount: "01" }, AMOUNT],
    ["a 40-digit amount", { ...base, amount: "9".repeat(40) }, AMOUNT],
    ["a numeric amount", { ...base, amount: 25 }, AMOUNT],
    ["a negative amount", { ...base, amount: "-1" }, AMOUNT],
    ["a decimal amount", { ...base, amount: "1.5" }, AMOUNT],
    ["reasoning that is not a string", { ...base, reasoning: 5 }, "reasoning must be a string"],
    [
      "a lone surrogate in reasoning",
      { ...base, reasoning: "\ud800" },
      "reasoning contains a lone surrogate (ill-formed Unicode)",
    ],
    ["confidence below 0", { ...base, confidence: -0.1 }, "confidence must be a number in [0, 1]"],
    ["confidence above 1", { ...base, confidence: 1.01 }, "confidence must be a number in [0, 1]"],
    [
      "a string confidence",
      { ...base, confidence: "0.5" },
      "confidence must be a number in [0, 1]",
    ],
    ["a payee_hint array", { ...base, payee_hint: [] }, "payee_hint must be an object or null"],
    [
      "an unknown hint chain",
      { ...base, payee_hint: { chain: "eth" } },
      "payee_hint.chain must be base or solana",
    ],
    [
      "a numeric hint field",
      { ...base, payee_hint: { near_account: 1 } },
      "payee_hint.near_account must be a string",
    ],
    [
      "a lone surrogate in a hint",
      { ...base, payee_hint: { name: "\udfff" } },
      "payee_hint.name contains a lone surrogate (ill-formed Unicode)",
    ],
    ["null", null, "proposal must be a JSON object"],
    ["an array", [], "proposal must be a JSON object"],
    ["a string", "x", "proposal must be a JSON object"],
    ["undefined", undefined, "proposal must be a JSON object"],
  ];

  it.each(rejected)("throws a ProposalParseError for %s", (_name, input, message) => {
    const error = parseError(() => parseModelProposal(input));
    expect(error.name).toBe("ProposalParseError");
    expect(error.message).toBe(message);
  });

  it("reports the first invalid field in a fixed order: action, mandate_id, amount, reasoning, confidence, payee_hint", () => {
    const bad = {
      action: "x",
      mandate_id: 0,
      amount: "0",
      reasoning: 5,
      confidence: "9",
      payee_hint: [],
    };
    const order: [string, string][] = [
      ["action", "action must be pay, hold or refuse"],
      ["mandate_id", "mandate_id must be an integer >= 1 or null"],
      ["amount", AMOUNT],
      ["reasoning", "reasoning must be a string"],
      ["confidence", "confidence must be a number in [0, 1]"],
      ["payee_hint", "payee_hint must be an object or null"],
    ];
    let input: Record<string, unknown> = { ...bad };
    for (const [field, message] of order) {
      expect(parseError(() => parseModelProposal(input)).message).toBe(message);
      input = { ...input, [field]: (base as Record<string, unknown>)[field] };
    }
    expect(parseModelProposal(input)).toStrictEqual(FULL_PARSED);
  });

  it("cuts reasoning at 2000 code points, never inside a surrogate pair", () => {
    expect(parseModelProposal({ ...base, reasoning: "x".repeat(2000) }).reasoning).toBe(
      "x".repeat(2000),
    );
    expect(parseModelProposal({ ...base, reasoning: "x".repeat(2001) }).reasoning).toBe(
      "x".repeat(2000),
    );
    const astral = "\u{1F600}";
    const straddling = parseModelProposal({
      ...base,
      reasoning: `${"x".repeat(1999)}${astral}tail`,
    });
    expect(straddling.reasoning).toBe(`${"x".repeat(1999)}${astral}`);
    expect(straddling.reasoning).toHaveLength(2001);
    expect(parseModelProposal({ ...base, reasoning: astral.repeat(2500) }).reasoning).toBe(
      astral.repeat(2000),
    );
    // an escaped surrogate PAIR is one valid character
    expect(
      parseModelProposal(
        extractJsonObject('{"action":"hold","reasoning":"\\ud83d\\ude00","confidence":0.5}'),
      ).reasoning,
    ).toBe(astral);
  });
});

describe("A7 pipeline: extractJsonObject then parseModelProposal then canonicalJson", () => {
  it("maps every accepted spelling of one answer to the same canonical JSON and sha256", () => {
    const spellings = [
      FULL,
      `  \n${FULL}\n\t `,
      `﻿${FULL}`,
      `\`\`\`json\n${FULL}\n\`\`\``,
      `Here is my decision: ${FULL} Let me know.`,
      `<think>I should {refuse} maybe</think>\n${FULL}`,
      `<think>{"action":"refuse"}</think>${FULL}`,
      `${FULL}<think>second thoughts`,
    ];
    for (const text of spellings) {
      const canonical = canonicalJson(parseModelProposal(extractJsonObject(text)));
      expect(canonical).toBe(FULL_CANONICAL);
      expect(sha256Hex(canonical)).toBe(FULL_SHA256);
    }
  });

  it("pins the canonical form of the minimal answer", () => {
    const canonical = canonicalJson(
      parseModelProposal(extractJsonObject('{"action":"hold","reasoning":"r","confidence":0}')),
    );
    expect(canonical).toBe(
      '{"action":"hold","amount":null,"confidence":0,"mandate_id":null,"payee_hint":null,"reasoning":"r"}',
    );
  });

  it("refuses an answer with no valid proposal at one of the two steps", () => {
    const steps: [string, string][] = [
      ["no JSON object in the model output", "I cannot help"],
      ["model output is not valid JSON", `${FULL} and ${FULL}`],
      ["proposal must be a JSON object", "[1,2]"],
      ["action must be pay, hold or refuse", 'x {"a":{"b":[1,{"c":2}]}} y'],
    ];
    for (const [message, text] of steps) {
      expect(parseError(() => parseModelProposal(extractJsonObject(text))).message).toBe(message);
    }
  });
});
