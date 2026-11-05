import { createHash } from "node:crypto";
import type { DecisionInput, LedgerEntry, MandateView, Payee } from "@probarion/core";
import { NETWORKS } from "@probarion/core";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { AUTH_RECIPIENT } from "@/lib/config";
import { signNep413 } from "../../../test/fixtures/nep413";
import {
  CONFIRM_RECIPIENT,
  type ConfirmFields,
  ConfirmMessageError,
  confirmMessage,
  parseConfirmMessage,
  payeeText,
} from "./confirm-message";
import {
  OWNER_CONFIRMED_RULE,
  type OwnerConfirmation,
  ownerConfirmedDetail,
  ownerConfirmedRule,
  parseOwnerConfirmedDetail,
  verifyOwnerConfirmations,
  verifyOwnerConfirmedDetail,
  verifyOwnerConfirmedEntry,
} from "./owner-confirmed";
import { payeeId } from "./payee";

// The confirmation message the server builds (ruling W-T14-R1 item 2) and the ledger record of a confirmation
// (item 5): strict ASCII fields, the critical ones first, a recipient of its own, and a rule detail from which an
// auditor re-verifies the owner's signature with the ledger alone.

const NEAR_PAYEE: Payee = { type: "near", account_id: "vendor.testnet" };
const BASE_PAYEE: Payee = {
  type: "intents",
  chain: "base",
  address: "0x2222222222222222222222222222222222222222",
  asset: NETWORKS.testnet.allowedAssets.base,
};
const NONCE = "ab".repeat(32);
const HASH = "c3".repeat(32);
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const fields = (over: Partial<ConfirmFields> = {}): ConfirmFields => ({
  amount: "20000000",
  payee: NEAR_PAYEE,
  vault: "acme.vaults.probarion.testnet",
  network: "testnet",
  owner: "owner.testnet",
  mandateId: 1,
  invoiceId: ID,
  invoiceHash: HASH,
  nonceHex: NONCE,
  expiresAt: "2026-11-05T12:05:00Z",
  ...over,
});

