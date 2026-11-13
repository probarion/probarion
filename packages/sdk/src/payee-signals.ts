// The chain reads behind a payee check (core's `assessPayee`): read-only views and block headers, nothing signed or
// sent. Every read that fails, times out or answers in a shape this module does not know leaves its signal
// "unknown" with a one-line reason, and `assessPayee` turns an unknown signal into a warning. This function never
// throws for a failed read.
//
// It imports nothing that needs Node beyond `fetch`, so a browser page can run it too: FastNEAR's archival nodes
// answer with CORS `*`. (A vault's history goes through `RpcClient.viewFunction`, which encodes its arguments with
// `Buffer`; Next.js provides that in the browser.)
import {
  type KnownPayee,
  NETWORKS,
  type NetworkId,
  type PayeeRef,
  type PayeeSignalName,
  type PayeeSignals,
  payeeRefProblem,
  samePayee,
} from "@probarion/core";
import { RpcError } from "./errors.js";
import { isRecord, messageOf } from "./guards.js";
import { codeIdentity, isUnknownAccountError, RpcClient, type ViewAccountResult } from "./rpc.js";

export interface ReadPayeeSignalsInput {
  network: NetworkId;
  payee: PayeeRef;
  /** The vault whose mandates and spends say which payees it knows and has paid. Without one, none are read. */
  vault?: string | undefined;
}

export interface ReadPayeeSignalsOptions {
  /** NEAR RPC for the final block and the block-time sample. Default: the network's (`NETWORKS[network].rpcUrls`). */
  rpcUrls?: readonly string[];
  /** Archival NEAR RPC for the account at the block about 7 days back. Default: `PAYEE_ARCHIVAL_RPC_URLS[network]`. */
  archivalRpcUrls?: readonly string[];
  /** Base JSON-RPC for a Base payee; null leaves Base unread (unknown). Default: `PAYEE_BASE_RPC_URLS[network]`. */
  baseRpcUrl?: string | null;
  fetch?: typeof fetch;
  /** Milliseconds for each request (default 3000). Each endpoint gets one more try after a short back-off. */
  timeoutMs?: number;
  /** Milliseconds for all the reads together (default 15000): a read still waiting then is unknown. */
  budgetMs?: number;
  /** The clock for `read_at`. */
  now?: () => Date;
}

/**
 * FastNEAR's archival nodes: they answer for old blocks, with CORS `*`. The same nodes as
 * `DEFAULT_ARCHIVAL_RPC_URLS` (snapshot.ts), named here so that this module does not load the snapshot code.
 */
export const PAYEE_ARCHIVAL_RPC_URLS: Readonly<Record<NetworkId, readonly string[]>> = {
  mainnet: ["https://archival-rpc.mainnet.fastnear.com"],
  testnet: ["https://archival-rpc.testnet.fastnear.com"],
};

/**
 * Base mainnet's public JSON-RPC. A testnet vault pays a Base payee through a stub (NEAR Intents has no testnet), so
 * testnet maps to no Base chain and its Base signals stay unknown.
 */
export const PAYEE_BASE_RPC_URLS: Readonly<Record<NetworkId, string | null>> = {
  mainnet: "https://mainnet.base.org",
  testnet: null,
};

export const PAYEE_SIGNALS_TIMEOUT_MS = 3000;
export const PAYEE_SIGNALS_BUDGET_MS = 15_000;

/** The code hash NEAR reports for an account with no code: 32 zero bytes in base58. */
const NO_CODE_HASH = "11111111111111111111111111111111";
const WEEK_NS = 7n * 24n * 3600n * 1_000_000_000n;
/** Blocks between the two headers that give the block time: about 16 hours at 0.6 s a block. */
const SAMPLE_BLOCKS = 100_000;
/** A height with no block (a skipped one) is retried this many times, one block lower each time. */
const SKIPPED_TRIES = 5;
/** The vault views' page cap (the contracts' `MAX_PAGE`). */
const PAGE = 100;
/** A vault with more mandates or spends than this is not read in full, so its history is unknown. */
const MAX_HISTORY_ROWS = 2000;
const WHY_MAX = 200;

