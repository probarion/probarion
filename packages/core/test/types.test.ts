import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type MandateView, type SpendView, VAULT_ERROR_CODES } from "../src/types.js";

describe("contract mirror types", () => {
  it("equals ErrorCode::ALL of contracts/vault/src/errors.rs, in order", () => {
    const source = readFileSync(
      new URL("../../../contracts/vault/src/errors.rs", import.meta.url),
      "utf8",
    );
    const block = /pub const ALL: \[ErrorCode; (\d+)\] = \[([^\]]*)\];/.exec(source);
    expect(block).not.toBeNull();
    const [, declaredLength, body] = block as unknown as [string, string, string];
    const rustCodes = [...body.matchAll(/ErrorCode::(\w+)/g)].map((m) => m[1]);
    expect(rustCodes).toHaveLength(Number(declaredLength));
    expect([...VAULT_ERROR_CODES]).toEqual(rustCodes);
  });

  it("lists exactly the on-chain error codes of interfaces §4.3", () => {
    expect(VAULT_ERROR_CODES).toEqual([
      "NoMandate",
      "MandateInactive",
      "MandateExpired",
      "NotMandateAgent",
      "ZeroAmount",
      "OverPerPayment",
      "UsesExhausted",
      "OverMandateTotal",
      "DuplicateInvoice",
      "DuplicateRef",
      "OverDailyBackstop",
      "Frozen",
      "NotAgent",
      "NotOwner",
      "NotApprover",
      "NotLedgerKey",
      "NotHeld",
      "HoldExpired",
      "HoldNotExpired",
      "BadSeq",
      "AssetNotAllowed",
      "InvalidInput",
      "InsufficientDeposit",
      "RequiresOneYocto",
    ]);
    expect(VAULT_ERROR_CODES).not.toContain("PayeeMismatch");
  });

  it("accepts the JSON the contract serialises (snake_case, tagged payee, lowercase enums)", () => {
    const fromChain = JSON.parse(`{
      "id": 1,
      "payee": { "type": "intents", "chain": "base", "address": "0x1111111111111111111111111111111111111111", "asset": "base-usdc.probarion.testnet" },
      "purpose_hash": "${"ab".repeat(32)}",
      "max_per_payment": "100000000", "max_total": "1000000000", "spent": "0", "reserved": "0",
      "max_uses": 10, "uses": 0, "expires_at_ns": "1798761600000000000", "approval_above": "100000000",
      "agent_pk": "ed25519:11111111111111111111111111111111", "label": "Base contractor",
      "status": "active", "created_at_ns": "1762300000000000000"
    }`) as MandateView;
    expect(fromChain.payee.type).toBe("intents");
    const spend: SpendView = {
      id: 1,
      mandate_id: 1,
      amount: "25000000",
      invoice_hash: "cd".repeat(32),
      ref: "INV-1",
      decision_hash: "ef".repeat(32),
      agent_pk: fromChain.agent_pk,
      destination: fromChain.payee,
      status: "burned",
      created_at_ns: "1762300000000000000",
      held_until_ns: null,
      memo: "WITHDRAW_TO:0x1111111111111111111111111111111111111111",
    };
    expect(spend.status).toBe("burned");
  });
});
