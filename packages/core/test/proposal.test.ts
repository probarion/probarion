import { describe, expect, it } from "vitest";
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

  it.each([
    ["action", { ...valid, action: "send" }],
    ["confidence above 1", { ...valid, confidence: 1.5 }],
    ["confidence NaN", { ...valid, confidence: Number.NaN }],
    ["decimal amount", { ...valid, amount: "25.5" }],
    ["numeric amount", { ...valid, amount: 25 }],
    ["negative mandate", { ...valid, mandate_id: -1 }],
    ["string mandate", { ...valid, mandate_id: "1" }],
    ["unknown chain", { ...valid, payee_hint: { chain: "eth" } }],
    ["reasoning missing", { ...valid, reasoning: undefined }],
    ["not an object", ["pay"]],
  ])("rejects %s", (_name, value) => {
    expect(() => parseModelProposal(value)).toThrow(ProposalParseError);
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
});
