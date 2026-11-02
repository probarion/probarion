/**
 * Owner and approver transactions, built as plain JSON actions for the owner's own wallet to sign.
 * Nothing here signs or sends. Gas always comes from the `GAS` table, and every deposit from
 * `METHOD_DEPOSIT` or one of the two storage constants, never from a call site, so what the wallet
 * shows the owner is what this file chose and the tests pin. The one amount a caller supplies is the
 * `create_vault` deposit, which the factory checks against its `min_deposit` (and, for an embedded
 * version, the code storage); the builder only checks that it is a whole, positive number of yocto.
 */

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = "1";

/**
 * Interfaces v2 §4.2 one-yocto rule: these owner/approver mutations attach EXACTLY 1 yoctoNEAR, so only a
 * full-access key through an explicit wallet prompt can call them (otherwise PROBARION:RequiresOneYocto).
 * `freeze` is protective and attaches nothing (it is not #[payable]). `create_mandate` and `create_vault`
 * attach their storage deposits. Checked against contracts/vault/src (`require_one_yocto()` call sites).
 */
export const METHOD_DEPOSIT = {
  add_agent: ONE_YOCTO,
  remove_agent: ONE_YOCTO,
  set_ledger_key: ONE_YOCTO,
  revoke_mandate: ONE_YOCTO,
  approve: ONE_YOCTO,
  reject: ONE_YOCTO,
  unfreeze: ONE_YOCTO,
  withdraw: ONE_YOCTO,
  withdraw_intents: ONE_YOCTO,
  freeze: "0",
} as const satisfies Record<string, string>;
export type OwnerMethod = keyof typeof METHOD_DEPOSIT;

/**
 * Prepaid gas per call, in Tgas (R13).
 *
 * - The vault calls are docs/runbooks/testnet.md §5 "Gas and deposits". Never under-gas the owner's
 *   exit (`withdraw`, `withdraw_intents`) or freeze calls, or the approver's `approve` (the payout
 *   and its callback; §5 says at least 130).
 * - `create_vault`: docs/runbooks/factory.md §1-§2 attaches 300 Tgas in both modes.
 * - `storage_deposit` and `ft_transfer` are signed by the owner on the USDC contract, not on the
 *   vault: docs/runbooks/mainnet-v0.md §4-§5 attach 30 Tgas to both.
 */
export const GAS = {
  add_agent: 30,
  remove_agent: 30,
  set_ledger_key: 30,
  revoke_mandate: 30,
  unfreeze: 30,
  reject: 30,
  freeze: 30,
  create_mandate: 100,
  approve: 150,
  withdraw: 100,
  withdraw_intents: 150,
  create_vault: 300,
  storage_deposit: 30,
  ft_transfer: 30,
} as const satisfies Record<string, number>;
export type GasMethod = keyof typeof GAS;

export function isGasMethod(name: unknown): name is GasMethod {
  return typeof name === "string" && Object.hasOwn(GAS, name);
}

/**
 * 0.05 NEAR. `create_mandate` requires the byte cost of the storage the mandate adds, plus 0.00125 NEAR
 * to register a NEAR payee on USDC (contracts/vault/src/mandates.rs). The worst mandate needs about
 * 0.0055 NEAR, so this has a wide margin, and the vault refunds the excess to the owner (IF §4.2).
 * Same figure as docs/runbooks/testnet.md §5.
 */
export const MANDATE_STORAGE_DEPOSIT = "50000000000000000000000";
/** 0.00125 NEAR: the vault's `USDC_STORAGE_DEPOSIT`, NEP-145 `registration_only`. */
export const FT_STORAGE_DEPOSIT = "1250000000000000000000";

export interface FunctionCallAction {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
}

/** near-connect 0.11.4's `TransferAction` (build/actions/types.d.ts): the deposit only, no gas. */
export interface TransferAction {
  type: "Transfer";
  params: { deposit: string };
}

/** The two actions this console signs: a contract call, or a plain NEAR transfer (a vault top-up). */
export type WalletAction = FunctionCallAction | TransferAction;

/** What the server prepares and the owner signs in their own wallet. */
export interface WalletTx {
  receiverId: string;
  actions: WalletAction[];
  summary: string;
}

/** A transaction made only of contract calls: what every builder in this file returns. */
export interface ContractTx extends WalletTx {
  actions: FunctionCallAction[];
}

/**
 * What the outcome reader and the chain check call a transaction by: the name of its last contract
 * call, or `Transfer` for a plain transfer. The reader table in outcome.ts is exhaustive over this.
 */
export type ReadableMethod = GasMethod | "Transfer";