type Read<T> = { ok: true; value: T } | { ok: false; why: string };

async function attempt<T>(run: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const text = messageOf(error).replace(/\s+/g, " ").trim();
    return { ok: false, why: text.length <= WHY_MAX ? text : `${text.slice(0, WHY_MAX)}…` };
  }
}

function isUnknownBlock(error: unknown): boolean {
  if (!(error instanceof RpcError) || !isRecord(error.rpcError)) return false;
  const cause = error.rpcError.cause;
  return isRecord(cause) && cause.name === "UNKNOWN_BLOCK";
}

/** `run(height)`, and on a height with no block (UNKNOWN_BLOCK) the next lower one, a few times. */
async function atOrBelow<T>(
  height: number,
  run: (h: number) => Promise<T>,
): Promise<{ height: number; value: T }> {
  for (let i = 0; ; i++) {
    try {
      return { height: height - i, value: await run(height - i) };
    } catch (error) {
      if (!isUnknownBlock(error) || i + 1 >= SKIPPED_TRIES) throw error;
    }
  }
}

interface Header {
  height: number;
  timestampNs: bigint;
}

function toHeader(raw: unknown): Header {
  const header = isRecord(raw) ? raw.header : undefined;
  if (!isRecord(header)) throw new Error("block: the answer has no header");
  const { height, timestamp_nanosec: ns } = header;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error("block: malformed height");
  }
  if (typeof ns !== "string" || !/^\d{1,30}$/.test(ns))
    throw new Error("block: malformed timestamp");
  return { height, timestampNs: BigInt(ns) };
}

/**
 * The height about 7 days before the final block, from two headers: the final one and one `SAMPLE_BLOCKS` below it,
 * whose times give the average block time.
 */
async function heightWeekAgo(rpc: RpcClient): Promise<number> {
  const top = toHeader(await rpc.call<unknown>("block", { finality: "final" }));
  const sample = await atOrBelow(top.height - SAMPLE_BLOCKS, async (h) =>
    toHeader(await rpc.call<unknown>("block", { block_id: h })),
  );
  const blocks = BigInt(top.height - sample.value.height);
  const elapsed = top.timestampNs - sample.value.timestampNs;
  if (blocks <= 0n || elapsed <= 0n)
    throw new Error("block: the sampled block times do not advance");
  const back = Number((WEEK_NS * blocks) / elapsed);
  if (!Number.isSafeInteger(back) || back <= 0 || back >= top.height) {
    throw new Error("block: no block about 7 days back");
  }
  return top.height - back;
}

type AccountRead = { kind: "found"; account: ViewAccountResult } | { kind: "missing" };

async function readAccount(
  rpc: RpcClient,
  accountId: string,
  blockId?: number,
): Promise<AccountRead> {
  try {
    return { kind: "found", account: await rpc.viewAccount(accountId, blockId) };
  } catch (error) {
    if (isUnknownAccountError(error)) return { kind: "missing" };
    throw error;
  }
}

/**
 * What code an account runs: its code identity (its own code hash, or the hash of the global contract it uses), or
 * the account of the global contract it names by account id (NEP-591), whose own code hash is all ones.
 */
function codeOf(account: ViewAccountResult): string {
  const byAccount = account.global_contract_account_id;
  return byAccount === undefined ? codeIdentity(account) : `global contract of ${byAccount}`;
}

/** A mandate's payee or a spend's destination as the contract serialises it (`Payee`), as a `PayeeRef`. */
function toPayeeRef(raw: unknown, where: string): PayeeRef {
  if (isRecord(raw)) {
    if (raw.type === "near" && typeof raw.account_id === "string") {
      return { chain: "near", address: raw.account_id };
    }
    if (
      raw.type === "intents" &&
      (raw.chain === "base" || raw.chain === "solana") &&
      typeof raw.address === "string"
    ) {
      return { chain: raw.chain, address: raw.address };
    }
  }
  throw new Error(`${where}: malformed payee`);
}

