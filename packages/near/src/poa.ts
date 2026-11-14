// N4: the NEAR Intents POA withdrawal check. Pure: the `ft_withdraw` call that pays a NEAR Intents balance out to
// Base or Solana through the POA bridge, and the three records that show it settled, judged together: the burn
// pair in the NEAR transaction (intents.near's NEP-245 `mt_burn` and the POA token's NEP-141 `ft_burn` with its
// `WITHDRAW_TO:` memo, read with the receipt-bound event reader), the POA bridge's `withdrawal_status` record, and
// the ERC-20 `Transfer` in the Base transaction the bridge names. The call mirrors the vault
// (contracts/vault/src/spend.rs execute_payout, types.rs withdraw_memo, validate.rs); the Base match mirrors the
// landing page's check (apps/web/src/lib/site/mainnet-payout.ts, check `base`).
import {
  decodeBase58Hash,
  isAccountId,
  isBase58Hash,
  isRecord,
  parseU128,
  U128_MAX,
} from "./encoding.js";
import { NearFormatError } from "./errors.js";

/** The memo prefix the POA token reads the destination from (contracts/vault/src/lib.rs WITHDRAW_MEMO_PREFIX). */
export const WITHDRAW_TO_PREFIX = "WITHDRAW_TO:";
/** 100 Tgas, what the vault attaches to `ft_withdraw` (contracts/vault/src/lib.rs GAS_FT_WITHDRAW). */
export const FT_WITHDRAW_GAS = 100_000_000_000_000n;
/** The ERC-20 `Transfer(address,address,uint256)` event topic (keccak256 of that signature). */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The chains a POA asset is released on, by the asset id's prefix: `base-...` or `sol-...` (validate.rs). */
export type PoaChain = "base" | "solana";

const DEFAULT_INTENTS = "intents.near";
const ASSET_PREFIX: Readonly<Record<PoaChain, string>> = { base: "base-", solana: "sol-" };
/** validate.rs `is_evm_address`: `0x` and 40 hex digits in any case (EIP-55 checksummed or not). */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** A 32-byte EVM word (a transaction hash, a log topic, an ERC-20 Transfer's data): `0x` and 64 hex digits. */
const EVM_WORD_RE = /^0x[0-9a-fA-F]{64}$/;
/** An Ethereum JSON-RPC quantity: `0x` and hex digits with no leading zero (`0x0` for zero). */
const QUANTITY_RE = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
/** The 12 zero bytes in front of an address in an indexed address topic. */
const TOPIC_PAD = "0".repeat(24);

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value);
}

// ---------- the ft_withdraw call ----------

export interface PoaWithdrawRequest {
  /** The POA token on NEAR, for example `base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`. */
  asset: string;
  chain: PoaChain;
  /** The destination on `chain`: an EVM address for Base, a base58 public key for Solana. Kept byte for byte. */
  address: string;
  /** Base units of the asset. */
  amount: bigint;
  /** The NEAR Intents contract. Default `intents.near`. */
  intents?: string;
}

/** The `ft_withdraw` arguments, in the order the vault serializes them. */
export interface PoaWithdrawArgs {
  token: string;
  receiver_id: string;
  amount: string;
  memo: string;
  msg: null;
}

export interface PoaWithdrawCall {
  receiverId: string;
  methodName: "ft_withdraw";
  args: PoaWithdrawArgs;
  /** `JSON.stringify(args)`, key order token, receiver_id, amount, memo, msg: the bytes the vault sends. */
  argsJson: string;
  gas: bigint;
  deposit: 1n;
}

/**
 * The function call that withdraws `amount` of a POA asset from the caller's NEAR Intents balance to `address` on
 * `chain`, as the vault makes it: `ft_withdraw` on the intents contract with `token` and `receiver_id` both the
 * asset (the POA token burns what it receives with a `WITHDRAW_TO:` memo, and the bridge releases it on the other
 * chain), memo `WITHDRAW_TO:<address>`, `msg` null, 1 yoctoNEAR attached and 100 Tgas. A string `msg` would turn
 * the withdrawal into an `ft_transfer_call` (no refund path through the POA token), so the call never sets one. The
 * caller signs and sends it; this builds it and signs nothing.
 *
 * Throws TypeError for a chain other than base or solana; an asset that is not a NEAR account id with the chain's
 * prefix; a Base address that is not `0x` and 40 hex digits (the case is kept, so an EIP-55 checksummed address
 * reaches the memo byte for byte, as in the vault); a Solana address that is not base58 of exactly 32 bytes (the
 * vault checks 32 to 44 base58 characters only, so this is stricter); an amount that is not a bigint above zero and
 * at most 2^128 - 1; an intents contract that is not an account id.
 */
