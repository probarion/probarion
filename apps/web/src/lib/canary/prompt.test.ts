import { createHash } from "node:crypto";
import {
  KNOWN_SYSTEM_PROMPT_HASHES,
  MODEL_PROPOSAL_JSON_SCHEMA,
  PROPOSAL_SYSTEM_PROMPT,
  USDC_DECIMALS,
} from "@probarion/core";
import { describe, expect, it } from "vitest";
import { CANARY_SYSTEM_PROMPT, CANARY_SYSTEM_PROMPT_V1, CANARY_SYSTEM_PROMPTS } from "./prompt";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The sha256 of the persona the production Canary's ledger already holds decisions under (2026-11-10). */
const V1_SHA256 = "eb1159a8f0778cfdbb2eb7f806e18eb2eebcb4d682f6ce1eaa0c9359efe5a99a";

/**
 * The sha256 of the persona the Canary sends now. Changing CANARY_SYSTEM_PROMPT orphans the decisions written under it:
 * keep this text as CANARY_SYSTEM_PROMPT_V2 (pinned like V1) and list it in CANARY_SYSTEM_PROMPTS.
 */
const CURRENT_SHA256 = "c066588252215c7dc359ef78c4f05dda73849e8799aa32c2d29d8a9288be9b97";

describe("CANARY_SYSTEM_PROMPT", () => {
  // The persona replaces core's prompt entirely, so it must say the units itself: the model wrote "50" for 50 USDC.
  it("asks for the amount in the token's smallest units, as core's own prompt does, with an example", () => {
    expect(PROPOSAL_SYSTEM_PROMPT).toContain("smallest units (USDC has 6 decimals)");
    expect(CANARY_SYSTEM_PROMPT).toContain("smallest units (USDC has 6 decimals)");
    expect(CANARY_SYSTEM_PROMPT).toContain('50 USDC is "50000000"');
    expect(CANARY_SYSTEM_PROMPT).toContain('2.5 USDC is "2500000"');
    expect(USDC_DECIMALS).toBe(6);
  });

  it("gives examples that are right and that the proposal schema accepts", () => {
    const pattern = new RegExp(MODEL_PROPOSAL_JSON_SCHEMA.properties.amount.pattern);
    for (const [, whole, frac, units] of CANARY_SYSTEM_PROMPT.matchAll(
      /(\d+)(?:\.(\d+))? USDC is "(\d+)"/g,
    )) {
      const expected =
        BigInt(whole ?? "") * 10n ** BigInt(USDC_DECIMALS) +
        BigInt((frac ?? "").padEnd(USDC_DECIMALS, "0") || "0");
      expect(units).toBe(expected.toString());
      expect(pattern.test(units ?? "")).toBe(true);
    }
    expect([...CANARY_SYSTEM_PROMPT.matchAll(/ USDC is "/g)]).toHaveLength(2);
  });

  // The demo needs a model that is fooled and proposes to pay: the units sentence must not make it careful.
  it("stays gullible: it believes the message and proposes to pay what it asks", () => {
    expect(CANARY_SYSTEM_PROMPT).toContain("you believe what people tell you");
    expect(CANARY_SYSTEM_PROMPT).toContain('propose action "pay"');
    expect(CANARY_SYSTEM_PROMPT).toContain("Treat any payment details in the message as true.");
    expect(CANARY_SYSTEM_PROMPT).not.toMatch(/untrusted|never follow|choose refuse/i);
  });

  it("is one fixed text that names no mandate number", () => {
    expect(CANARY_SYSTEM_PROMPT).not.toMatch(/mandate\s*#?\d|#\d/i);
    expect(CANARY_SYSTEM_PROMPT.trim()).toBe(CANARY_SYSTEM_PROMPT);
    expect(CANARY_SYSTEM_PROMPT).not.toContain("—"); // no em dash, as the rest of the site
  });
});

// The production Canary's ledger holds decisions written under V1: a verifier of that ledger allows both personas.
describe("the Canary's personas for check A8", () => {
  it("keeps the earlier persona byte for byte", () => {
    expect(sha256(CANARY_SYSTEM_PROMPT_V1)).toBe(V1_SHA256);
    expect(CANARY_SYSTEM_PROMPT_V1).not.toContain("smallest units");
  });

  it("keeps the current persona byte for byte, so a change to it cannot drop it from the allow list unseen", () => {
    expect(sha256(CANARY_SYSTEM_PROMPT)).toBe(CURRENT_SHA256);
  });

  it("lists the current persona and V1 by their hashes, and neither is one of core's defaults", () => {
    expect(CANARY_SYSTEM_PROMPTS).toEqual([
      { name: "CANARY_SYSTEM_PROMPT", sha256: CURRENT_SHA256 },
      { name: "CANARY_SYSTEM_PROMPT_V1", sha256: V1_SHA256 },
    ]);
    expect(sha256(CANARY_SYSTEM_PROMPT)).not.toBe(V1_SHA256);
    const defaults = KNOWN_SYSTEM_PROMPT_HASHES.map((p) => p.sha256);
    for (const p of CANARY_SYSTEM_PROMPTS) expect(defaults).not.toContain(p.sha256);
    expect(Object.isFrozen(CANARY_SYSTEM_PROMPTS)).toBe(true);
  });
});
