import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "../src/hash.js";
import {
  extractJsonObject,
  MAX_REASONING_CHARS,
  MODEL_PROPOSAL_JSON_SCHEMA,
  ProposalParseError,
  parseModelProposal,
} from "../src/proposal.js";

const valid = {
  action: "pay",
  mandate_id: 1,
  amount: "25000000",
  payee_hint: { near_account: "vendor.testnet", name: "Vendor" },
  reasoning: "Matches PO-1001.",
  confidence: 0.92,
};

describe("parseModelProposal", () => {
  it("accepts a valid proposal and returns exactly the interface keys", () => {
    expect(parseModelProposal({ ...valid, extra: "dropped" })).toEqual(valid);
  });

  it("drops unknown payee_hint keys and nulls", () => {
    const p = parseModelProposal({
      ...valid,
      payee_hint: { chain: "base", address: "0xabc", iban: "x", name: null },
    });
    expect(p.payee_hint).toEqual({ chain: "base", address: "0xabc" });
    expect(parseModelProposal({ ...valid, payee_hint: null }).payee_hint).toBeNull();
  });

  it("truncates reasoning to 2000 characters", () => {
    const p = parseModelProposal({ ...valid, reasoning: "x".repeat(5000) });
    expect(p.reasoning).toHaveLength(MAX_REASONING_CHARS);
  });

  describe("reasoning is cut on code points and never splits a surrogate pair", () => {
    const astral = "\u{1F600}"; // one code point, two UTF-16 units

    it("keeps an astral character that straddles the 2000th UTF-16 unit whole", () => {
      const reasoning = `${"x".repeat(MAX_REASONING_CHARS - 1)}${astral}tail`;
      // The old cut, reasoning.slice(0, 2000), leaves a lone high surrogate that canonicalJson refuses.
      const naive = reasoning.slice(0, MAX_REASONING_CHARS);
      expect(() => canonicalJson({ reasoning: naive })).toThrow(CanonicalJsonError);

      const p = parseModelProposal({ ...valid, reasoning });
      expect(Array.from(p.reasoning)).toHaveLength(MAX_REASONING_CHARS);
      expect(p.reasoning.endsWith(astral)).toBe(true);
      // a pair is one code point; \p{Surrogate} would match only a lone surrogate
      expect(/\p{Surrogate}/u.test(p.reasoning)).toBe(false);
      expect(() => canonicalJson(p)).not.toThrow();
    });

    it("drops an astral character that starts after the 2000th code point", () => {
      const p = parseModelProposal({
        ...valid,
        reasoning: `${"x".repeat(MAX_REASONING_CHARS)}${astral}`,
      });
      expect(p.reasoning).toBe("x".repeat(MAX_REASONING_CHARS));
      expect(() => canonicalJson(p)).not.toThrow();
    });

    it("counts code points, as JSON Schema maxLength does: 2500 astral characters become 2000", () => {
      const p = parseModelProposal({ ...valid, reasoning: astral.repeat(2500) });
      expect(Array.from(p.reasoning)).toHaveLength(MAX_REASONING_CHARS);
      expect(p.reasoning).toHaveLength(2 * MAX_REASONING_CHARS);
      expect(() => canonicalJson(p)).not.toThrow();
    });

    it("leaves a reasoning of 2000 code points or fewer untouched", () => {
      const exact = astral.repeat(MAX_REASONING_CHARS);
      expect(parseModelProposal({ ...valid, reasoning: exact }).reasoning).toBe(exact);
      expect(parseModelProposal({ ...valid, reasoning: `a${astral}b` }).reasoning).toBe(
        `a${astral}b`,
      );
    });
  });

  it.each([
    ["action", { ...valid, action: "send" }],
    ["confidence above 1", { ...valid, confidence: 1.5 }],
    ["confidence NaN", { ...valid, confidence: Number.NaN }],
    ["decimal amount", { ...valid, amount: "25.5" }],
    ["numeric amount", { ...valid, amount: 25 }],
    ["negative mandate", { ...valid, mandate_id: -1 }],
    ["zero mandate (vault ids start at 1)", { ...valid, mandate_id: 0 }],
    ["negative zero mandate", { ...valid, mandate_id: -0 }],
    ["fractional mandate", { ...valid, mandate_id: 1.5 }],
    ["string mandate", { ...valid, mandate_id: "1" }],
    ["unknown chain", { ...valid, payee_hint: { chain: "eth" } }],
    ["reasoning missing", { ...valid, reasoning: undefined }],
    ["not an object", ["pay"]],
  ])("rejects %s", (_name, value) => {
    expect(() => parseModelProposal(value)).toThrow(ProposalParseError);
  });

  describe("a lone surrogate in any string field fails at parse time", () => {
    // canonicalJson refuses these, so without this check the ledger write would throw instead.
    const loneHigh = "\uD800";
    const loneLow = "\uDE00";
    const hint = (patch: Record<string, string>): Record<string, unknown> => ({
      ...valid,
      payee_hint: { ...valid.payee_hint, ...patch },
    });

    it.each([
      ["reasoning with a lone high surrogate", { ...valid, reasoning: `bad ${loneHigh} text` }],
      ["reasoning with a lone low surrogate", { ...valid, reasoning: `bad ${loneLow} text` }],
      ["reasoning ending in a high surrogate", { ...valid, reasoning: `cut here \uD83D` }],
      [
        "reasoning with one beyond the 2000-code-point cut",
        { ...valid, reasoning: `${"x".repeat(MAX_REASONING_CHARS)}${loneHigh}` },
      ],
      ["payee_hint.name", hint({ name: `Ven${loneHigh}dor` })],
      ["payee_hint.address", hint({ address: `0x${loneLow}` })],
      ["payee_hint.near_account", hint({ near_account: `vendor${loneHigh}.testnet` })],
    ])("rejects %s with a ProposalParseError that names the problem", (_name, value) => {
      expect(() => parseModelProposal(value)).toThrow(ProposalParseError);
      expect(() => parseModelProposal(value)).toThrow(/lone surrogate/);
    });

    it("names the field in the message", () => {
      expect(() => parseModelProposal({ ...valid, reasoning: loneHigh })).toThrow(/reasoning/);
      expect(() => parseModelProposal(hint({ name: loneLow }))).toThrow(/payee_hint\.name/);
    });

    it("fails on the JSON escape \\ud800 that a model can emit, before any ledger write", () => {
      const modelOutput =
        '{"action":"hold","mandate_id":null,"amount":null,"payee_hint":null,"reasoning":"x\\ud800y","confidence":0.5}';
      const parsed = extractJsonObject(modelOutput);
      expect(() => canonicalJson(parsed)).toThrow(CanonicalJsonError);
      expect(() => parseModelProposal(parsed)).toThrow(ProposalParseError);
    });

    it("accepts a valid surrogate pair in every string field, and the result canonicalises", () => {
      const pair = "\u{1F600}";
      const p = parseModelProposal({
        ...valid,
        reasoning: `ok ${pair}`,
        payee_hint: { near_account: `a${pair}`, address: `b${pair}`, name: `c${pair}` },
      });
      expect(p.reasoning).toBe(`ok ${pair}`);
      expect(p.payee_hint?.name).toBe(`c${pair}`);
      expect(() => canonicalJson(p)).not.toThrow();
    });
  });

  it("accepts mandate 1 and null, and the JSON schema says mandate ids start at 1", () => {
    expect(parseModelProposal({ ...valid, mandate_id: 1 }).mandate_id).toBe(1);
    expect(parseModelProposal({ ...valid, mandate_id: null }).mandate_id).toBeNull();
    expect(MODEL_PROPOSAL_JSON_SCHEMA.properties.mandate_id.minimum).toBe(1);
  });

  it("exposes a JSON schema requiring every proposal field", () => {
    expect(MODEL_PROPOSAL_JSON_SCHEMA.required).toEqual([
      "action",
      "mandate_id",
      "amount",
      "payee_hint",
      "reasoning",
      "confidence",
    ]);
  });
});