export function poaWithdrawCall(req: PoaWithdrawRequest): PoaWithdrawCall {
  if (!isRecord(req)) throw new TypeError("poaWithdrawCall: the request must be an object");
  const { asset, chain, address, amount } = req;
  const intents = req.intents ?? DEFAULT_INTENTS;
  if (chain !== "base" && chain !== "solana") {
    throw new TypeError(`poaWithdrawCall: chain must be "base" or "solana", got ${String(chain)}`);
  }
  if (!isAccountId(asset) || !asset.startsWith(ASSET_PREFIX[chain])) {
    throw new TypeError(
      `poaWithdrawCall: asset must be a NEAR account id starting with ${ASSET_PREFIX[chain]} for ${chain}`,
    );
  }
  if (chain === "base" && !isEvmAddress(address)) {
    throw new TypeError("poaWithdrawCall: a Base address must be 0x and 40 hex digits");
  }
  if (chain === "solana" && decodeBase58Hash(address) === null) {
    throw new TypeError("poaWithdrawCall: a Solana address must be base58 of exactly 32 bytes");
  }
  if (typeof amount !== "bigint" || amount <= 0n || amount > U128_MAX) {
    throw new TypeError("poaWithdrawCall: amount must be a bigint above 0 and at most 2^128 - 1");
  }
  if (!isAccountId(intents))
    throw new TypeError("poaWithdrawCall: intents must be a NEAR account id");
  // Literal key order: the bytes near-sdk serializes for the vault's ext_intents::ft_withdraw (memo Some, msg None).
  const args: PoaWithdrawArgs = {
    token: asset,
    receiver_id: asset,
    amount: amount.toString(),
    memo: `${WITHDRAW_TO_PREFIX}${address}`,
    msg: null,
  };
  return {
    receiverId: intents,
    methodName: "ft_withdraw",
    args,
    argsJson: JSON.stringify(args),
    gas: FT_WITHDRAW_GAS,
    deposit: 1n,
  };
}

// ---------- the POA bridge record ----------

/** One withdrawal as the POA bridge's `withdrawal_status` reports it. */
export interface PoaBridgeWithdrawal {
  /** `COMPLETED` once released. Other values pass through as the bridge gives them (not documented). */
  status: string;
  /** `data.tx_hash`: the NEAR transaction that burned. */
  burnTxHash: string;
  /** `data.transfer_tx_hash`: the release on the destination chain; null while there is none. */
  transferTxHash: string | null;
  /** `data.chain`, for example `eth:8453` (Base). */
  chain: string;
  nearTokenId: string;
  /** `data.address`: the token contract on the destination chain, not the recipient. */
  contractAddress: string | null;
  /** `data.account_id`: the NEAR Intents account that withdrew. */
  accountId: string;
  /** `data.amount`: base units burned, as the bridge reports them. */
  amount: bigint;
  /** `data.withdrawal_fee`: base units the bridge kept. */
  fee: bigint;
  /** `data.withdraw_amount`: base units released on the destination chain. */
  received: bigint;
  createdAt: string | null;
}

/**
 * The POA bridge's answer to `withdrawal_status` (the JSON-RPC `result`): `{ withdrawals: [{ status, data }] }`, or
 * one `{ status, data }`. The recorded mainnet answers carry both; `withdrawals` wins when present, and an empty list
 * gives `[]`. `amount` arrives as a JSON number, so a number above 2^53 - 1 (digits may already be lost) is refused;
 * a canonical decimal string is accepted too. `withdrawal_fee` and `withdraw_amount` are decimal strings. Throws
 * NearFormatError, `what` naming the refused field (for example `withdrawals[0].data.amount`). Status values other
 * than `COMPLETED` are not documented in what we read; a record without a fee or a released amount is refused
 * rather than guessed.
 */
export function parsePoaWithdrawalStatus(answer: unknown): PoaBridgeWithdrawal[] {
  if (!isRecord(answer)) refuse("withdrawal_status", "the answer is not an object");
  if ("withdrawals" in answer) {
    const list = answer.withdrawals;
    if (!Array.isArray(list)) refuse("withdrawals", "withdrawals is not a list");
    return list.map((item, i) => parseWithdrawal(item, `withdrawals[${i}].`));
  }
  if ("status" in answer && "data" in answer) return [parseWithdrawal(answer, "")];
  return refuse("withdrawal_status", "the answer has neither withdrawals nor status and data");
}