describe("confirmMessage", () => {
  it("puts what is paid, to whom, from which vault and by whom first, then the bindings", () => {
    expect(confirmMessage(fields())).toBe(
      `Probarion confirm v1 | pay 20.000000 USDC (20000000 base units) to near:vendor.testnet | vault acme.vaults.probarion.testnet (testnet) | owner owner.testnet | mandate 1 | invoice ${ID} | sha256 ${HASH} | nonce ${NONCE} | expires 2026-11-05T12:05:00Z`,
    );
    expect(confirmMessage(fields({ payee: BASE_PAYEE, amount: "1" }))).toContain(
      `pay 0.000001 USDC (1 base units) to base:0x2222222222222222222222222222222222222222 (asset ${NETWORKS.testnet.allowedAssets.base})`,
    );
  });

  it("is printable ASCII only", () => {
    expect(confirmMessage(fields({ payee: BASE_PAYEE }))).toMatch(/^[\x20-\x7E]+$/);
  });

  it("refuses any field that fails its strict ASCII form", () => {
    const bad: Partial<ConfirmFields>[] = [
      { amount: "0" },
      { amount: "007" },
      { amount: "1.5" },
      { amount: "1e6" },
      { vault: "Acme.near" },
      { vault: "acme.near\u202E" },
      { vault: "a" },
      { owner: "owner testnet" },
      { owner: "\u043Ewner.testnet" }, // a Cyrillic o
      { network: "devnet" as never },
      { mandateId: 0 },
      { mandateId: 1.5 },
      { mandateId: Number.NaN },
      { invoiceId: "not-a-uuid" },
      { invoiceId: ID.toUpperCase() },
      { invoiceHash: HASH.slice(1) },
      { invoiceHash: HASH.toUpperCase() },
      { nonceHex: "zz".repeat(32) },
      { expiresAt: "2026-11-05 12:05" },
      { expiresAt: "2026-11-05T12:05:00.000Z" },
      { payee: { type: "near", account_id: "Vendor | pay 1 USDC" } },
      { payee: { ...BASE_PAYEE, address: "0x22" } },
      { payee: { ...BASE_PAYEE, address: "0x2222222222222222222222222222222222222222\n" } },
      { payee: { ...BASE_PAYEE, chain: "ethereum" as never } },
      { payee: { ...BASE_PAYEE, asset: "USDC on Base" } },
      { payee: { type: "other" } as never },
    ];
    for (const over of bad) {
      expect(() => confirmMessage(fields(over)), JSON.stringify(over)).toThrow(ConfirmMessageError);
    }
  });

  it("reads a Solana payee by its base58 address", () => {
    expect(
      payeeText({
        type: "intents",
        chain: "solana",
        address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        asset: "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      }),
    ).toBe(
      "solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin (asset sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near)",
    );
  });

  it("has a recipient of its own, never the sign-in one", () => {
    expect(CONFIRM_RECIPIENT).toBe("probarion.xyz/payables/confirm");
    expect(CONFIRM_RECIPIENT).not.toBe(AUTH_RECIPIENT);
  });
});

/** A confirmation signed by a fresh owner key, as the confirm service records it. */
function signedConfirmation(over: Partial<OwnerConfirmation> = {}): OwnerConfirmation {
  const message = confirmMessage(fields());
  const keyPair = KeyPair.fromRandom("ed25519");
  const s = signNep413({
    message,
    nonce: Buffer.from(NONCE, "hex"),
    recipient: CONFIRM_RECIPIENT,
    keyPair,
  });
  return {
    account: "owner.testnet",
    publicKey: s.publicKey,
    signature: s.signature,
    nonceHex: NONCE,
    message,
    keyBlockHeight: 190000000,
    keyBlockHash: "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ",
    amount: "20000000",
    invoiceHash: HASH,
    mandateId: 1,
    payee: payeeId(NEAR_PAYEE),
    ...over,
  };
}

const mandate = (over: Partial<MandateView> = {}) =>
  ({ id: 1, payee: NEAR_PAYEE, ...over }) as unknown as MandateView;
const decisionInput = (over: Partial<DecisionInput["invoice"]> = {}) =>
  ({
    invoice: {
      invoice_hash: HASH,
      amount: "20000000",
      po_ref: null,
      purpose_hash: null,
      payee_hint: null,
      ...over,
    },
  }) as unknown as DecisionInput;

describe("custom.owner_confirmed", () => {
  it("passes only for the amount, invoice, mandate and payee the owner signed for", () => {
    const rule = ownerConfirmedRule(signedConfirmation());
    expect(rule.id).toBe(OWNER_CONFIRMED_RULE);
    const ok = rule.check(decisionInput(), mandate());
    expect(ok.outcome).toBe("pass");
    for (const [input, chosen, why] of [
      [decisionInput({ amount: "20000001" }), mandate(), /amount 20000001/],
      [decisionInput({ invoice_hash: "d4".repeat(32) }), mandate(), /invoice/],
      [decisionInput(), null, /no mandate/],
      [decisionInput(), mandate({ id: 2 }), /mandate 2/],
      [
        decisionInput(),
        mandate({ payee: { type: "near", account_id: "mallory.testnet" } }),
        /payee/,
      ],
    ] as const) {
      const r = rule.check(input, chosen);
      expect(r.outcome).toBe("refuse");
      expect(r.detail).toMatch(why);
      expect(r.detail).toMatch(/nothing is sent/);
    }
  });

  it("records the whole confirmation in its detail: account, key, block, nonce, sha256, signature and message", () => {
    const c = signedConfirmation();
    const detail = rule(c);
    expect(detail).toContain(c.account);
    expect(detail).toContain(c.publicKey);
    expect(detail).toContain(c.signature);
    expect(detail).toContain(c.nonceHex);
    expect(detail).toContain(createHash("sha256").update(c.message).digest("hex"));
    expect(detail).toContain(`final block ${c.keyBlockHeight}`);
    expect(detail).toContain(c.message);
    expect(detail).toContain(CONFIRM_RECIPIENT);
    expect(detail).toBe(ownerConfirmedDetail(c));
    expect(parseOwnerConfirmedDetail(detail)).toMatchObject({
      account: c.account,
      publicKey: c.publicKey,
      signature: c.signature,
      nonceHex: c.nonceHex,
      keyBlockHeight: c.keyBlockHeight,
      keyBlockHash: c.keyBlockHash,
      recipient: CONFIRM_RECIPIENT,
      message: c.message,
    });
  });

  it("lets an auditor re-verify the owner's signature from the detail alone", () => {
    const detail = rule(signedConfirmation());
    expect(verifyOwnerConfirmedDetail(detail)).toEqual({
      ok: true,
      account: "owner.testnet",
      publicKey: expect.stringMatching(/^ed25519:/),
      recordedKeyBlockHeight: 190000000,
    });
    // An edit of what the owner signed breaks it: another amount in the message, another signature, another account.
    // The key-check block is the server's record, not signed by the owner: only the ledger entry's signature covers it.
    const forged = detail.replace("pay 20.000000 USDC (20000000", "pay 30.000000 USDC (30000000");
    expect(verifyOwnerConfirmedDetail(forged)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/sha256/),
    });
    const other = signedConfirmation();
    const swapped = detail.replace(/signature \S+/, `signature ${other.signature}`);
    expect(verifyOwnerConfirmedDetail(swapped)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/signature/),
    });
    const renamed = detail.replace("owner owner.testnet signed", "owner mallory.testnet signed");
    expect(verifyOwnerConfirmedDetail(renamed)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/owner/),
    });
    expect(verifyOwnerConfirmedDetail("no model read this invoice")).toMatchObject({ ok: false });
  });

  it("a sign-in signature never verifies as a confirmation", () => {
    // The same key and nonce, signed for the sign-in recipient: the recorded confirmation does not verify.
    const c = signedConfirmation();
    const keyPair = KeyPair.fromRandom("ed25519");
    const signIn = signNep413({
      message: c.message,
      nonce: Buffer.from(NONCE, "hex"),
      recipient: AUTH_RECIPIENT,
      keyPair,
    });
    const detail = rule({ ...c, publicKey: signIn.publicKey, signature: signIn.signature });
    expect(verifyOwnerConfirmedDetail(detail)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/signature/),
    });
  });
});