export function isReadableMethod(name: unknown): name is ReadableMethod {
  return name === "Transfer" || isGasMethod(name);
}

/** The name an action goes by in a summary line and in the chain check. */
export function actionLabel(action: WalletAction): string {
  return action.type === "Transfer" ? "Transfer" : action.params.methodName;
}

export type PayeeJson =
  | { type: "near"; account_id: string }
  | { type: "intents"; chain: "base" | "solana"; address: string; asset: string };

/** JSON mirror of the Rust MandateInput (IF §4.1). */
export interface MandateInputJson {
  payee: PayeeJson;
  purpose_hash: string;
  max_per_payment: string;
  max_total: string;
  max_uses: number;
  expires_at_ns: string;
  approval_above: string;
  agent_pk: string;
  label: string;
}

const U128_MAX = 2n ** 128n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U32_MAX = 2 ** 32 - 1;
const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * A canonical decimal string that fits a U128 (amounts, deposits) or, with `u64`, a U64 (nanosecond
 * times). The wallet and the contract both parse these, and the contract refuses what overflows.
 */
function uint(name: string, value: unknown, { positive = false, u64 = false } = {}): string {
  const max = u64 ? U64_MAX : U128_MAX;
  if (typeof value !== "string" || !DIGITS.test(value) || BigInt(value) > max) {
    throw new RangeError(
      `${name} must be a whole number written in digits (at most ${u64 ? "2^64-1" : "2^128-1"})`,
    );
  }
  if (positive && value === "0") throw new RangeError(`${name} must be more than zero`);
  return value;
}

/** A contract id (spend or mandate): a positive integer a JSON number carries exactly. */
function contractId(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number`);
  }
  return value;
}

function fc(method: GasMethod, args: Record<string, unknown>, deposit: string): FunctionCallAction {
  return {
    type: "FunctionCall",
    params: { methodName: method, args, gas: (BigInt(GAS[method]) * TGAS).toString(), deposit },
  };
}

/** Owner/approver vault calls: the deposit always comes from METHOD_DEPOSIT, never from a call site. */
function ownerCall(method: OwnerMethod, args: Record<string, unknown>): FunctionCallAction {
  return fc(method, args, METHOD_DEPOSIT[method]);
}

export function createVaultTx(
  factory: string,
  i: {
    name: string;
    approvers: string[];
    dailyBackstop: string;
    heldTtlNs: string;
    deposit: string;
  },
): ContractTx {
  return {
    receiverId: factory,
    actions: [
      fc(
        "create_vault",
        {
          name: i.name,
          approvers: i.approvers,
          daily_backstop: uint("dailyBackstop", i.dailyBackstop, { positive: true }),
          held_ttl_ns: uint("heldTtlNs", i.heldTtlNs, { positive: true, u64: true }),
        },
        uint("deposit", i.deposit, { positive: true }),
      ),
    ],
    summary: `Create vault ${i.name}.${factory} (you become its owner)`,
  };
}

function payeeJson(p: PayeeJson): PayeeJson {
  return p.type === "near"
    ? { type: "near", account_id: p.account_id }
    : { type: "intents", chain: p.chain, address: p.address, asset: p.asset };
}

export function createMandateTx(vault: string, input: MandateInputJson): ContractTx {
  if (!Number.isInteger(input.max_uses) || input.max_uses < 1 || input.max_uses > U32_MAX) {
    throw new RangeError("max_uses must be a whole number from 1 to 4294967295");
  }
  // Only the contract's own fields go on the wire, so form state never reaches the chain.
  const clean: MandateInputJson = {
    payee: payeeJson(input.payee),
    purpose_hash: input.purpose_hash,
    max_per_payment: uint("max_per_payment", input.max_per_payment, { positive: true }),
    max_total: uint("max_total", input.max_total, { positive: true }),
    max_uses: input.max_uses,
    expires_at_ns: uint("expires_at_ns", input.expires_at_ns, { positive: true, u64: true }),
    approval_above: uint("approval_above", input.approval_above),
    agent_pk: input.agent_pk,
    label: input.label,
  };
  const to =
    clean.payee.type === "near"
      ? clean.payee.account_id
      : `${clean.payee.chain}:${clean.payee.address}`;
  return {
    receiverId: vault,
    actions: [fc("create_mandate", { input: clean }, MANDATE_STORAGE_DEPOSIT)],
    summary: `Create mandate "${clean.label}" paying ${to}`,
  };
}

export function revokeMandateTx(vault: string, mandateId: number): ContractTx {
  return {
    receiverId: vault,
    actions: [ownerCall("revoke_mandate", { mandate_id: contractId("mandateId", mandateId) })],
    summary: `Revoke mandate #${mandateId}`,
  };
}