async function listRows(rpc: RpcClient, vault: string, method: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; from < MAX_HISTORY_ROWS; from += PAGE) {
    const page = await rpc.viewFunction<unknown>(vault, method, { from_index: from, limit: PAGE });
    if (!Array.isArray(page) || page.length > PAGE) {
      throw new Error(`${method}: the answer is not a page of at most ${PAGE} rows`);
    }
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
  throw new Error(`${method}: more than ${MAX_HISTORY_ROWS} rows, so not all were read`);
}

/**
 * The vault's payees: each mandate's payee with its mandate ids, and each spend's destination with the count of its
 * spends that were paid out (`paid` to a NEAR account, `burned` for an Intents withdrawal to Base or Solana).
 */
export async function readKnownPayees(rpc: RpcClient, vault: string): Promise<KnownPayee[]> {
  const [mandates, spends] = await Promise.all([
    listRows(rpc, vault, "list_mandates"),
    listRows(rpc, vault, "list_spends"),
  ]);
  const known: Array<{ payee: PayeeRef; paid: number; mandates: number[] }> = [];
  const entry = (payee: PayeeRef) => {
    let found = known.find((k) => samePayee(k.payee, payee));
    if (found === undefined) {
      found = { payee, paid: 0, mandates: [] };
      known.push(found);
    }
    return found;
  };
  for (const row of mandates) {
    if (!isRecord(row) || typeof row.id !== "number" || !Number.isSafeInteger(row.id)) {
      throw new Error("list_mandates: malformed mandate");
    }
    entry(toPayeeRef(row.payee, `list_mandates ${row.id}`)).mandates.push(row.id);
  }
  for (const row of spends) {
    if (!isRecord(row) || typeof row.status !== "string")
      throw new Error("list_spends: malformed spend");
    const payee = toPayeeRef(row.destination, `list_spends ${String(row.id)}`);
    if (row.status === "paid" || row.status === "burned") entry(payee).paid += 1;
  }
  return known.map((k) => ({ ...k, mandates: [...new Set(k.mandates)].sort((a, b) => a - b) }));
}

/**
 * Reads the signals `assessPayee` (@probarion/core) needs for one payee:
 * - NEAR: the account at the final block (exists, contract), and at a block about 7 days back on an archival node
 *   (new, code changed);
 * - Base (mainnet only): eth_getCode (contract) and eth_getTransactionCount (0 reads as new);
 * - Solana: nothing is read, so its signals are unknown;
 * - with a vault: its mandates and spends, for the known payees and past payments.
 */
