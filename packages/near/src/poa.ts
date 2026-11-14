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
import { type EventProblem, nep141Events, nep245Events, type TypedItem } from "./events.js";
import type { OutcomeSource } from "./types.js";

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
 * chain), memo `WITHDRAW_TO:<address>`, `msg` null, 1 yoctoNEAR attached and 100 Tgas. `msg` stays null as in the
 * vault: a string `msg` makes intents.near call `ft_transfer_call` on the token instead of `ft_transfer`. The caller
 * signs and sends the call; this builds it and signs nothing.
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

// ---------- the burn pair ----------

/** One withdrawal as the NEAR transaction shows it: the intents `mt_burn` and the POA token's `ft_burn`, paired. */
export interface PoaBurn {
  asset: string;
  /** The `mt_burn` item's `owner_id`: the NEAR Intents account whose balance paid. */
  owner: string;
  amount: bigint;
  /** The `ft_burn` item's memo, `WITHDRAW_TO:<address>`. */
  memo: string;
  /** The memo after the prefix, byte for byte: where the bridge is told to release. */
  address: string;
  mtBurnReceiptId: string;
  ftBurnReceiptId: string;
  /** True when both events were read from proven outcomes. */
  proven: boolean;
}

export interface FindPoaBurnOptions {
  asset: string;
  /** The NEAR Intents contract that logs `mt_burn`. Default `intents.near`. */
  intents?: string;
  /** Keep only the burns of this NEAR Intents account. The pairing still reads every burn of the asset. */
  owner?: string;
  /** Who may log the POA ft_burn. Default [asset] (mainnet). The testnet intents-stub logs it itself: [asset, stub]. */
  ftBurnEmitters?: readonly string[];
}

interface MtBurnEntry {
  owner: string;
  amount: bigint;
  source: TypedItem<unknown>;
}

interface FtBurnEntry {
  amount: bigint;
  memo: string;
  source: TypedItem<unknown>;
}

/**
 * Pairs, in source order, the intents contract's NEP-245 `mt_burn` entries of `nep141:<asset>` with the POA token's
 * NEP-141 `ft_burn` items whose `owner_id` is the intents contract and whose memo starts `WITHDRAW_TO:`, from
 * successful receipts only, each event bound to the contract that logged it (the receipt-bound reader of
 * events.ts: an `ft_burn` logged by the vault or any other account is not read). Both counts and each pair's two
 * amounts must be equal, which the SDK's `findBurnPair` does not ask. Anything that stands in the way of a clean
 * pairing is a problem: unequal counts or amounts, an event of either contract that breaks its standard's schema,
 * a matching event whose receipt status is missing (a trimmed record), a malformed source. `burns` is empty
 * whenever `problems` is not, so a caller reading only `burns` never gets a pair out of a doubtful record.
 * Never throws: invalid options are a problem too.
 */