function refuse(what: string, text: string): never {
  throw new NearFormatError(what, `withdrawal_status: ${text}`);
}

function parseWithdrawal(item: unknown, at: string): PoaBridgeWithdrawal {
  const bad = (field: string, text: string): never =>
    refuse(`${at}${field}`, `${at}${field} ${text}`);
  if (!isRecord(item)) return bad("", "is not an object");
  const { status, data } = item;
  if (typeof status !== "string" || status.length === 0)
    return bad("status", "is not a status name");
  if (!isRecord(data)) return bad("data", "is not an object");
  const { tx_hash: burnTxHash, chain, near_token_id: nearTokenId, account_id: accountId } = data;
  if (!isBase58Hash(burnTxHash)) return bad("data.tx_hash", "is not a NEAR transaction hash");
  if (typeof chain !== "string" || chain.length === 0)
    return bad("data.chain", "is not a chain name");
  if (!isAccountId(nearTokenId)) return bad("data.near_token_id", "is not a NEAR account id");
  if (!isAccountId(accountId)) return bad("data.account_id", "is not a NEAR account id");
  const text = (field: string): string | null => {
    const value = data[field];
    if (value === undefined || value === null) return null;
    return typeof value === "string" && value.length > 0
      ? value
      : bad(`data.${field}`, "is not text or null");
  };
  const units = (field: string): bigint => {
    const value = data[field];
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : bad(`data.${field}`, "is a JSON number that is not a safe non-negative integer");
    }
    return parseU128(value) ?? bad(`data.${field}`, "is not a decimal amount");
  };
  return {
    status,
    burnTxHash,
    transferTxHash: text("transfer_tx_hash"),
    chain,
    nearTokenId,
    contractAddress: text("address"),
    accountId,
    amount: units("amount"),
    fee: units("withdrawal_fee"),
    received: units("withdraw_amount"),
    createdAt: text("created_at"),
  };
}

// ---------- the ERC-20 arrival ----------

export interface Erc20Transfer {
  /** Lowercase, as every hex value here. */
  txHash: string;
  blockNumber: bigint;
  contract: string;
  from: string;
  to: string;
  value: bigint;
  /** The log's `logIndex`; null when the receipt does not carry it (a trimmed record). */
  logIndex: number | null;
}

export type Erc20Match =
  | { ok: true; transfer: Erc20Transfer }
  | {
      ok: false;
      code: "malformed" | "reverted" | "wrong_tx" | "no_matching_transfer" | "ambiguous";
      detail: string;
    };

type Erc20Failure = Extract<Erc20Match, { ok: false }>;

/**
 * Finds the one ERC-20 `Transfer` of `contract` to `to` in an `eth_getTransactionReceipt` result. The receipt must be
 * for `txHash` (else `wrong_tx`) and have status `0x1` (`0x0` is `reverted`). A log counts when its address is
 * `contract` and its topic0 is the Transfer topic, and such a log must be ERC-20 shaped: exactly 3 topics, `from` and
 * `to` topics of 12 zero bytes and an address (dirty high bytes never pass for an address), 32 bytes of data; else
 * the receipt is `malformed`. Logs marked `removed: true` do not count. Exactly one counted log may go to `to` (two
 * are `ambiguous`), and its value must equal `want.value` when given. Hex is compared lowercase. A malformed `want`
 * is reported as `malformed`. Never throws.
 *
 * The receipt comes from a Base RPC and is not proven here. One Base transaction could be offered for two burns: a
 * caller that settles many payouts keeps the destination transaction hashes it has already counted.
 */