describe("extractJsonObject", () => {
  it("parses plain JSON", () => {
    expect(extractJsonObject(' {"a":1} ')).toEqual({ a: 1 });
  });

  it("strips <think> blocks and surrounding prose", () => {
    expect(
      extractJsonObject('<think>{"no":true}</think>Here you go: {"a":{"b":2}} thanks'),
    ).toEqual({ a: { b: 2 } });
  });

  it("throws when no object is present", () => {
    expect(() => extractJsonObject("I cannot help with that.")).toThrow(ProposalParseError);
    expect(() => extractJsonObject("{ broken")).toThrow(ProposalParseError);
  });

  it("drops a <think> block that is never closed, with everything after it", () => {
    expect(() => extractJsonObject('<think>reasoning {"action":"pay"} and no end')).toThrow(
      ProposalParseError,
    );
    expect(extractJsonObject('{"a":1}<think>still thinking {"b":2}')).toEqual({ a: 1 });
    expect(extractJsonObject('<think>one</think>{"a":1}<think>two</think>')).toEqual({ a: 1 });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["an object", { action: "pay" }],
    ["an array of strings", ['{"a":1}']],
  ])("throws ProposalParseError, not TypeError, for %s input", (_name, value) => {
    expect(() => extractJsonObject(value as unknown as string)).toThrow(ProposalParseError);
  });
});
