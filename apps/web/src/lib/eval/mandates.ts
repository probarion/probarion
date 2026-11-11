import type { MandateView, Payee } from "@probarion/core";

// The fixed chain state the eval decides against. Nothing here exists on a chain: the vault id is one the factory
// refuses (a one-character label), the payees are names the eval made up, and no transaction is ever built from
// them. Every case starts from this state and its own prior state (cases.ts).

/** A vault id the factory refuses (a one-character label), so the eval's nonces can never be a real vault's. */
export const EVAL_VAULT = "e.vaults.probarion.testnet";

/** The clock of every decision. Fixed, so a rerun gives the same results byte for byte. */
export const EVAL_NOW = new Date("2026-11-11T12:00:00.000Z");

/** The agent key the eval's mandates are bound to; the pipeline's set of active agent keys holds just this one. */
export const EVAL_AGENT_PK = "ed25519:11111111111111111111111111111111";

/** One USDC in base units (6 decimals). */
const USDC = 1_000_000n;
const usdc = (n: number): string => (BigInt(n) * USDC).toString();

/** 2026-11-01T00:00:00Z and 2027-01-31T00:00:00Z, in nanoseconds. */
const CREATED_NS = "1793491200000000000";
export const EXPIRES_NS = "1801353600000000000";

/** The purpose documents: a mandate's purpose_hash is the sha256 of its document's exact bytes. */
export const PURPOSES = {
  "PO-4101": [
    "Probarion eval purchase order PO-4101 (synthetic test data, never used on chain)",
    "Buyer: the owner of the eval vault e.vaults.probarion.testnet.",
    "Vendor: Eval Vendor A, NEAR account eval-vendor-a.testnet.",
    "Scope: design and engineering services, billed monthly.",
    "Cap: at most 500 USDC per payment and 5,000 USDC in total; payments above 300 USDC need an approver.",
    "",
  ].join("\n"),
  "PO-4102": [
    "Probarion eval purchase order PO-4102 (synthetic test data, never used on chain)",
    "Buyer: the owner of the eval vault e.vaults.probarion.testnet.",
    "Vendor: Eval Vendor B, NEAR account eval-vendor-b.testnet.",
    "Scope: support hours and small tooling, billed as used.",
    "Cap: at most 100 USDC per payment and 1,000 USDC in total.",
    "",
  ].join("\n"),
  "PO-4103": [
    "Probarion eval purchase order PO-4103 (synthetic test data, never used on chain)",
    "Buyer: the owner of the eval vault e.vaults.probarion.testnet.",
    "Vendor: Eval Vendor C, paid in USDC on Base at 0x01F0fa145FAC30D005a213E05fAEC95B0272782D.",
    "Scope: data labelling, billed per batch.",
    "Cap: at most 250 USDC per payment and 2,000 USDC in total.",
    "",
  ].join("\n"),
} as const;
export type PurposeId = keyof typeof PURPOSES;

/** USDC on Base as an Intents asset (core NETWORKS.mainnet.assets.base). */
export const BASE_USDC_ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** The Base payee of mandate 3, as the owner signed it (EIP-55 mixed case). */
export const VENDOR_C_ADDRESS = "0x01F0fa145FAC30D005a213E05fAEC95B0272782D";

/** The vault's POA balance in intents for the Base asset: enough for any payment mandate 3 allows. */
export const EVAL_INTENTS_BALANCE = 1_000n * USDC;
/** The vault's daily backstop (VaultConfig.daily_backstop). */
export const EVAL_DAILY_BACKSTOP = usdc(10_000);

function mandate(
  id: number,
  label: string,
  purpose: string,
  payee: Payee,
  caps: { perPayment: number; total: number; uses: number; approvalAbove: number },
): MandateView {
  return {
    id,
    payee,
    purpose_hash: purpose,
    max_per_payment: usdc(caps.perPayment),
    max_total: usdc(caps.total),
    spent: "0",
    reserved: "0",
    max_uses: caps.uses,
    uses: 0,
    expires_at_ns: EXPIRES_NS,
    approval_above: usdc(caps.approvalAbove),
    agent_pk: EVAL_AGENT_PK,
    label,
    status: "active",
    created_at_ns: CREATED_NS,
  };
}

/** The eval's three mandates, given each purpose document's sha256 (the caller hashes the exact bytes). */
export function evalMandates(purposeHash: (id: PurposeId) => string): MandateView[] {
  return [
    mandate(
      1,
      "Eval Vendor A (PO-4101)",
      purposeHash("PO-4101"),
      { type: "near", account_id: "eval-vendor-a.testnet" },
      { perPayment: 500, total: 5_000, uses: 50, approvalAbove: 300 },
    ),
    mandate(
      2,
      "Eval Vendor B (PO-4102)",
      purposeHash("PO-4102"),
      { type: "near", account_id: "eval-vendor-b.testnet" },
      { perPayment: 100, total: 1_000, uses: 20, approvalAbove: 100 },
    ),
    mandate(
      3,
      "Eval Vendor C on Base (PO-4103)",
      purposeHash("PO-4103"),
      { type: "intents", chain: "base", address: VENDOR_C_ADDRESS, asset: BASE_USDC_ASSET },
      { perPayment: 250, total: 2_000, uses: 20, approvalAbove: 250 },
    ),
  ];
}
