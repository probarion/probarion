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
/** Base as the POA bridge names it in a `withdrawal_status` record (`data.chain`): chain id 8453. */
const BASE_CHAIN = "eth:8453";
const NS_PER_MS = 1_000_000n;
const NS_PER_SECOND = 1_000_000_000n;
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
 * The native-asset POA tokens, `base.omft.near` (ETH on Base) and `sol.omft.near` (SOL), have no `base-` or `sol-`
 * prefix and are refused, as the vault refuses them; their releases make no ERC-20 Transfer, so verifyPoaSettlement
 * does not read them either.
 *
 * Throws TypeError for a chain other than base or solana; an asset that is not a NEAR account id with the chain's
 * prefix; a Base address that is not `0x` and 40 hex digits (the case is kept, so an EIP-55 checksummed address
 * reaches the memo byte for byte, as in the vault); a Solana address that is not base58 of exactly 32 bytes (the
 * vault checks for 32 to 44 base58 characters, so this is stricter); an amount that is not a bigint above zero and
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
  /** Keep the burns of this NEAR Intents account and drop the rest. The pairing still reads every burn of the asset. */
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
 * Pairs the intents contract's NEP-245 `mt_burn` entries of `nep141:<asset>` with the POA token's NEP-141 `ft_burn`
 * items whose `owner_id` is the intents contract and whose memo starts `WITHDRAW_TO:`, from receipts that
 * succeeded, each event bound to the contract that logged it (the receipt-bound reader of events.ts: an `ft_burn`
 * logged by the vault or any other account is not read). The pairing follows the receipts, not the list order:
 * each `ft_burn` belongs to the nearest receipt that holds an `mt_burn` of the asset and is its own receipt (the
 * testnet intents-stub logs both events in one) or one it descends from through `receipt_ids` (`receiptIds` for
 * proven outcomes; on mainnet the token's receipt is a child of the intents receipt). Both counts, the counts under
 * each such receipt and each pair's two amounts must be equal, which the SDK's `findBurnPair` does not ask. When one
 * receipt holds several `mt_burn` entries, they pair in source order when every order gives the same burns (the
 * entries share owner and amount, or the `ft_burn` items share amount, memo and receipt), and not otherwise.
 *
 * Anything that stands in the way of a clean pairing is a problem: unequal counts or amounts, an `ft_burn` under no
 * receipt with an `mt_burn` of the asset, several burns in one receipt that would pair differently in another order,
 * an event of either contract that breaks its standard's schema, a matching event whose receipt status is missing
 * (a trimmed record), a malformed source. `burns` is empty whenever `problems` is not, so a caller who reads
 * `burns` alone gets no pair out of a doubtful record. It does not throw: invalid options are a problem too.
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
  const links = outcomeLinks(source);
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
    const { order } = links;
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
    // The readers throw for invalid arguments alone, checked above; this keeps the no-throw promise anyway.
    problems.add(`reader: ${error instanceof Error ? error.message : String(error)}`);
  }

  let pairs: (readonly [MtBurnEntry, FtBurnEntry])[] = [];
  if (mts.length !== fts.length) {
    problems.add(
      `${mts.length} mt_burn of ${tokenId} by ${intents} and ${fts.length} WITHDRAW_TO ft_burn by ` +
        `${[...new Set(emitters)].join(", ")}: they do not pair`,
    );
  } else if (problems.size === 0) {
    pairs = pairByReceipt(mts, fts, links, tokenId, problems);
  }
  const burns: PoaBurn[] = [];
  pairs.forEach(([mt, ft], i) => {
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

interface OutcomeLinks {
  /** Each outcome id's position in the source (transaction_outcome at 0), for sorting events read per emitter. */
  order: Map<string, number>;
  /** Each outcome id's `receipt_ids` (`receiptIds` for proven outcomes): the receipts it created. */
  children: Map<string, readonly string[]>;
}

/** The order of a source's outcomes and the receipts each created. A missing or malformed list counts as none. */
function outcomeLinks(outcomes: OutcomeSource): OutcomeLinks {
  const order = new Map<string, number>();
  const children = new Map<string, readonly string[]>();
  const source: unknown = outcomes;
  const proven = Array.isArray(source);
  const list: unknown[] = proven
    ? source
    : isRecord(source)
      ? [
          source.transaction_outcome,
          ...(Array.isArray(source.receipts_outcome) ? source.receipts_outcome : []),
        ]
      : [];
  list.forEach((o, i) => {
    if (!isRecord(o) || typeof o.id !== "string" || order.has(o.id)) return;
    order.set(o.id, i);
    const ids: unknown = proven
      ? o.receiptIds
      : isRecord(o.outcome)
        ? o.outcome.receipt_ids
        : undefined;
    children.set(
      o.id,
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
    );
  });
  return { order, children };
}

/**
 * The pairs of findPoaBurns, in `mts` order: each ft_burn goes to the nearest receipt, its own or an ancestor, that
 * holds an mt_burn of the token. Adds a problem, and leaves the receipt's burns unpaired, for an ft_burn under no
 * such receipt, a receipt whose two counts differ, and a receipt whose several burns would pair differently in
 * another order.
 */
function pairByReceipt(
  mts: readonly MtBurnEntry[],
  fts: readonly FtBurnEntry[],
  links: OutcomeLinks,
  tokenId: string,
  problems: Set<string>,
): (readonly [MtBurnEntry, FtBurnEntry])[] {
  const parent = new Map<string, string>();
  for (const [id, kids] of links.children) {
    for (const kid of kids) {
      const known = parent.get(kid);
      if (known === undefined) parent.set(kid, id);
      else if (known !== id)
        problems.add(`receipt ${kid} is listed as created by both ${known} and ${id}`);
    }
  }
  const mtsAt = new Map<string, MtBurnEntry[]>();
  for (const mt of mts) {
    const at = mt.source.event.receiptId;
    mtsAt.set(at, [...(mtsAt.get(at) ?? []), mt]);
  }
  const ftsAt = new Map<string, FtBurnEntry[]>();
  for (const ft of fts) {
    const own = ft.source.event.receiptId;
    let at: string | undefined = own;
    const seen = new Set<string>();
    while (at !== undefined && !mtsAt.has(at) && !seen.has(at)) {
      seen.add(at);
      at = parent.get(at);
    }
    if (at === undefined || !mtsAt.has(at)) {
      problems.add(
        `ft_burn (receipt ${own}) does not descend from a receipt with an mt_burn of ${tokenId}`,
      );
      continue;
    }
    ftsAt.set(at, [...(ftsAt.get(at) ?? []), ft]);
  }
  const paired = new Map<MtBurnEntry, FtBurnEntry>();
  for (const [at, here] of mtsAt) {
    const under = ftsAt.get(at) ?? [];
    if (under.length !== here.length) {
      problems.add(
        `receipt ${at} holds ${here.length} mt_burn of ${tokenId} and ${under.length} WITHDRAW_TO ft_burn ` +
          "descend from it: they do not pair",
      );
      continue;
    }
    const [mt0, ...mtRest] = here;
    const [ft0, ...ftRest] = under;
    const sameMt = mtRest.every((m) => m.owner === mt0?.owner && m.amount === mt0?.amount);
    const sameFt = ftRest.every(
      (f) =>
        f.amount === ft0?.amount &&
        f.memo === ft0?.memo &&
        f.source.event.receiptId === ft0?.source.event.receiptId,
    );
    if (!sameMt && !sameFt) {
      problems.add(
        `receipt ${at} holds ${here.length} mt_burn of ${tokenId} that differ, and the receipts do not tell ` +
          "which ft_burn is whose",
      );
      continue;
    }
    here.forEach((mt, i) => {
      const ft = under[i];
      if (ft !== undefined) paired.set(mt, ft);
    });
  }
  return mts.flatMap((mt) => {
    const ft = paired.get(mt);
    return ft === undefined ? [] : [[mt, ft] as const];
  });
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
  /**
   * `data.amount`: base units burned, as the bridge reports them. When the bridge sent a JSON number above
   * 2^53 - 1, this is that number's own value and `amountExact` is false: the digits past it may be lost.
   */
  amount: bigint;
  /** False when `amount` came from a JSON number above 2^53 - 1; `fee + received` then stand for it exactly. */
  amountExact: boolean;
  /** `data.withdrawal_fee`: base units the bridge kept. */
  fee: bigint;
  /** `data.withdraw_amount`: base units released on the destination chain. */
  received: bigint;
  createdAt: string | null;
}

/**
 * The POA bridge's answer to `withdrawal_status` (the JSON-RPC `result`): `{ withdrawals: [{ status, data }] }`, or
 * one `{ status, data }`. The recorded mainnet answers carry both; `withdrawals` wins when present, and an empty list
 * gives `[]`. `amount` arrives as a JSON number. A number above 2^53 - 1 (an 18-decimal token above about 0.009 of
 * it, say) may already have lost digits: it is kept with `amountExact` false, and verifyPoaSettlement then settles
 * on `withdrawal_fee + withdraw_amount`. A canonical decimal string is accepted too. `withdrawal_fee` and
 * `withdraw_amount` are decimal strings, and as JSON numbers they must be at most 2^53 - 1. Throws
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
  /** A field's base units and whether they are exact (a JSON number above 2^53 - 1 is not; `amount` alone may be). */
  const units = (field: string, inexactOk: boolean): [bigint, boolean] => {
    const value = data[field];
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0) {
        return bad(`data.${field}`, "is a JSON number that is not a non-negative integer");
      }
      if (Number.isSafeInteger(value)) return [BigInt(value), true];
      if (!inexactOk) {
        return bad(`data.${field}`, "is a JSON number above 2^53 - 1, whose digits may be lost");
      }
      const big = BigInt(value);
      return big <= U128_MAX ? [big, false] : bad(`data.${field}`, "is above 2^128 - 1");
    }
    const parsed = parseU128(value);
    return parsed === null ? bad(`data.${field}`, "is not a decimal amount") : [parsed, true];
  };
  const [amount, amountExact] = units("amount", true);
  const [fee] = units("withdrawal_fee", false);
  const [received] = units("withdraw_amount", false);
  return {
    status,
    burnTxHash,
    transferTxHash: text("transfer_tx_hash"),
    chain,
    nearTokenId,
    contractAddress: text("address"),
    accountId,
    amount,
    amountExact,
    fee,
    received,
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
  /** The log's `blockTimestamp`, seconds since 1970; null when the RPC does not add it to logs (not all do). */
  blockTimestamp: bigint | null;
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
 * `to` topics of 12 zero bytes and an address (dirty high bytes do not pass for an address), 32 bytes of data; else
 * the receipt is `malformed`. Logs marked `removed: true` do not count. Exactly one counted log may go to `to` (two
 * are `ambiguous`), and its value must equal `want.value` when given. Hex is compared lowercase. A log's
 * `blockTimestamp`, which some RPCs add, is read when present and must then be a quantity. A malformed `want` is
 * reported as `malformed`. It does not throw.
 *
 * The receipt comes from a Base RPC and is not proven here. One Base transaction could be offered for two burns: a
 * caller that settles many payouts keeps the destination transaction hashes it has already counted (the
 * `countedReleases` of verifyPoaSettlement).
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
    let blockTimestamp: bigint | null = null;
    if (log.blockTimestamp !== undefined) {
      blockTimestamp = quantity(log.blockTimestamp);
      if (blockTimestamp === null) {
        return fail("malformed", `logs[${i}].blockTimestamp is not a quantity`);
      }
    }
    if (log.removed === true) {
      removed += 1;
      continue;
    }
    if (recipient !== to) {
      others += 1;
      continue;
    }
    matches.push({
      txHash,
      blockNumber,
      contract,
      from,
      to,
      value: BigInt(log.data),
      logIndex,
      blockTimestamp,
    });
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
 * One verdict on a payout from NEAR Intents to a Base (EVM) address, across three records: the NEAR burn, the POA
 * bridge's record of it, and the Base release that record names.
 *
 * - `near_burn`: the NEAR transaction (`near`, an RPC `tx` answer or proven outcomes) holds exactly one POA burn
 *   pair of `expect.asset` (findPoaBurns), with `expect.owner` and `expect.amount` when given. It is tied to
 *   `nearTxHash`: an RPC answer's `transaction.hash` must equal it when present and its `transaction_outcome.id`
 *   must equal it, proven outcomes must include the transaction's own outcome, and both burn receipts must descend
 *   from that outcome through `receipt_ids` (`receiptIds`). Proven outcomes are those of proveTransaction or
 *   verifyTransactionOutcomes.
 * - `memo_address`: the burn's memo is `WITHDRAW_TO:` and `expect.address`, byte for byte.
 * - `bridge_record`: the bridge answer (`withdrawal_status`) holds exactly one record of `nearTxHash`, COMPLETED, on
 *   Base (`eth:8453`), for the asset and the burn's owner, with the burned amount (when the bridge's `amount` is an
 *   inexact JSON number, it must round to the same number as the burn's), `fee + received` equal to the burn, a
 *   release that is a Base transaction hash and not in `expect.countedReleases`, and `expect.erc20` as its token
 *   contract when it names one.
 * - `destination_transfer`: the Base receipt is that release, and findErc20Transfer finds one Transfer of
 *   `expect.erc20` to `expect.address` of exactly the received amount; it comes from one of `expect.releaseFrom`
 *   when that is given; and its Base block time is not earlier than the second of the `ft_burn`'s NEAR block when
 *   both times are known (proven outcomes carry NEAR block times, an RPC `tx` answer does not; the log's
 *   `blockTimestamp` is there when the Base RPC adds it). Its detail says which of these were checked.
 * - `amounts`: something was released, and the fee is at most `expect.maxFee`, which is required.
 *
 * What it trusts. Nothing in the Base receipt names the NEAR burn: the release it reads is a plain ERC-20
 * Transfer, so which Base transaction is this burn's release, and the fee, are the bridge's word. The checks above
 * bound that word: with `fee + received` equal to the burn and the fee at most `maxFee`, the release the bridge
 * names must move the same token to the same address, at least `amount - maxFee` of it; `releaseFrom` pins the
 * sender; the time order rules out a release made before the burn; and `countedReleases` keeps one release from
 * settling two burns. A caller that settles many payouts passes there the release hashes it has already counted
 * (each verdict's `transfer.txHash`). Within those bounds, the bridge's choice of release is trusted.
 *
 * The destination address is taken from the burn, not from the bridge answer (its `address` is the token
 * contract), and the amount from the burn; the bridge's figures are compared with it. A later check that
 * needs an earlier one that failed says "skipped". The Base receipt is not proven here: it is what the Base RPC
 * answered, bound by hash to the bridge's record. It does not throw.
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
    /** The largest fee, in the asset's base units, the caller accepts. There is no default: see "What it trusts". */
    maxFee: bigint;
    amount?: bigint;
    owner?: string;
    intents?: string;
    ftBurnEmitters?: readonly string[];
    /** The bridge's Base senders: the Transfer must come from one of them. Not checked when absent. */
    releaseFrom?: readonly string[];
    /** Base release hashes already counted for other burns: a record that names one fails `bridge_record`. */
    countedReleases?: readonly string[];
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
    // The later checks need near_burn, so each says "skipped".
    for (const id of (Object.keys(NEEDS) as PoaCheckId[]).slice(1)) run(id, () => no(""));
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
    if (expect.amount !== undefined && typeof expect.amount !== "bigint") {
      return no("expect.amount is not a bigint");
    }
    const [single, ...more] = found.burns;
    if (single === undefined) {
      return no(
        `no POA withdrawal burn of ${expect.asset} in the successful receipts of ${nearTxHash}`,
      );
    }
    if (more.length > 0) {
      return no(
        `${found.burns.length} POA withdrawal burns of ${expect.asset} in ${nearTxHash}; this reads one`,
      );
    }
    const tied = descendantsOf(near, nearTxHash);
    if (typeof tied === "string") return no(tied);
    for (const id of [single.mtBurnReceiptId, single.ftBurnReceiptId]) {
      if (!tied.has(id)) {
        return no(
          `receipt ${id} of the burn does not descend from the outcome of transaction ${nearTxHash}`,
        );
      }
    }
    if (expect.owner !== undefined && single.owner !== expect.owner) {
      return no(`the burn is from ${single.owner}, not ${String(expect.owner)}`);
    }
    if (expect.amount !== undefined && single.amount !== expect.amount) {
      return no(`the burn is of ${single.amount}, not ${String(expect.amount)}`);
    }
    burn = single;
    return yes(
      `${single.owner} burned ${single.amount} of nep141:${single.asset} (receipt ${single.mtBurnReceiptId}) and ` +
        `${single.asset} logged ft_burn with memo ${single.memo} (receipt ${single.ftBurnReceiptId})` +
        (single.proven ? ", both proven" : ", as the RPC answered"),
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
    if (record.chain !== BASE_CHAIN) {
      return no(`the bridge's record is for chain ${record.chain}, not ${BASE_CHAIN} (Base)`);
    }
    if (record.nearTokenId !== b.asset) {
      return no(`the bridge's record is of ${record.nearTokenId}, not ${b.asset}`);
    }
    if (record.accountId !== b.owner) {
      return no(`the bridge's record is for ${record.accountId}, but ${b.owner} burned`);
    }
    // An inexact JSON number is compared as a number: the burn's amount must round to it.
    if (
      record.amountExact ? record.amount !== b.amount : Number(record.amount) !== Number(b.amount)
    ) {
      return no(
        `the bridge's record says ${record.amount} burned` +
          (record.amountExact ? "" : " (a JSON number above 2^53 - 1)") +
          `, the burn is of ${b.amount}`,
      );
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
    const { countedReleases } = expect;
    if (countedReleases !== undefined) {
      if (!Array.isArray(countedReleases) || !countedReleases.every((h) => typeof h === "string")) {
        return no("expect.countedReleases is not a list of transaction hashes");
      }
      const release = record.transferTxHash.toLowerCase();
      if (countedReleases.some((h) => h.toLowerCase() === release)) {
        return no(
          `the bridge's release ${release} is in expect.countedReleases: it was counted for another burn`,
        );
      }
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
        `released ${record.received}` +
        (record.amountExact
          ? ""
          : "; its amount is an inexact JSON number, so fee + released stand for it"),
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
    const t = match.transfer;
    const { releaseFrom } = expect;
    let sender = "; the sender is not checked (no expect.releaseFrom)";
    if (releaseFrom !== undefined) {
      if (
        !Array.isArray(releaseFrom) ||
        releaseFrom.length === 0 ||
        !releaseFrom.every(isEvmAddress)
      ) {
        return no("expect.releaseFrom is not a non-empty list of EVM addresses");
      }
      if (!releaseFrom.some((a) => a.toLowerCase() === t.from)) {
        return no(`the Transfer is from ${t.from}, which is not in expect.releaseFrom`);
      }
      sender = ", a sender in expect.releaseFrom";
    }
    const burnedAtNs = provenBlockTime(near, (burn as PoaBurn).ftBurnReceiptId);
    let order: string;
    if (burnedAtNs === null) {
      order = "; the order in time is not checked (the NEAR record carries no block times)";
    } else if (t.blockTimestamp === null) {
      order = "; the order in time is not checked (the Base log carries no blockTimestamp)";
    } else if (t.blockTimestamp < burnedAtNs / NS_PER_SECOND) {
      return no(
        `the release's Base block time ${isoMs(t.blockTimestamp * 1000n)} is earlier than the burn's NEAR ` +
          `block time ${isoMs(burnedAtNs / NS_PER_MS)}: it is not this burn's release`,
      );
    } else {
      order =
        `, at ${isoMs(t.blockTimestamp * 1000n)}, not before the burn's NEAR block at ` +
        isoMs(burnedAtNs / NS_PER_MS);
    }
    transfer = t;
    return yes(
      `${t.contract} moved ${t.value} from ${t.from} to ${t.to} in ${t.txHash} (block ${t.blockNumber})` +
        sender +
        order,
    );
  });

  run("amounts", () => {
    const b = burn as PoaBurn;
    const record = bridge as PoaBridgeWithdrawal;
    const { maxFee } = expect;
    if (typeof maxFee !== "bigint" || maxFee < 0n) {
      return no(
        "expect.maxFee is not a non-negative bigint: it is required, since the bridge sets the fee and a free " +
          "fee would let it name a smaller release to the same address",
      );
    }
    if (record.received <= 0n) return no(`the bridge released nothing of the burned ${b.amount}`);
    if (record.fee > maxFee) return no(`the fee ${record.fee} is above ${maxFee}`);
    return yes(
      `burned ${b.amount}, released ${record.received}, fee ${record.fee} (at most ${maxFee})`,
    );
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

/**
 * The ids of transaction `txHash`'s outcome and every receipt that descends from it through `receipt_ids`
 * (`receiptIds`), or why the record does not hold that outcome.
 */
function descendantsOf(near: OutcomeSource, txHash: string): Set<string> | string {
  const source: unknown = near;
  const hasOutcome = Array.isArray(source)
    ? source.some((o: unknown) => isRecord(o) && o.id === txHash)
    : isRecord(source) &&
      isRecord(source.transaction_outcome) &&
      source.transaction_outcome.id === txHash;
  if (!hasOutcome) {
    return `the NEAR record has no outcome of transaction ${txHash}, so its receipts are not tied to it`;
  }
  const { children } = outcomeLinks(near);
  const reached = new Set<string>([txHash]);
  const queue = [txHash];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const kid of children.get(id) ?? []) {
      if (!reached.has(kid)) {
        reached.add(kid);
        queue.push(kid);
      }
    }
  }
  return reached;
}

/** The block time, in nanoseconds, of a proven outcome; null for an RPC tx answer, which carries none. */
function provenBlockTime(near: OutcomeSource, id: string): bigint | null {
  if (!Array.isArray(near)) return null;
  const found: unknown = near.find((o: unknown) => isRecord(o) && o.id === id);
  if (!isRecord(found) || !isRecord(found.block)) return null;
  const { timestampNs } = found.block;
  return typeof timestampNs === "bigint" ? timestampNs : null;
}

/** Milliseconds since 1970 as an ISO time, or as a number when out of the Date range. */
function isoMs(ms: bigint): string {
  const n = Number(ms);
  return Math.abs(n) <= 8.64e15 ? new Date(n).toISOString() : `${ms} ms`;
}