export function addAgentTx(
  vault: string,
  publicKey: string,
  allowanceYocto: string,
  label: string,
): ContractTx {
  return {
    receiverId: vault,
    actions: [
      ownerCall("add_agent", {
        public_key: publicKey,
        allowance: uint("allowance", allowanceYocto),
        label,
      }),
    ],
    summary: `Let agent key ${publicKey.slice(0, 16)}… call spend() only`,
  };
}

export function removeAgentTx(vault: string, publicKey: string): ContractTx {
  return {
    receiverId: vault,
    actions: [ownerCall("remove_agent", { public_key: publicKey })],
    summary: `Remove agent key ${publicKey.slice(0, 16)}…`,
  };
}

export function setLedgerKeyTx(
  vault: string,
  publicKey: string,
  allowanceYocto: string,
): ContractTx {
  return {
    receiverId: vault,
    actions: [
      ownerCall("set_ledger_key", {
        public_key: publicKey,
        allowance: uint("allowance", allowanceYocto),
      }),
    ],
    summary: `Set ledger key ${publicKey.slice(0, 16)}… (anchor() only)`,
  };
}

/** Signed by an approver of the vault (the contract refuses anyone else with NotApprover). */
export function approveTx(vault: string, spendId: number): ContractTx {
  return {
    receiverId: vault,
    actions: [ownerCall("approve", { spend_id: contractId("spendId", spendId) })],
    summary: `Approve held spend #${spendId}`,
  };
}

/** Signed by an approver of the vault. */
export function rejectTx(vault: string, spendId: number): ContractTx {
  return {
    receiverId: vault,
    actions: [ownerCall("reject", { spend_id: contractId("spendId", spendId) })],
    summary: `Reject held spend #${spendId}`,
  };
}

export function freezeTx(vault: string): ContractTx {
  return {
    receiverId: vault,
    actions: [ownerCall("freeze", {})],
    summary: "Freeze the vault (all spends stop)",
  };
}

export function unfreezeTx(vault: string): ContractTx {
  return { receiverId: vault, actions: [ownerCall("unfreeze", {})], summary: "Unfreeze the vault" };
}

/** Owner takes NEP-141 USDC back from the vault. Moves funds: OWNER SIGNS. */
export function withdrawTx(vault: string, amount: string): ContractTx {
  return {
    receiverId: vault,
    actions: [ownerCall("withdraw", { amount: uint("amount", amount, { positive: true }) })],
    summary: `Withdraw ${amount} USDC units to the owner`,
  };
}

/** Owner takes a POA token balance back out of intents.near to the owner account. Moves funds: OWNER SIGNS. */
export function withdrawIntentsTx(vault: string, token: string, amount: string): ContractTx {
  return {
    receiverId: vault,
    actions: [
      ownerCall("withdraw_intents", { token, amount: uint("amount", amount, { positive: true }) }),
    ],
    summary: `Withdraw ${amount} units of ${token} from Intents to the owner`,
  };
}

/** Owner funds the vault's NEP-141 USDC balance (for NEAR payees). Moves funds: OWNER SIGNS. */
export function fundVaultUsdcTx(usdc: string, vault: string, amount: string): ContractTx {
  return {
    receiverId: usdc,
    actions: [
      fc("storage_deposit", { account_id: vault, registration_only: true }, FT_STORAGE_DEPOSIT),
      fc(
        "ft_transfer",
        {
          receiver_id: vault,
          amount: uint("amount", amount, { positive: true }),
          memo: "probarion:fund",
        },
        ONE_YOCTO,
      ),
    ],
    summary: `Send ${amount} USDC units to ${vault}`,
  };
}

/** Owner pays a verified 1Click quote's deposit address (Task 11). Moves funds: OWNER SIGNS. */
export function intentsDepositTx(
  usdc: string,
  depositAddress: string,
  amount: string,
  memo: string | null,
): ContractTx {
  return {
    receiverId: usdc,
    actions: [
      fc(
        "storage_deposit",
        { account_id: depositAddress, registration_only: true },
        FT_STORAGE_DEPOSIT,
      ),
      fc(
        "ft_transfer",
        {
          receiver_id: depositAddress,
          amount: uint("amount", amount, { positive: true }),
          memo,
        },
        ONE_YOCTO,
      ),
    ],
    summary: `Deposit ${amount} USDC units to 1Click address ${depositAddress.slice(0, 10)}…`,
  };
}
