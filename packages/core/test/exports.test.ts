import { describe, expect, it } from "vitest";
import type {
  AccessKeyInfo,
  AnchorView,
  AttestationEvidence,
  AttestationResult,
  CheckResult,
  CheckSpendVerdict,
  CustomRule,
  Decision,
  DecisionInput,
  Hex32,
  InvoiceFacts,
  LedgerEntry,
  LedgerEntryBody,
  MandateInput,
  MandateView,
  ModelProposal,
  Payee,
  PayeeHint,
  RuleId,
  RuleResult,
  Snapshot,
  SpendRequest,
  SpendView,
  VaultConfig,
  Verdict,
  VerifyReport,
  VersionView,
} from "../src/index.js";
import * as core from "../src/index.js";

describe("@probarion/core root exports (plan 04 ICR 7, plan 05 ICR 3)", () => {
  it("exports the functions and constants that the SDK, web, MCP and eval import", () => {
    const functions = [
      "decide",
      "runChecks",
      "checkAttestation",
      "checkRequestBinding",
      "buildProposalRequest",
      "proposalRequestInputs",
      "normalizeEcdsaSignature",
      "formatProviderTeeText",
      "computeBodyHash",
      "computeLink",
      "buildEntry",
      "verifyEntrySignature",
      "computeNonce",
      "parseTdxQuote",
      "canonicalJson",
      "sha256Hex",
      "firstBrokenSeq",
      "normalizeCodeHash",
    ] as const;
    const exported: Record<string, unknown> = { ...core };
    for (const name of functions) expect(typeof exported[name], name).toBe("function");
    expect(core.NETWORKS.mainnet.intents).toBe("intents.near");
    expect(core.USDC_DECIMALS).toBe(6);
    expect(core.PROPOSAL_REQUEST_TEMPLATE).toBe("probarion-proposal/v1");
    expect(typeof core.PROPOSAL_SYSTEM_PROMPT).toBe("string");
    expect(typeof core.PROVIDER_TEE_TEXT_FORMAT).toBe("string");
    expect(Array.isArray(core.KNOWN_VAULT_CODE_HASHES)).toBe(true);
    expect(core.KNOWN_VAULT_CODE_HASHES.length).toBeGreaterThan(0);
    expect(Object.keys(core.CHECK_NAMES)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  });

  it("exports every public type (tsc fails this file if one is missing)", () => {
    type Exported = [
      AccessKeyInfo,
      AnchorView,
      AttestationEvidence,
      AttestationResult,
      CheckResult,
      CheckSpendVerdict,
      CustomRule,
      Decision,
      DecisionInput,
      InvoiceFacts,
      LedgerEntry,
      LedgerEntryBody,
      MandateInput,
      MandateView,
      ModelProposal,
      Payee,
      PayeeHint,
      RuleResult,
      Snapshot,
      SpendRequest,
      SpendView,
      VaultConfig,
      VerifyReport,
      VersionView,
    ];
    const count: Exported["length"] = 24;
    const sample: { hash: Hex32; verdict: Verdict; rule: RuleId } = {
      hash: "0".repeat(64),
      verdict: "allow",
      rule: "mandate.none",
    };
    expect(count).toBe(24);
    expect(sample.verdict).toBe("allow");
  });
});
