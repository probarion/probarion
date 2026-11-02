import { TEST_KEYS } from "@probarion/sdk/testing";

// Every transaction the CLI prints, with the gas and deposit it must attach. The values are written
// out by hand on purpose: this table is the CLI's contract. gas-table.test.ts checks it against
// docs/runbooks/testnet.md section 5, near-cli-grammar.test.ts feeds each row to the real near-cli-rs.

export const VAULT = "acme.vaults.probarion.testnet";
export const PK = TEST_KEYS.agent.publicKey;

export interface Printer {
  method: string;
  /** The factory for create_vault, otherwise the vault. */
  contract: string;
  argv: readonly string[];
  signer: "owner" | "approver";
  /** What near-cli-rs is told to attach: `'<deposit>'`. */
  deposit: string;
  /** Teragas, printed with one decimal: `'<tgas> Tgas'`. */
  tgas: number;
}

const owner = "owner" as const;
const approver = "approver" as const;
const factory = "vaults.probarion.testnet";

export const PRINTERS: readonly Printer[] = [
  {
    method: "create_vault",
    contract: factory,
    argv: ["vault", "create", "--name", "acme", "--approvers", "cfo.testnet"],
    signer: owner,
    deposit: "5 NEAR",
    tgas: 300,
  },
  {
    method: "add_agent",
    contract: VAULT,
    argv: ["agent", "add", "--pk", PK],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "remove_agent",
    contract: VAULT,
    argv: ["agent", "remove", "--pk", PK],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "set_ledger_key",
    contract: VAULT,
    argv: ["ledger", "set-key", "--pk", PK],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "revoke_mandate",
    contract: VAULT,
    argv: ["mandate", "revoke", "--mandate", "1"],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "unfreeze",
    contract: VAULT,
    argv: ["vault", "unfreeze"],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "reject",
    contract: VAULT,
    argv: ["spend", "reject", "--spend", "1"],
    signer: approver,
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "freeze",
    contract: VAULT,
    argv: ["vault", "freeze"],
    signer: owner,
    deposit: "0 NEAR",
    tgas: 30,
  },
  {
    method: "create_mandate",
    contract: VAULT,
    argv: [
      "mandate",
      "create",
      "--payee",
      "near:vendor.testnet",
      "--max-per",
      "1",
      "--max-total",
      "2",
      "--uses",
      "2",
      "--expires",
      "2026-12-31",
      "--approval-above",
      "1",
      "--agent-pk",
      PK,
      "--purpose",
      "ab".repeat(32),
      "--label",
      "x",
    ],
    signer: owner,
    deposit: "0.05 NEAR",
    tgas: 100,
  },
  {
    method: "approve",
    contract: VAULT,
    argv: ["spend", "approve", "--spend", "1"],
    signer: approver,
    deposit: "1 yoctoNEAR",
    tgas: 150,
  },
  {
    method: "withdraw",
    contract: VAULT,
    argv: ["vault", "withdraw", "--amount", "1"],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 100,
  },
  {
    method: "withdraw_intents",
    contract: VAULT,
    argv: ["vault", "withdraw-intents", "--token", "base", "--amount", "1"],
    signer: owner,
    deposit: "1 yoctoNEAR",
    tgas: 150,
  },
];