export function findErc20Transfer(
  receipt: unknown,
  want: { txHash: string; contract: string; to: string; value?: bigint },
): Erc20Match {
  const fail = (code: Erc20Failure["code"], detail: string): Erc20Failure => ({
    ok: false,
    code,
    detail,
  });
  if (!isRecord(want)) return fail("malformed", "want is not an object");
  if (typeof want.txHash !== "string" || !EVM_WORD_RE.test(want.txHash)) {
    return fail("malformed", "want.txHash is not 0x and 64 hex digits");
  }
  if (!isEvmAddress(want.contract)) return fail("malformed", "want.contract is not an EVM address");
  if (!isEvmAddress(want.to)) return fail("malformed", "want.to is not an EVM address");
  if (want.value !== undefined && (typeof want.value !== "bigint" || want.value < 0n)) {
    return fail("malformed", "want.value is not a non-negative bigint");
  }
  const txHash = want.txHash.toLowerCase();
  const contract = want.contract.toLowerCase();
  const to = want.to.toLowerCase();

  // eth_getTransactionReceipt answers null for a transaction it does not know, or does not know yet.
  if (!isRecord(receipt)) return fail("malformed", "the receipt is not an object");
  const hash = receipt.transactionHash;
  if (typeof hash !== "string" || !EVM_WORD_RE.test(hash)) {
    return fail("malformed", "the receipt's transactionHash is not 0x and 64 hex digits");
  }
  if (hash.toLowerCase() !== txHash) {
    return fail("wrong_tx", `the receipt is for ${hash.toLowerCase()}, not ${txHash}`);
  }
  if (receipt.status === "0x0")
    return fail("reverted", `transaction ${txHash} reverted (status 0x0)`);
  if (receipt.status !== "0x1") {
    return fail(
      "malformed",
      `the receipt's status is ${JSON.stringify(receipt.status) ?? "missing"}, not 0x1 or 0x0`,
    );
  }
  const blockNumber = quantity(receipt.blockNumber);
  if (blockNumber === null) return fail("malformed", "the receipt's blockNumber is not a quantity");
  if (!Array.isArray(receipt.logs)) return fail("malformed", "the receipt's logs are not a list");

  const matches: Erc20Transfer[] = [];
  let others = 0;
  let removed = 0;
  for (const [i, log] of receipt.logs.entries()) {
    if (!isRecord(log)) return fail("malformed", `logs[${i}] is not an object`);
    if (!isEvmAddress(log.address))
      return fail("malformed", `logs[${i}].address is not an EVM address`);
    if (log.address.toLowerCase() !== contract) continue;
    const topics = log.topics;
    if (!Array.isArray(topics)) return fail("malformed", `logs[${i}].topics is not a list`);
    const topic0 = topics[0];
    if (typeof topic0 !== "string" || topic0.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    // A Transfer of the contract must be shaped as an ERC-20 one (ERC-721's has a fourth topic, the token id).
    if (topics.length !== 3) {
      return fail("malformed", `logs[${i}] is a Transfer with ${topics.length} topics, not 3`);
    }
    const from = topicAddress(topics[1]);
    const recipient = topicAddress(topics[2]);
    if (from === null || recipient === null) {
      return fail(
        "malformed",
        `logs[${i}] has a from or to topic that is not 12 zero bytes and an address`,
      );
    }
    if (typeof log.data !== "string" || !EVM_WORD_RE.test(log.data)) {
      return fail("malformed", `logs[${i}].data is not 32 bytes`);
    }
    if (log.removed !== undefined && typeof log.removed !== "boolean") {
      return fail("malformed", `logs[${i}].removed is not a boolean`);
    }
    if (
      log.transactionHash !== undefined &&
      (typeof log.transactionHash !== "string" || log.transactionHash.toLowerCase() !== txHash)
    ) {
      return fail("malformed", `logs[${i}] names another transaction`);
    }
    let logIndex: number | null = null;
    if (log.logIndex !== undefined) {
      const index = quantity(log.logIndex);
      if (index === null || index > BigInt(Number.MAX_SAFE_INTEGER)) {
        return fail("malformed", `logs[${i}].logIndex is not a quantity`);
      }
      logIndex = Number(index);
    }
    if (log.removed === true) {
      removed += 1;
      continue;
    }
    if (recipient !== to) {
      others += 1;
      continue;
    }
    matches.push({ txHash, blockNumber, contract, from, to, value: BigInt(log.data), logIndex });
  }
  const [transfer, ...more] = matches;
  if (transfer === undefined) {
    return fail(
      "no_matching_transfer",
      `no Transfer of ${contract} to ${to} in ${txHash} (${others} to other addresses, ${removed} removed)`,
    );
  }
  if (more.length > 0) {
    return fail("ambiguous", `${matches.length} Transfers of ${contract} to ${to} in ${txHash}`);
  }
  if (want.value !== undefined && transfer.value !== want.value) {
    return fail(
      "no_matching_transfer",
      `the Transfer to ${to} moved ${transfer.value}, not ${want.value}`,
    );
  }
  return { ok: true, transfer };
}

function quantity(value: unknown): bigint | null {
  return typeof value === "string" && QUANTITY_RE.test(value) ? BigInt(value) : null;
}

/** The address in an indexed address topic, lowercase; null unless the topic is 12 zero bytes and 20 more. */
function topicAddress(topic: unknown): string | null {
  if (typeof topic !== "string" || !EVM_WORD_RE.test(topic)) return null;
  const lower = topic.toLowerCase();
  return lower.slice(2, 26) === TOPIC_PAD ? `0x${lower.slice(26)}` : null;
}
