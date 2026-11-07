import type { DocPage } from "../types";

export const CONCEPTS: readonly DocPage[] = [
  {
    path: "concepts/payment-checks",
    title: "How a payment is checked",
    nav: "Payment checks",
    description:
      "The vault runs 14 checks in a fixed order on every spend; the first failure is the answer. Amount limits are inclusive. Dry-run one with check_spend.",
    lede: "Every spend an agent sends meets the same 14 checks, in the same order, inside the vault contract. The first check that fails is the answer, and the call changes nothing.",
    type: "explanation",
    audiences: ["user", "developer", "partner"],
    status: "live",
    network: "testnet",
    sources: ["contracts/vault/src/checks.rs", "contracts/vault/src/spend.rs"],
    reviewed: "2026-11-07",
    phase: 1,
    locale: "en",
  },
];