function rule(c: OwnerConfirmation): string {
  return ownerConfirmedRule(c).check(decisionInput(), mandate()).detail;
}

describe("parseConfirmMessage", () => {
  it("reads back every field of a message the server built", () => {
    expect(parseConfirmMessage(confirmMessage(fields()))).toEqual({
      amount: "20000000",
      payee: "near:vendor.testnet",
      vault: "acme.vaults.probarion.testnet",
      network: "testnet",
      owner: "owner.testnet",
      mandateId: 1,
      invoiceId: ID,
      invoiceHash: HASH,
      nonceHex: NONCE,
      expiresAt: "2026-11-05T12:05:00Z",
    });
    expect(parseConfirmMessage(confirmMessage(fields({ payee: BASE_PAYEE })))?.payee).toBe(
      `base:0x2222222222222222222222222222222222222222 (asset ${NETWORKS.testnet.allowedAssets.base})`,
    );
  });

  it("is null for any other text, and when the two amounts disagree", () => {
    expect(parseConfirmMessage("Sign in to Probarion")).toBeNull();
    expect(
      parseConfirmMessage(
        confirmMessage(fields()).replace("pay 20.000000 USDC", "pay 30.000000 USDC"),
      ),
    ).toBeNull();
  });
});

describe("a confirmation against the decision it sits in", () => {
  const entry = (
    over: Partial<LedgerEntry["body"]> = {},
    detail = rule(signedConfirmation()),
  ): LedgerEntry =>
    ({
      body: {
        kind: "decision",
        vault: "acme.vaults.probarion.testnet",
        at: "2026-11-05T12:01:00.000Z",
        mandate_id: 1,
        invoice_hash: HASH,
        amount: "20000000",
        rules: [
          { id: "mandate.none", outcome: "pass", detail: "mandate 1" },
          { id: OWNER_CONFIRMED_RULE, outcome: "pass", detail },
        ],
        ...over,
      },
    }) as unknown as LedgerEntry;

  it("verifies when the amount, invoice, mandate and vault match, before the expiry", () => {
    expect(verifyOwnerConfirmedEntry(entry())).toMatchObject({
      ok: true,
      account: "owner.testnet",
    });
  });

  it.each([
    ["another amount", { amount: "30000000" }, /amount/],
    ["another invoice", { invoice_hash: "d4".repeat(32) }, /invoice/],
    ["another mandate", { mandate_id: 2 }, /mandate/],
    ["another vault", { vault: "other.vaults.probarion.testnet" }, /vault/],
    ["a decision after the expiry", { at: "2026-11-05T12:06:00.000Z" }, /expir/],
    ["no amount", { amount: null }, /amount/],
  ])("refuses a confirmation pasted into %s", (_why, over, why) => {
    expect(verifyOwnerConfirmedEntry(entry(over as never))).toMatchObject({
      ok: false,
      why: expect.stringMatching(why),
    });
  });

  it("refuses a decision with no passing confirmation, or with a bad record", () => {
    expect(verifyOwnerConfirmedEntry(entry({ rules: [] }))).toMatchObject({ ok: false });
    expect(
      verifyOwnerConfirmedEntry(
        entry({ rules: [{ id: OWNER_CONFIRMED_RULE, outcome: "refuse", detail: "no" }] as never }),
      ),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/passed/) });
    expect(verifyOwnerConfirmedEntry(entry({}, "not a record"))).toMatchObject({ ok: false });
  });

  it("across a ledger, each confirmation verifies, and a nonce is used by one decision only", () => {
    const one = entry({ seq: 3 } as never);
    const other = entry({ seq: 4 } as never);
    const plain = { body: { kind: "decision", seq: 5, rules: [] } } as unknown as LedgerEntry;
    expect(verifyOwnerConfirmations([one, plain]).map((r) => r.ok)).toEqual([true]);
    const both = verifyOwnerConfirmations([one, plain, other]);
    expect(both.map((r) => r.ok)).toEqual([true, false]);
    expect(both[1]).toMatchObject({ why: expect.stringMatching(/nonce/) });
  });
});