export function findPoaBurns(
  source: OutcomeSource,
  opts: FindPoaBurnOptions,
): { burns: PoaBurn[]; problems: string[] } {
  if (!isRecord(opts)) return { burns: [], problems: ["options: not an object"] };
  const { asset, owner } = opts;
  const intents = opts.intents ?? DEFAULT_INTENTS;
  const emitters = opts.ftBurnEmitters ?? [asset];
  const optionProblem = !isAccountId(asset)
    ? "options: asset is not a NEAR account id"
    : !isAccountId(intents)
      ? "options: intents is not a NEAR account id"
      : owner !== undefined && !isAccountId(owner)
        ? "options: owner is not a NEAR account id"
        : !Array.isArray(emitters) || emitters.length === 0 || !emitters.every(isAccountId)
          ? "options: ftBurnEmitters is not a non-empty list of NEAR account ids"
          : null;
  if (optionProblem !== null) return { burns: [], problems: [optionProblem] };

  const problems = new Set<string>();
  const note = (standard: string, list: readonly EventProblem[]) => {
    for (const p of list) {
      const at =
        p.receiptId === "" ? "" : ` (receipt ${p.receiptId}, ${p.emitter}, log ${p.logIndex})`;
      problems.add(`${standard}${at}: ${p.problem}`);
    }
  };
  const tokenId = `nep141:${asset}`;
  const mts: MtBurnEntry[] = [];
  const fts: FtBurnEntry[] = [];
  try {
    const mt = nep245Events(source, intents);
    note("nep245", mt.problems);
    for (const typed of mt.items) {
      const { item } = typed;
      if (item.event !== "mt_burn") continue;
      item.tokenIds.forEach((id, i) => {
        const amount = item.amounts[i];
        if (id === tokenId && amount !== undefined) {
          mts.push({ owner: item.ownerId, amount, source: typed });
        }
      });
    }
    const order = outcomeOrder(source);
    for (const emitter of new Set(emitters)) {
      const ft = nep141Events(source, emitter);
      note("nep141", ft.problems);
      for (const typed of ft.items) {
        const { item } = typed;
        if (
          item.event === "ft_burn" &&
          item.ownerId === intents &&
          item.memo?.startsWith(WITHDRAW_TO_PREFIX)
        ) {
          fts.push({ amount: item.amount, memo: item.memo, source: typed });
        }
      }
    }
    // Two emitters (the testnet stub and the token): put their burns back in source order.
    fts.sort(
      (a, b) =>
        (order.get(a.source.event.receiptId) ?? 0) - (order.get(b.source.event.receiptId) ?? 0) ||
        a.source.event.logIndex - b.source.event.logIndex ||
        a.source.itemIndex - b.source.itemIndex,
    );
  } catch (error) {
    // The readers throw only for invalid arguments, checked above; this keeps the never-throws promise anyway.
    problems.add(`reader: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (mts.length !== fts.length) {
    problems.add(
      `${mts.length} mt_burn of ${tokenId} by ${intents} and ${fts.length} WITHDRAW_TO ft_burn by ` +
        `${[...new Set(emitters)].join(", ")}: they do not pair`,
    );
  }
  const burns: PoaBurn[] = [];
  mts.forEach((mt, i) => {
    const ft = fts[i];
    if (ft === undefined) return;
    if (mt.amount !== ft.amount) {
      problems.add(
        `pair ${i}: mt_burn of ${mt.amount} (receipt ${mt.source.event.receiptId}) and ft_burn of ` +
          `${ft.amount} (receipt ${ft.source.event.receiptId}) differ`,
      );
      return;
    }
    burns.push({
      asset,
      owner: mt.owner,
      amount: mt.amount,
      memo: ft.memo,
      address: ft.memo.slice(WITHDRAW_TO_PREFIX.length),
      mtBurnReceiptId: mt.source.event.receiptId,
      ftBurnReceiptId: ft.source.event.receiptId,
      proven: mt.source.event.proven && ft.source.event.proven,
    });
  });
  if (problems.size > 0) return { burns: [], problems: [...problems] };
  return {
    burns: owner === undefined ? burns : burns.filter((b) => b.owner === owner),
    problems: [],
  };
}

/** Each outcome id's position in the source (transaction_outcome first), for sorting events read per emitter. */
function outcomeOrder(outcomes: OutcomeSource): Map<string, number> {
  const order = new Map<string, number>();
  const source: unknown = outcomes;
  const ids: unknown[] = Array.isArray(source)
    ? source.map((o: unknown) => (isRecord(o) ? o.id : undefined))
    : isRecord(source)
      ? [
          isRecord(source.transaction_outcome) ? source.transaction_outcome.id : undefined,
          ...(Array.isArray(source.receipts_outcome)
            ? source.receipts_outcome.map((o: unknown) => (isRecord(o) ? o.id : undefined))
            : []),
        ]
      : [];
  ids.forEach((id, i) => {
    if (typeof id === "string" && !order.has(id)) order.set(id, i);
  });
  return order;
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
  const bad = (field: string, text: string): never => {
    // `at` is "withdrawals[i]." or ""; the item itself is named without the trailing dot.
    const what = field === "" ? at.slice(0, -1) || "withdrawal_status" : `${at}${field}`;
    return refuse(what, `${what} ${text}`);
  };
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

// ---------- the settlement verdict ----------

export type PoaCheckId =
  | "near_burn"
  | "memo_address"
  | "bridge_record"
  | "destination_transfer"
  | "amounts";

export interface PoaSettlement {
  /** Every check passed. */
  ok: boolean;
  /** The five checks, in this order, each with a sentence saying what it saw. */
  checks: readonly { id: PoaCheckId; ok: boolean; detail: string }[];
  burn: PoaBurn | null;
  /** The bridge's record of this burn transaction when there is exactly one, even if a check on it failed. */
  bridge: PoaBridgeWithdrawal | null;
  transfer: Erc20Transfer | null;
}

/** What a settlement check needs before it can run. */
const NEEDS: Readonly<Record<PoaCheckId, PoaCheckId | null>> = {
  near_burn: null,
  memo_address: "near_burn",
  bridge_record: "near_burn",
  destination_transfer: "bridge_record",
  amounts: "bridge_record",
};

interface CheckResult {
  ok: boolean;
  detail: string;
}

/**
 * One verdict on a payout from NEAR Intents to a Base (EVM) address, across three independent records:
 *
 * - `near_burn`: the NEAR transaction (`near`, an RPC `tx` answer or proven outcomes) holds exactly one POA burn
 *   pair of `expect.asset` (findPoaBurns), with `expect.owner` and `expect.amount` when given. It is tied to
 *   `nearTxHash`: an RPC answer's `transaction.hash` and `transaction_outcome.id` must equal it when present, and
 *   proven outcomes must include the transaction's own outcome (pass those of proveTransaction or
 *   verifyTransactionOutcomes, which check that every receipt descends from it).
 * - `memo_address`: the burn's memo is `WITHDRAW_TO:` and `expect.address`, byte for byte.
 * - `bridge_record`: the bridge answer (`withdrawal_status`) holds exactly one record of `nearTxHash`, COMPLETED, for
 *   the asset and the burn's owner, with the burned amount, `fee + received` equal to it, a release transaction,
 *   and `expect.erc20` as its token contract when it names one.
 * - `destination_transfer`: the Base receipt is that release, and findErc20Transfer finds one Transfer of
 *   `expect.erc20` to `expect.address` of exactly the received amount.
 * - `amounts`: something was released, and the fee is at most `expect.maxFee` when given.
 *
 * The destination address is taken from the burn, never from the bridge answer (its `address` is the token
 * contract), and the amount from the burn; the bridge's figures are only compared with it. A later check that
 * needs an earlier one that failed says "skipped". The Base receipt is not proven here: it is what the Base RPC
 * answered, bound by hash to the bridge's record. Never throws.
 */
export function verifyPoaSettlement(input: {
  near: OutcomeSource;
  nearTxHash: string;
  bridgeAnswer: unknown;
  destinationReceipt: unknown;
  expect: {
    asset: string;
    address: string;
    erc20: string;
    amount?: bigint;
    owner?: string;
    intents?: string;
    ftBurnEmitters?: readonly string[];
    maxFee?: bigint;
  };
}): PoaSettlement {
  const checks: { id: PoaCheckId; ok: boolean; detail: string }[] = [];
  let burn: PoaBurn | null = null;
  let bridge: PoaBridgeWithdrawal | null = null;
  let transfer: Erc20Transfer | null = null;
  const settlement = (): PoaSettlement => ({
    ok: checks.length === Object.keys(NEEDS).length && checks.every((c) => c.ok),
    checks,
    burn,
    bridge,
    transfer,
  });
  const run = (id: PoaCheckId, check: () => CheckResult) => {
    const need = NEEDS[id];
    if (need !== null && !checks.some((c) => c.id === need && c.ok)) {
      checks.push({ id, ok: false, detail: `skipped: needs ${need}` });
      return;
    }
    let result: CheckResult;
    try {
      result = check();
    } catch (error) {
      result = no(error instanceof Error ? error.message : String(error));
    }
    checks.push({ id, ok: result.ok, detail: result.detail });
  };

  if (!isRecord(input) || !isRecord(input.expect)) {
    run("near_burn", () => no("the input or its expect is not an object"));
    for (const id of Object.keys(NEEDS) as PoaCheckId[])
      if (id !== "near_burn") run(id, () => no(""));
    return settlement();
  }
  const { near, nearTxHash, bridgeAnswer, destinationReceipt, expect } = input;

  run("near_burn", () => {
    if (!isBase58Hash(nearTxHash)) return no("nearTxHash is not a NEAR transaction hash");
    const untied = untiedReason(near, nearTxHash);
    if (untied !== null) return no(untied);
    const found = findPoaBurns(near, {
      asset: expect.asset,
      ...(expect.intents === undefined ? {} : { intents: expect.intents }),
      ...(expect.ftBurnEmitters === undefined ? {} : { ftBurnEmitters: expect.ftBurnEmitters }),
    });
    if (found.problems.length > 0) return no(found.problems.join("; "));
    const [only, ...more] = found.burns;
    if (only === undefined) {
      return no(
        `no POA withdrawal burn of ${expect.asset} in the successful receipts of ${nearTxHash}`,
      );
    }
    if (more.length > 0) {
      return no(
        `${found.burns.length} POA withdrawal burns of ${expect.asset} in ${nearTxHash}; this reads one`,
      );
    }
    if (expect.owner !== undefined && only.owner !== expect.owner) {
      return no(`the burn is from ${only.owner}, not ${String(expect.owner)}`);
    }
    if (expect.amount !== undefined && only.amount !== expect.amount) {
      return no(`the burn is of ${only.amount}, not ${String(expect.amount)}`);
    }
    burn = only;
    return yes(
      `${only.owner} burned ${only.amount} of nep141:${only.asset} (receipt ${only.mtBurnReceiptId}) and ` +
        `${only.asset} logged ft_burn with memo ${only.memo} (receipt ${only.ftBurnReceiptId})` +
        (only.proven ? ", both proven" : ", as the RPC answered"),
    );
  });

  run("memo_address", () => {
    const b = burn as PoaBurn;
    if (!isEvmAddress(expect.address)) {
      return no(
        "expect.address is not 0x and 40 hex digits (this verdict reads Base destinations)",
      );
    }
    const want = `${WITHDRAW_TO_PREFIX}${expect.address}`;
    if (b.memo === want) return yes(`the memo names ${expect.address}`);
    return no(
      b.memo.toLowerCase() === want.toLowerCase()
        ? `the memo ${b.memo} differs from ${want} by letter case alone`
        : `the memo is ${b.memo}, not ${want}`,
    );
  });

  run("bridge_record", () => {
    const b = burn as PoaBurn;
    let records: PoaBridgeWithdrawal[];
    try {
      records = parsePoaWithdrawalStatus(bridgeAnswer);
    } catch (error) {
      return no(
        `the bridge answer is not readable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const mine = records.filter((r) => r.burnTxHash === nearTxHash);
    const [record, ...more] = mine;
    if (record === undefined) {
      const others = records.map((r) => r.burnTxHash);
      return no(
        `the bridge has no record of ${nearTxHash}` +
          (others.length > 0 ? ` (its records are of ${others.join(", ")})` : ""),
      );
    }
    if (more.length > 0) return no(`the bridge has ${mine.length} records of ${nearTxHash}`);
    bridge = record;
    if (record.status !== "COMPLETED")
      return no(`the bridge's status is ${record.status}, not COMPLETED`);
    if (record.nearTokenId !== b.asset) {
      return no(`the bridge's record is of ${record.nearTokenId}, not ${b.asset}`);
    }
    if (record.accountId !== b.owner) {
      return no(`the bridge's record is for ${record.accountId}, but ${b.owner} burned`);
    }
    if (record.amount !== b.amount) {
      return no(`the bridge's record says ${record.amount} burned, the burn is of ${b.amount}`);
    }
    if (record.fee + record.received !== b.amount) {
      return no(
        `the bridge's fee ${record.fee} and released ${record.received} do not add up to the burned ${b.amount}`,
      );
    }
    if (record.transferTxHash === null) {
      return no("the bridge's record names no release transaction");
    }
    if (!EVM_WORD_RE.test(record.transferTxHash)) {
      return no(`the bridge's release ${record.transferTxHash} is not a Base transaction hash`);
    }
    if (
      record.contractAddress !== null &&
      isEvmAddress(expect.erc20) &&
      record.contractAddress.toLowerCase() !== expect.erc20.toLowerCase()
    ) {
      return no(
        `the bridge's record names token contract ${record.contractAddress}, not ${expect.erc20}`,
      );
    }
    return yes(
      `${record.status} on ${record.chain}: release ${record.transferTxHash}, fee ${record.fee}, ` +
        `released ${record.received}`,
    );
  });

  run("destination_transfer", () => {
    const record = bridge as PoaBridgeWithdrawal;
    const match = findErc20Transfer(destinationReceipt, {
      txHash: record.transferTxHash as string,
      contract: expect.erc20,
      to: expect.address,
      value: record.received,
    });
    if (!match.ok) return no(`${match.code}: ${match.detail}`);
    transfer = match.transfer;
    return yes(
      `${match.transfer.contract} moved ${match.transfer.value} from ${match.transfer.from} to ` +
        `${match.transfer.to} in ${match.transfer.txHash} (block ${match.transfer.blockNumber})`,
    );
  });

  run("amounts", () => {
    const b = burn as PoaBurn;
    const record = bridge as PoaBridgeWithdrawal;
    const { maxFee } = expect;
    if (maxFee !== undefined && (typeof maxFee !== "bigint" || maxFee < 0n)) {
      return no("expect.maxFee is not a non-negative bigint");
    }
    if (record.received <= 0n) return no(`the bridge released nothing of the burned ${b.amount}`);
    if (maxFee !== undefined && record.fee > maxFee)
      return no(`the fee ${record.fee} is above ${maxFee}`);
    const bound = maxFee === undefined ? "" : ` (at most ${maxFee})`;
    return yes(`burned ${b.amount}, released ${record.received}, fee ${record.fee}${bound}`);
  });

  return settlement();
}

function yes(detail: string): CheckResult {
  return { ok: true, detail };
}

function no(detail: string): CheckResult {
  return { ok: false, detail };
}

/** Null when the NEAR record is tied to `txHash`, else why it is not. */
function untiedReason(near: unknown, txHash: string): string | null {
  if (Array.isArray(near)) {
    return near.some((o: unknown) => isRecord(o) && o.id === txHash)
      ? null
      : `the proven outcomes do not include the outcome of transaction ${txHash}`;
  }
  if (!isRecord(near)) return "the NEAR record is not a tx answer or a list of proven outcomes";
  const hash = isRecord(near.transaction) ? near.transaction.hash : undefined;
  if (hash !== undefined && hash !== txHash) {
    return `the NEAR record is transaction ${String(hash)}, not ${txHash}`;
  }
  const outcomeId = isRecord(near.transaction_outcome) ? near.transaction_outcome.id : undefined;
  if (outcomeId !== undefined && outcomeId !== txHash) {
    return `the NEAR record's transaction outcome is ${String(outcomeId)}, not ${txHash}`;
  }
  return null;
}