export async function readPayeeSignals(
  input: ReadPayeeSignalsInput,
  opts: ReadPayeeSignalsOptions = {},
): Promise<PayeeSignals> {
  const { network, payee, vault } = input;
  const why: Partial<Record<PayeeSignalName, string>> = {};
  const signals: PayeeSignals = {
    network,
    payee: { chain: payee.chain, address: payee.address },
    read_at: (opts.now?.() ?? new Date()).toISOString(),
    exists: null,
    contract: null,
    new_7d: null,
    code_changed_7d: null,
    past_block: null,
    known_payees: null,
    why_unknown: why,
  };
  const unknown = (name: PayeeSignalName, reason: string) => {
    why[name] = reason;
    return "unknown" as const;
  };
  /** Every signal this payee has, unknown for one reason: nothing could be read. */
  const unreadable = (reason: string): PayeeSignals => {
    if (payee.chain === "near") {
      signals.exists = unknown("exists", reason);
      signals.code_changed_7d = unknown("code_changed_7d", reason);
    }
    signals.contract = unknown("contract", reason);
    signals.new_7d = unknown("new_7d", reason);
    if (vault !== undefined) signals.known_payees = unknown("known_payees", reason);
    return signals;
  };
  const problem = payeeRefProblem(payee);
  if (problem !== null) return unreadable(problem);

  const timeoutMs = opts.timeoutMs ?? PAYEE_SIGNALS_TIMEOUT_MS;
  const deadline = Date.now() + (opts.budgetMs ?? PAYEE_SIGNALS_BUDGET_MS);
  // Two tries per endpoint (a public node answers HTTP 429 now and then), all inside one budget: a check that
  // waits on a slow node says "unknown" instead.
  const client = (urls: readonly string[]) =>
    new RpcClient({
      urls,
      timeoutMs,
      maxRounds: 2,
      baseDelayMs: 250,
      maxDelayMs: 1000,
      remainingMs: () => deadline - Date.now(),
      fetch: opts.fetch,
    });
  let rpc: RpcClient;
  let archival: RpcClient;
  try {
    rpc = client(opts.rpcUrls ?? NETWORKS[network].rpcUrls);
    archival = client(opts.archivalRpcUrls ?? PAYEE_ARCHIVAL_RPC_URLS[network]);
  } catch (error) {
    return unreadable(messageOf(error)); // an empty URL list: a setting, not a read, but still not a value
  }

  const history =
    vault === undefined ? Promise.resolve(null) : attempt(() => readKnownPayees(rpc, vault));

  if (payee.chain === "near") {
    const [now, past] = await Promise.all([
      attempt(() => readAccount(rpc, payee.address)),
      attempt(async () => {
        const height = await heightWeekAgo(rpc);
        const read = await atOrBelow(height, (h) => readAccount(archival, payee.address, h));
        return { block: read.height, account: read.value };
      }),
    ]);
    if (!now.ok) {
      signals.exists = unknown("exists", now.why);
      signals.contract = unknown("contract", now.why);
    } else {
      signals.exists = now.value.kind === "found";
      signals.contract =
        now.value.kind === "found" ? codeOf(now.value.account) !== NO_CODE_HASH : null;
    }
    // An account that is not there now has no age or code to compare: not_found already speaks for it.
    if (!(now.ok && now.value.kind === "missing")) {
      if (!past.ok) {
        signals.new_7d = unknown("new_7d", past.why);
        signals.code_changed_7d = unknown("code_changed_7d", past.why);
      } else {
        signals.past_block = past.value.block;
        const then = past.value.account;
        signals.new_7d = then.kind === "missing";
        if (then.kind === "found") {
          signals.code_changed_7d =
            now.ok && now.value.kind === "found"
              ? codeOf(then.account) !== codeOf(now.value.account)
              : unknown("code_changed_7d", "the account's code now could not be read");
        }
      }
    }
  } else if (payee.chain === "base") {
    const url = opts.baseRpcUrl !== undefined ? opts.baseRpcUrl : PAYEE_BASE_RPC_URLS[network];
    if (url === null) {
      const reason = `no Base RPC is mapped for ${network}`;
      signals.contract = unknown("contract", reason);
      signals.new_7d = unknown("new_7d", reason);
    } else {
      const base = client([url]);
      const [code, nonce] = await Promise.all([
        attempt(async () => {
          const result = await base.call<unknown>("eth_getCode", [payee.address, "latest"]);
          if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(result)) {
            throw new Error("eth_getCode: malformed result");
          }
          return result !== "0x";
        }),
        attempt(async () => {
          const result = await base.call<unknown>("eth_getTransactionCount", [
            payee.address,
            "latest",
          ]);
          if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(result)) {
            throw new Error("eth_getTransactionCount: malformed result");
          }
          return BigInt(result) === 0n;
        }),
      ]);
      signals.contract = code.ok ? code.value : unknown("contract", code.why);
      signals.new_7d = nonce.ok ? nonce.value : unknown("new_7d", nonce.why);
    }
  } else {
    const reason = "Solana accounts are not read";
    signals.contract = unknown("contract", reason);
    signals.new_7d = unknown("new_7d", reason);
  }

  const read = await history;
  if (read !== null)
    signals.known_payees = read.ok ? read.value : unknown("known_payees", read.why);
  return signals;
}
