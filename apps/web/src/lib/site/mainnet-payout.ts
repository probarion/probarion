// The landing page's mainnet payout, read again from the chain: the reads, the seven checks and the shapes of the
// recorded run. Pure, with no imports, so the server component, the client component,
// scripts/record-mainnet-payout.ts and the tests all use the same code. The words live in lib/site/facts.ts
// (MAINNET_PAYOUT) and are put together in lib/site/mainnet-payout-view.ts; this file has data, parsers and the RPC.

// --- hosts ----------------------------------------------------------------------------------------

/**
 * Public mainnet RPC, no key, and never through Probarion's server. FastNEAR's archival node comes before the regular
 * one for every NEAR read: the regular node forgets transactions within days (on 2026-11-13 it answered
 * UNKNOWN_TRANSACTION for spend 1 of 2026-11-11) and drops the state of old blocks, and the two views here are pinned to
 * the spend's own block. Both hosts send `access-control-allow-origin: *`.
 */
export const NEAR_RPC_URLS: readonly string[] = [
  "https://archival-rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.fastnear.com",
];
/** Base's public RPC. It echoes the page's Origin for CORS. */
export const BASE_RPC_URLS: readonly string[] = ["https://mainnet.base.org"];

/** Each request gives up after this long. */
export const TIMEOUT_MS = 8000;
/** The waits before the second and the third try of a host, then the next host. */
export const BACKOFF_MS: readonly number[] = [500, 1500];

/** The ERC-20 `Transfer(address,address,uint256)` topic. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** `interface SpendRequest` in packages/core/src/types.ts (facts.ts SPEND_REQUEST_FIELDS; the test holds the two). */
export const SPEND_FIELDS: readonly string[] = [
  "mandate_id",
  "amount",
  "invoice_hash",
  "ref",
  "decision_hash",
];

// --- the payout, as the data has it -----------------------------------------------------------------

export interface TxRef {
  hash: string;
  /** The account that signed it: EXPERIMENTAL_tx_status needs it. */
  sender: string;
}

/** The mandate's limits, from the run's snapshot. Check 01 holds the live `create_mandate` call to them. */
export interface MandateLimits {
  id: number;
  maxPerPayment: string;
  maxTotal: string;
  maxUses: number;
  expiresAtNs: string;
}

export type TrailVerdict = "allow" | "hold" | "refuse";

/** One signed ledger entry about the payout's invoice, from the run's ledger file. */
export interface TrailEntry {
  seq: number;
  kind: "decision" | "payment";
  /** The ledger's own `at`, ISO. */
  at: string;
  verdict: TrailVerdict | null;
  decidedBy: "model+rules" | "rules-only" | null;
  /** The model whose proposal the entry carries, or null. */
  model: string | null;
  /** The proposal carries NEAR AI Cloud evidence (a signature and an attestation report). */
  attested: boolean;
  /** The proposal's action, such as `pay`, or null. */
  action: string | null;
  /** The ids of the code rules that refused. */
  refusedBy: string[];
  rulesPassed: number;
  rulesTotal: number;
  /** The proposal named the mandate's token contract as the payee's NEAR account. */
  hintIsAsset: boolean;
  /** A payment entry's spend, or null. */
  spend: { id: number; status: string; tx: string } | null;
}

/** One anchor of the ledger on chain: it covers entries 0 to count - 1. */
export interface Seal {
  seq: number;
  count: number;
  root: string;
  tx: string;
  /** The anchor's time on chain, ISO. */
  at: string;
}

export type SetupKind = "intents_topup" | "ledger_key_set" | "mandate_created";

/** A transaction of the run that set the payout up, in the run's order. */
export interface SetupStep {
  kind: SetupKind;
  tx: string;
  /** Base units, for a top-up; null otherwise. */
  amount: string | null;
  /** When the run logged it (txs.log), ISO. */
  at: string;
}

/** `probarion verify` on the run, with the ledger file: the counts of its JSON output. */
export interface VerifySummary {
  ok: boolean;
  passed: number;
  failed: number;
  unproven: number;
  skipped: number;
  entries: number;
  anchors: number;
  /** The run's `generated_at`, ISO. */
  at: string;
  /** Check e verified the TDX quote online (O1); false when it ran offline. */
  quoteOnline: boolean;
}

/**
 * One payout to Base: everything the page says about it, and what the reads compare the chain with. Built by
 * lib/site/mainnet-payout-sources.ts from docs/mainnet-proof.json, contracts/deployments/mainnet.json and the run's
 * evidence folder; `pin` and `base` are read from the chain by scripts/record-mainnet-payout.ts.
 */
export interface Payout {
  /** `spend-<id>`: stable, for keys and element ids. */
  id: string;
  /** The UTC date of the payment entry. */
  date: string;
  vault: string;
  intents: string;
  /** The mandate's chain, `base`. */
  chain: string;
  /** The NEP-141 token inside intents.near that the vault burns, Base USDC on NEAR. */
  asset: string;
  /** The ERC-20 on Base that the asset is released as, lower case. */
  baseToken: string;
  /** The Base address the mandate pays, as the owner signed it. */
  payee: string;
  mandate: MandateLimits;
  agentKey: string;
  spendId: number;
  invoiceHash: string;
  /** Base units burned on NEAR. */
  amount: string;
  /** Base units the POA bridge released on Base. */
  received: string;
  /** Base units the POA bridge kept. */
  fee: string;
  /** The anchor right after the spend, which check 06 reads. */
  anchor: { seq: number; count: number; root: string };
  tx: { mandate: TxRef; spend: TxRef; anchor: TxRef; base: string };
  setup: SetupStep[];
  trail: TrailEntry[];
  seals: Seal[];
  verify: VerifySummary;
  /** The evidence folder, from the repository root. */
  source: string;
  /** The NEAR block of the spend (its transaction outcome): the two views are read at this block. */
  pin: { hash: string; height: number; at: string };
  /** The Base block of the release. */
  base: { block: number; at: string };
}

/** What the data files give, before the recorder reads the two blocks. */
export type PayoutDraft = Omit<Payout, "pin" | "base">;

// --- reads ----------------------------------------------------------------------------------------

export type ReadName = "mandate" | "spend" | "anchor" | "base" | "config" | "key";

/** The six reads of one payout: four transactions and two views. The page's counts come from this list. */
export const READS: readonly { name: ReadName; kind: "tx" | "view"; chain: "near" | "base" }[] = [
  { name: "mandate", kind: "tx", chain: "near" },
  { name: "spend", kind: "tx", chain: "near" },
  { name: "anchor", kind: "tx", chain: "near" },
  { name: "base", kind: "tx", chain: "base" },
  { name: "config", kind: "view", chain: "near" },
  { name: "key", kind: "view", chain: "near" },
];
export const READ_NAMES: readonly ReadName[] = READS.map((r) => r.name);

export type FailureKind = "timeout" | "network" | "http" | "rpc" | "body" | "none";

/** Why one host gave no usable answer: the last try's reason. `detail` is a status, a cause name or seconds. */
export interface HostFailure {
  host: string;
  kind: FailureKind;
  detail: string;
}

export type ReadResult =
  | { ok: true; value: unknown; host: string }
  | { ok: false; failures: HostFailure[] };

export type Reads = Partial<Record<ReadName, ReadResult>>;

/** No host gave a usable answer. */
export class ReadError extends Error {
  constructor(readonly failures: HostFailure[]) {
    super(failures.map((f) => `${f.host}: ${f.kind} ${f.detail}`.trim()).join("; ") || "no host");
    this.name = "ReadError";
  }
}

export interface RpcOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const hostOf = (url: string) => new URL(url).host;
/** A cause or code the page may show: a plain upper-case name or a number, never a node's free text. */
const CAUSE = /^[A-Z][A-Z_]{0,63}$/;
/** Node answers that another try of the same host can change. Any other JSON-RPC cause moves to the next host. */
const RETRY_CAUSES = new Set(["TIMEOUT_ERROR", "INTERNAL_ERROR"]);

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type Attempt = { ok: true; result: unknown } | { ok: false; failure: HostFailure; retry: boolean };

async function attempt(
  url: string,
  body: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
  accept: (result: unknown) => unknown,
  signal?: AbortSignal,
): Promise<Attempt> {
  const host = hostOf(url);
  const fail = (kind: FailureKind, detail: string, retry: boolean): Attempt => ({
    ok: false,
    failure: { host, kind, detail },
    retry,
  });
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const late = () => fail("timeout", String(timeoutMs / 1000), true);
  try {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctl.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return timedOut ? late() : fail("network", "", true);
    }
    if (!res.ok) {
      const s = res.status;
      return fail("http", String(s), s === 408 || s === 425 || s === 429 || s >= 500);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (signal?.aborted) throw signal.reason;
      return timedOut ? late() : fail("body", "", true);
    }
    if (!isObj(json)) return fail("body", "", true);
    if (json.error !== undefined) {
      const e = json.error;
      const cause = isObj(e) && isObj(e.cause) ? e.cause.name : undefined;
      if (typeof cause === "string" && CAUSE.test(cause)) {
        return fail("rpc", cause, RETRY_CAUSES.has(cause));
      }
      const code = isObj(e) && Number.isSafeInteger(e.code) ? String(e.code) : "";
      return fail("rpc", code, true);
    }
    if (json.result === null || json.result === undefined) return fail("none", "", false);
    try {
      return { ok: true, result: accept(json.result) };
    } catch {
      return fail("body", "", false);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * One JSON-RPC call. Each host gets up to 1 + backoffMs.length tries, each with its own timeout, waiting backoffMs[i]
 * between them, while the failure is one a retry can change (no answer, a timeout, HTTP 408, 425, 429 or 5xx, a body it
 * cannot read, a node timeout); then the next host. `accept` turns the result into the value, and throws when it cannot
 * read it, which moves to the next host. The caller's abort stops at once with its reason.
 */
export async function rpc(
  urls: readonly string[],
  method: string,
  params: unknown,
  opts: RpcOptions = {},
  accept: (result: unknown) => unknown = (r) => r,
): Promise<{ value: unknown; host: string }> {
  const {
    fetch: fetchFn = globalThis.fetch,
    signal,
    timeoutMs = TIMEOUT_MS,
    backoffMs = BACKOFF_MS,
    sleep = wait,
  } = opts;
  const body = JSON.stringify({ jsonrpc: "2.0", id: "probarion-site", method, params });
  const failures: HostFailure[] = [];
  for (const url of urls) {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw signal.reason;
      const a = await attempt(url, body, fetchFn, timeoutMs, accept, signal);
      if (a.ok) return { value: a.result, host: hostOf(url) };
      const delay = backoffMs[i];
      if (!a.retry || delay === undefined) {
        failures.push(a.failure);
        break;
      }
      await sleep(delay, signal);
    }
  }
  throw new ReadError(failures);
}

/** A view answer at its block: `value` is the decoded JSON of a call, or the node's `error` for a missing key. */
export interface ViewRead {
  block_hash: string;
  block_height: number;
  value?: unknown;
  error?: string;
}

/** A `query` result as the page keeps it. A view that answered an error is still an answer: the check says why. */
function acceptView(decode: boolean) {
  return (r: unknown): ViewRead => {
    if (!isObj(r) || typeof r.block_hash !== "string" || !Number.isSafeInteger(r.block_height)) {
      throw new Error("view");
    }
    const at = { block_hash: r.block_hash, block_height: r.block_height as number };
    if (typeof r.error === "string") return { ...at, error: r.error.slice(0, 200) };
    if (!decode) return { ...r, ...at };
    if (
      !Array.isArray(r.result) ||
      !r.result.every((b) => Number.isInteger(b) && b >= 0 && b < 256)
    ) {
      throw new Error("view");
    }
    return { ...at, value: JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) };
  };
}

function acceptTx(r: unknown): unknown {
  if (!isObj(r) || !isObj(r.transaction) || !Array.isArray(r.receipts_outcome))
    throw new Error("tx");
  return r;
}

/**
 * The six reads of one payout, started together. Each resolves to a ReadResult and never rejects, except with the
 * caller's abort. Transactions come from EXPERIMENTAL_tx_status (receipts and logs), the views are pinned to the
 * spend's block (`block_id`, never `finality`), and Base answers `eth_getTransactionReceipt`.
 */
export function startReads(
  p: Payout,
  opts: RpcOptions = {},
): Record<ReadName, Promise<ReadResult>> {
  const settle = (x: Promise<{ value: unknown; host: string }>): Promise<ReadResult> =>
    x.then(
      ({ value, host }) => ({ ok: true, value, host }),
      (e: unknown) => {
        if (opts.signal?.aborted) throw opts.signal.reason;
        return { ok: false, failures: e instanceof ReadError ? e.failures : [] };
      },
    );
  const tx = (t: TxRef) =>
    settle(
      rpc(
        NEAR_RPC_URLS,
        "EXPERIMENTAL_tx_status",
        { tx_hash: t.hash, sender_account_id: t.sender, wait_until: "NONE" },
        opts,
        acceptTx,
      ),
    );
  const view = (params: Record<string, unknown>, decode: boolean) =>
    settle(
      rpc(
        NEAR_RPC_URLS,
        "query",
        { ...params, block_id: p.pin.hash, account_id: p.vault },
        opts,
        acceptView(decode),
      ),
    );
  return {
    mandate: tx(p.tx.mandate),
    spend: tx(p.tx.spend),
    anchor: tx(p.tx.anchor),
    base: settle(rpc(BASE_RPC_URLS, "eth_getTransactionReceipt", [p.tx.base], opts)),
    config: view(
      { request_type: "call_function", method_name: "get_config", args_base64: "e30=" },
      true,
    ),
    key: view({ request_type: "view_access_key", public_key: p.agentKey }, false),
  };
}

// --- reading the answers --------------------------------------------------------------------------

/** The answer does not say what the page says: `code` names the sentence in MAINNET_PAYOUT.problems. */
export class Mismatch extends Error {
  readonly vars: Record<string, string>;
  constructor(
    readonly code: ProblemCode,
    vars: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "Mismatch";
    // A value read from the chain is shown in the sentence: keep it short.
    this.vars = Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, String(v).slice(0, 120)]),
    );
  }
}

/** The answer is not shaped like the RPC's: no sentence names a field, the row says it could not be checked. */
class Shape extends Error {}

const obj = (v: unknown): Record<string, unknown> => {
  if (!isObj(v)) throw new Shape();
  return v;
};
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Shape();
  return v;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new Shape();
  return v;
};
function need(
  cond: unknown,
  code: ProblemCode,
  vars?: Record<string, string | number>,
): asserts cond {
  if (!cond) throw new Mismatch(code, vars);
}

function b64text(s: string): string {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
const b64json = (s: string): unknown => JSON.parse(b64text(s));

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** The transaction's own call: its one action, a FunctionCall. */
function txCall(tx: unknown): Call {
  const actions = list(obj(obj(tx).transaction).actions);
  const fc = isObj(actions[0]) ? actions[0].FunctionCall : undefined;
  if (actions.length !== 1 || !isObj(fc)) throw new Shape();
  return { method: str(fc.method_name), args: obj(b64json(str(fc.args))) };
}

interface ReceiptCall {
  from: string;
  to: string;
  method: string;
  args: Record<string, unknown> | null;
}

/** Every FunctionCall in the transaction's receipts, with who called whom. */
function receiptCalls(tx: unknown): ReceiptCall[] {
  const out: ReceiptCall[] = [];
  for (const r of list(obj(tx).receipts ?? [])) {
    const a = isObj(r) && isObj(r.receipt) ? r.receipt.Action : undefined;
    if (!isObj(r) || !isObj(a) || !Array.isArray(a.actions)) continue;
    for (const x of a.actions) {
      const fc = isObj(x) ? x.FunctionCall : undefined;
      if (!isObj(fc) || typeof fc.method_name !== "string") continue;
      let args: Record<string, unknown> | null = null;
      try {
        const v = typeof fc.args === "string" ? b64json(fc.args) : null;
        args = isObj(v) ? v : null;
      } catch {
        args = null;
      }
      out.push({
        from: str(r.predecessor_id),
        to: str(r.receiver_id),
        method: fc.method_name,
        args,
      });
    }
  }
  return out;
}

interface NearEvent {
  standard: unknown;
  event: unknown;
  data: unknown;
  executor: string;
}

/** The NEP-297 events (`EVENT_JSON:` logs) of every receipt, with the account that logged each one. */
function events(tx: unknown): NearEvent[] {
  const out: NearEvent[] = [];
  for (const r of list(obj(tx).receipts_outcome)) {
    const o = isObj(r) ? r.outcome : undefined;
    if (!isObj(o) || !Array.isArray(o.logs)) continue;
    for (const l of o.logs) {
      if (typeof l !== "string" || !l.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(l.slice("EVENT_JSON:".length)) as unknown;
        if (isObj(e))
          out.push({
            standard: e.standard,
            event: e.event,
            data: e.data,
            executor: str(o.executor_id),
          });
      } catch {
        // a log that looks like an event and is not one
      }
    }
  }
  return out;
}

/** The transaction's final value, decoded: a mismatch when it did not succeed. */
function successJson(tx: unknown, read: ReadName): unknown {
  const status = obj(tx).status;
  const v = isObj(status) ? status.SuccessValue : undefined;
  need(typeof v === "string", "tx.failed", { read });
  return v === "" ? null : b64json(v);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** A value that names an account or address: an EVM address, or a named NEAR account. */
const looksLikeAddress = (v: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(v) || /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet)$/.test(v);

// --- formatting -----------------------------------------------------------------------------------

const UNIT = 1_000_000n;

/** Base units of USDC (6 decimals) as text with at least two decimals: 1000000 is "1.00", 997600 is "0.9976". */
export function usdc(units: string | bigint): string {
  let n = BigInt(units);
  const neg = n < 0n;
  if (neg) n = -n;
  let frac = (n % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  while (frac.length < 2) frac += "0";
  return `${neg ? "-" : ""}${n / UNIT}.${frac}`;
}

/** A transaction hash as the site labels it: 8 characters, an ellipsis, 4 (a 0x hash keeps its 0x on top). */
export function shortHash(h: string): string {
  const head = h.startsWith("0x") ? 10 : 8;
  return h.length > head + 6 ? `${h.slice(0, head)}…${h.slice(-4)}` : h;
}
/** An EVM address: 0x and 4 characters, an ellipsis, 5. */
export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a;
}
/** An ed25519 key with its prefix, the base58 part shortened like a hash. */
export function shortKey(k: string): string {
  return `ed25519:${shortHash(k.replace(/^ed25519:/, ""))}`;
}
/** A hex root or hash of 64 characters: 8, an ellipsis, 4. */
export const shortHex = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);

/** Nanoseconds since 1970 as an ISO time. */
export const nsToIso = (ns: string | bigint) =>
  new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
/** The UTC date of an ISO time. */
export const utcDate = (iso: string) => iso.slice(0, 10);
/** The UTC hour and minute of an ISO time: the page shows times to the minute. */
export const utcMinute = (iso: string) => iso.slice(11, 16);

/**
 * `{name}` placeholders in a sentence from facts.ts, and `{name|one|many}` for a count with its noun. An unknown name
 * stays, so a missing value shows in review and in the tests.
 */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(
    /\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g,
    (all, name: string, one?: string, many?: string) => {
      if (!Object.hasOwn(vars, name)) return all;
      const v = vars[name];
      if (one === undefined || many === undefined) return String(v);
      return `${v} ${Number(v) === 1 ? one : many}`;
    },
  );
}

// --- the checks -----------------------------------------------------------------------------------

export type PayoutCheckId = "owner" | "key" | "noaddr" | "memo" | "burn" | "anchor" | "base";

/** Every sentence a check can fail with. MAINNET_PAYOUT.problems has one per code; the test holds the two. */
export const PROBLEM_CODES = [
  "shape",
  "tx.failed",
  "view.pin",
  "view.error",
  "owner.method",
  "owner.receiver",
  "owner.signer",
  "owner.id",
  "owner.payee",
  "owner.limits",
  "owner.agent",
  "key.signer",
  "key.block",
  "key.full",
  "key.receiver",
  "key.methods",
  "noaddr.route",
  "noaddr.method",
  "noaddr.args",
  "noaddr.fields",
  "noaddr.address",
  "noaddr.request",
  "memo.none",
  "memo.memo",
  "memo.token",
  "memo.amount",
  "burn.status",
  "burn.none",
  "burn.amount",
  "burn.memo",
  "burn.mt",
  "burn.event",
  "anchor.route",
  "anchor.key",
  "anchor.method",
  "anchor.event",
  "base.status",
  "base.hash",
  "base.block",
  "base.transfer",
  "base.amount",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface Problem {
  code: ProblemCode;
  vars: Record<string, string>;
}

/** What a check found: the values its rows show, a mismatch, or the reads that did not come back. */
export type CheckOutcome =
  | { state: "pass"; values: Record<string, string> }
  | { state: "fail"; problem: Problem }
  | { state: "unread"; missing: { read: ReadName; failures: HostFailure[] }[] };

export interface PayoutCheck {
  id: PayoutCheckId;
  needs: readonly ReadName[];
  run: (values: Partial<Record<ReadName, unknown>>, p: Payout) => Record<string, string>;
}

/** A view read at the spend's block, or a mismatch that names the block it was read at. */
function pinned(read: unknown, name: "config" | "key", p: Payout): ViewRead {
  const v = obj(read) as unknown as ViewRead;
  need(v.block_hash === p.pin.hash, "view.pin", {
    read: name,
    got: str(v.block_hash),
    want: p.pin.hash,
  });
  return v;
}

interface MandateFacts {
  signer: string;
  receiver: string;
  input: Record<string, unknown>;
  payee: Record<string, unknown>;
  id: unknown;
}

function mandateFacts(m: unknown): MandateFacts {
  const c = txCall(m);
  need(c.method === "create_mandate", "owner.method", { method: c.method });
  const t = obj(obj(m).transaction);
  const input = obj(c.args.input);
  return {
    signer: str(t.signer_id),
    receiver: str(t.receiver_id),
    input,
    payee: obj(input.payee),
    id: successJson(m, "mandate"),
  };
}

function config(read: unknown, p: Payout): Record<string, unknown> {
  const v = pinned(read, "config", p);
  need(v.error === undefined, "view.error", { read: "config" });
  return obj(v.value);
}

function spendRequest(spend: unknown): Record<string, unknown> {
  return obj(txCall(spend).args.request);
}

export const CHECKS: readonly PayoutCheck[] = [
  {
    id: "owner",
    needs: ["config", "mandate"],
    run: (r, p) => {
      const owner = str(config(r.config, p).owner);
      const mf = mandateFacts(r.mandate);
      need(mf.signer === owner, "owner.signer", { signer: mf.signer, owner });
      need(mf.receiver === p.vault, "owner.receiver", { receiver: mf.receiver });
      need(mf.id === p.mandate.id, "owner.id", { got: JSON.stringify(mf.id) });
      const { type, chain, address, asset } = mf.payee;
      need(
        type === "intents" && chain === p.chain && address === p.payee && asset === p.asset,
        "owner.payee",
        { got: `${String(chain)}:${String(address)}` },
      );
      const i = mf.input;
      need(
        i.max_per_payment === p.mandate.maxPerPayment &&
          i.max_total === p.mandate.maxTotal &&
          i.max_uses === p.mandate.maxUses &&
          i.expires_at_ns === p.mandate.expiresAtNs,
        "owner.limits",
        { got: `${String(i.max_per_payment)}, ${String(i.max_uses)}, ${String(i.expires_at_ns)}` },
      );
      need(i.agent_pk === p.agentKey, "owner.agent", { got: String(i.agent_pk) });
      return {
        signer: mf.signer,
        payee: p.payee,
        max: usdc(p.mandate.maxPerPayment),
        uses: String(p.mandate.maxUses),
        until: utcDate(nsToIso(p.mandate.expiresAtNs)),
        mandateId: String(p.mandate.id),
      };
    },
  },
  {
    id: "key",
    needs: ["key", "spend"],
    run: (r, p) => {
      const t = obj(obj(r.spend).transaction);
      const pk = str(t.public_key);
      need(pk === p.agentKey, "key.signer", { spendId: p.spendId, got: pk });
      const block = str(obj(obj(r.spend).transaction_outcome).block_hash);
      need(block === p.pin.hash, "key.block", { spendId: p.spendId, got: block, want: p.pin.hash });
      const k = pinned(r.key, "key", p);
      need(k.error === undefined, "view.error", { read: "key" });
      const perm = (k as unknown as Record<string, unknown>).permission;
      const fc = isObj(perm) ? perm.FunctionCall : undefined;
      need(isObj(fc), "key.full", { spendId: p.spendId });
      const receiver = str(fc.receiver_id);
      need(receiver === p.vault, "key.receiver", { got: receiver });
      const methods = list(fc.method_names).map(str);
      need(sameSet(methods, ["spend"]), "key.methods", { got: methods.join(", ") });
      return {
        key: shortKey(pk),
        spendId: String(p.spendId),
        methods: methods.join(", "),
        receiver,
        height: String(k.block_height),
      };
    },
  },
  {
    id: "noaddr",
    needs: ["spend"],
    run: (r, p) => {
      const t = obj(obj(r.spend).transaction);
      const signer = str(t.signer_id);
      const receiver = str(t.receiver_id);
      need(signer === p.vault && receiver === p.vault, "noaddr.route", { signer, receiver });
      const c = txCall(r.spend);
      need(c.method === "spend", "noaddr.method", { method: c.method });
      const argKeys = Object.keys(c.args);
      need(sameSet(argKeys, ["request"]), "noaddr.args", { got: argKeys.join(", ") });
      const req = obj(c.args.request);
      const keys = Object.keys(req);
      need(sameSet(keys, SPEND_FIELDS), "noaddr.fields", { got: keys.join(", ") });
      for (const k of keys) {
        need(!looksLikeAddress(String(req[k])), "noaddr.address", { field: k });
      }
      need(
        req.mandate_id === p.mandate.id &&
          req.amount === p.amount &&
          req.invoice_hash === p.invoiceHash,
        "noaddr.request",
        { mandate: String(req.mandate_id), amount: String(req.amount) },
      );
      return {
        mandate_id: String(req.mandate_id),
        amount: String(req.amount),
        invoice_hash: shortHex(String(req.invoice_hash)),
        ref: String(req.ref),
        decision_hash: shortHex(String(req.decision_hash)),
        fields: String(keys.length),
      };
    },
  },
  {
    id: "memo",
    needs: ["spend", "mandate"],
    run: (r, p) => {
      const mf = mandateFacts(r.mandate);
      const address = str(mf.payee.address);
      const req = spendRequest(r.spend);
      const w = receiptCalls(r.spend).find(
        (x) => x.from === p.vault && x.to === p.intents && x.method === "ft_withdraw",
      );
      need(w !== undefined && w.args !== null, "memo.none", { intents: p.intents });
      const a = w.args;
      need(a.memo === `WITHDRAW_TO:${address}`, "memo.memo", { got: String(a.memo) });
      need(a.token === mf.payee.asset && a.receiver_id === mf.payee.asset, "memo.token", {
        got: String(a.token),
      });
      need(a.amount === String(req.amount), "memo.amount", { got: String(a.amount) });
      return { from: p.vault, to: p.intents, memo: String(a.memo) };
    },
  },
  {
    id: "burn",
    needs: ["spend"],
    run: (r, p) => {
      const out = successJson(r.spend, "spend");
      need(isObj(out) && out.status === "burned" && out.spend_id === p.spendId, "burn.status", {
        got: JSON.stringify(out),
      });
      const ev = events(r.spend);
      const burn = ev.find((e) => e.event === "ft_burn" && e.executor === p.asset);
      const b = burn && Array.isArray(burn.data) && isObj(burn.data[0]) ? burn.data[0] : null;
      need(b !== null, "burn.none", { asset: shortAddr(p.asset) });
      const owner = str(b.owner_id);
      const amount = str(b.amount);
      need(owner === p.intents && amount === p.amount, "burn.amount", { amount, owner });
      need(b.memo === `WITHDRAW_TO:${p.payee}`, "burn.memo", { got: String(b.memo) });
      const mt = ev.find(
        (e) =>
          e.event === "mt_burn" &&
          e.executor === p.intents &&
          Array.isArray(e.data) &&
          e.data.some(
            (d) =>
              isObj(d) &&
              d.owner_id === p.vault &&
              Array.isArray(d.amounts) &&
              d.amounts.length === 1 &&
              d.amounts[0] === p.amount,
          ),
      );
      need(mt, "burn.mt", { amount: p.amount, intents: p.intents });
      const sb = ev.find(
        (e) =>
          e.standard === "probarion" &&
          e.event === "spend_burned" &&
          e.executor === p.vault &&
          isObj(e.data) &&
          e.data.spend_id === p.spendId,
      );
      need(sb, "burn.event", { spendId: p.spendId });
      return {
        raw: amount,
        usdc: usdc(amount),
        owner,
        spendId: String(p.spendId),
        status: String(out.status),
      };
    },
  },
  {
    id: "anchor",
    needs: ["anchor", "config"],
    run: (r, p) => {
      const t = obj(obj(r.anchor).transaction);
      const signer = str(t.signer_id);
      const receiver = str(t.receiver_id);
      need(signer === p.vault && receiver === p.vault, "anchor.route", { signer, receiver });
      const ledgerKey = str(config(r.config, p).ledger_key);
      const pk = str(t.public_key);
      need(pk === ledgerKey, "anchor.key", { got: shortKey(pk), want: shortKey(ledgerKey) });
      const c = txCall(r.anchor);
      need(c.method === "anchor", "anchor.method", { method: c.method });
      successJson(r.anchor, "anchor");
      const a = events(r.anchor).find(
        (e) =>
          e.standard === "probarion" && e.event === "ledger_anchored" && e.executor === p.vault,
      );
      const d = a && isObj(a.data) ? a.data : null;
      need(
        d && d.seq === p.anchor.seq && d.count === p.anchor.count && d.root === p.anchor.root,
        "anchor.event",
        { seq: String(d?.seq ?? "none"), count: String(d?.count ?? "none") },
      );
      return {
        seq: String(p.anchor.seq),
        count: String(p.anchor.count),
        root: shortHex(p.anchor.root),
      };
    },
  },
  {
    id: "base",
    needs: ["base", "mandate", "spend"],
    run: (r, p) => {
      const mf = mandateFacts(r.mandate);
      const address = str(mf.payee.address);
      const rc = obj(r.base);
      need(rc.status === "0x1", "base.status");
      need(String(rc.transactionHash).toLowerCase() === p.tx.base.toLowerCase(), "base.hash", {
        got: shortHash(String(rc.transactionHash)),
      });
      const block = Number.parseInt(str(rc.blockNumber), 16);
      need(block === p.base.block, "base.block", { got: String(block) });
      const to = `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
      const log = list(rc.logs).find(
        (l) =>
          isObj(l) &&
          String(l.address).toLowerCase() === p.baseToken &&
          Array.isArray(l.topics) &&
          l.topics[0] === TRANSFER_TOPIC &&
          String(l.topics[2]).toLowerCase() === to,
      );
      need(isObj(log), "base.transfer");
      const got = BigInt(str(log.data)).toString();
      need(got === p.received, "base.amount", { got });
      const sent = str(spendRequest(r.spend).amount);
      return {
        block: String(block),
        raw: got,
        usdc: usdc(got),
        token: shortAddr(p.baseToken),
        to: shortAddr(address),
        fee: usdc(BigInt(sent) - BigInt(got)),
      };
    },
  },
];

/** The check numbers the page shows, 01 to 07, in CHECKS order. */
export const checkNumber = (id: PayoutCheckId) =>
  String(CHECKS.findIndex((c) => c.id === id) + 1).padStart(2, "0");

/** Runs one check on the reads it needs. A read that is missing or failed makes it unread, never a fail. */
export function evaluate(check: PayoutCheck, reads: Reads, p: Payout): CheckOutcome {
  const missing = check.needs.flatMap((read) => {
    const r = reads[read];
    if (r === undefined) return [{ read, failures: [] }];
    return r.ok ? [] : [{ read, failures: r.failures }];
  });
  if (missing.length > 0) return { state: "unread", missing };
  const values: Partial<Record<ReadName, unknown>> = {};
  for (const n of check.needs) {
    const r = reads[n];
    if (r?.ok) values[n] = r.value;
  }
  try {
    return { state: "pass", values: check.run(values, p) };
  } catch (e) {
    if (e instanceof Mismatch) return { state: "fail", problem: { code: e.code, vars: e.vars } };
    return { state: "fail", problem: { code: "shape", vars: {} } };
  }
}

export interface Tally {
  total: number;
  pass: number;
  fail: number;
  unread: number;
  /** fail when any check failed, else unread when any could not be read, else pass. */
  state: "pass" | "fail" | "unread";
}

export function tally(outcomes: readonly CheckOutcome[]): Tally {
  const n = (s: CheckOutcome["state"]) => outcomes.filter((o) => o.state === s).length;
  const t = { total: outcomes.length, pass: n("pass"), fail: n("fail"), unread: n("unread") };
  return { ...t, state: t.fail > 0 ? "fail" : t.unread > 0 ? "unread" : "pass" };
}

/** Every check on a set of reads, in CHECKS order. */
export const evaluateAll = (reads: Reads, p: Payout): CheckOutcome[] =>
  CHECKS.map((c) => evaluate(c, reads, p));

export interface RunOptions extends RpcOptions {
  /** Once per read, as each settles. Not called after the caller aborts. */
  onRead?: (name: ReadName, read: ReadResult) => void;
  /** Once per check, as soon as every read it needs has settled. Not called after the caller aborts. */
  onCheck?: (id: PayoutCheckId, outcome: CheckOutcome) => void;
  now?: () => number;
}

export interface RunResult {
  reads: Record<ReadName, ReadResult>;
  /** In CHECKS order. */
  outcomes: CheckOutcome[];
  tally: Tally;
  /** The hosts that answered, in the order they did. */
  hosts: string[];
  /** When the run started, ms since 1970, and how long it took. */
  startedAt: number;
  ms: number;
}

/** Reads the chain for one payout and runs the seven checks, reporting each read and check as it lands. */
export async function runPayout(p: Payout, opts: RunOptions = {}): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const pending = startReads(p, opts);
  const reads: Reads = {};
  const done = new Map<PayoutCheckId, CheckOutcome>();
  const hosts: string[] = [];
  const live = () => !opts.signal?.aborted;
  await Promise.all(
    READ_NAMES.map(async (name) => {
      const r = await pending[name];
      reads[name] = r;
      if (r.ok && !hosts.includes(r.host)) hosts.push(r.host);
      if (live()) opts.onRead?.(name, r);
      for (const c of CHECKS) {
        if (done.has(c.id) || !c.needs.every((n) => reads[n] !== undefined)) continue;
        const o = evaluate(c, reads, p);
        done.set(c.id, o);
        if (live()) opts.onCheck?.(c.id, o);
      }
    }),
  );
  if (opts.signal?.aborted) throw opts.signal.reason;
  const outcomes = CHECKS.map((c) => done.get(c.id) ?? evaluate(c, reads, p));
  return {
    reads: reads as Record<ReadName, ReadResult>,
    outcomes,
    tally: tally(outcomes),
    hosts,
    startedAt,
    ms: now() - startedAt,
  };
}

// --- the recorded run -----------------------------------------------------------------------------

/** One payout as lib/site/mainnet-payout-recorded.json has it: the payout, and the reads trimmed to what CHECKS read. */
export interface RecordedPayout {
  payout: Payout;
  reads: Record<ReadName, unknown>;
  hosts: Record<ReadName, string>;
}

/** lib/site/mainnet-payout-recorded.json, written by scripts/record-mainnet-payout.ts. */
export interface RecordedFile {
  recordedAt: string;
  payouts: RecordedPayout[];
}

/** The recorded reads as ReadResults, for evaluate(). */
export function recordedReads(r: RecordedPayout): Reads {
  return Object.fromEntries(
    READ_NAMES.map((n) => [n, { ok: true, value: r.reads[n], host: r.hosts[n] }]),
  ) as Reads;
}

function trimTx(v: unknown): unknown {
  const t = obj(v);
  const tx = obj(t.transaction);
  const keepCall = (a: unknown) => {
    const fc = isObj(a) ? a.FunctionCall : undefined;
    return isObj(fc) ? { FunctionCall: { method_name: fc.method_name, args: fc.args } } : a;
  };
  return {
    transaction: {
      hash: tx.hash,
      signer_id: tx.signer_id,
      receiver_id: tx.receiver_id,
      public_key: tx.public_key,
      actions: list(tx.actions).map(keepCall),
    },
    transaction_outcome: {
      id: obj(t.transaction_outcome).id,
      block_hash: obj(t.transaction_outcome).block_hash,
    },
    status: t.status,
    receipts: list(t.receipts ?? [])
      .filter((r) => {
        const a = isObj(r) && isObj(r.receipt) ? r.receipt.Action : undefined;
        return (
          isObj(a) &&
          Array.isArray(a.actions) &&
          a.actions.some((x) => isObj(x) && isObj(x.FunctionCall))
        );
      })
      .map((r) => {
        const x = obj(r);
        const a = obj(obj(x.receipt).Action);
        return {
          receipt_id: x.receipt_id,
          predecessor_id: x.predecessor_id,
          receiver_id: x.receiver_id,
          receipt: {
            Action: {
              actions: list(a.actions)
                .filter((y) => isObj(y) && isObj(y.FunctionCall))
                .map(keepCall),
            },
          },
        };
      }),
    receipts_outcome: list(t.receipts_outcome)
      .filter(
        (r) =>
          isObj(r) &&
          isObj(r.outcome) &&
          Array.isArray(r.outcome.logs) &&
          r.outcome.logs.length > 0,
      )
      .map((r) => {
        const x = obj(r);
        const o = obj(x.outcome);
        return {
          id: x.id,
          block_hash: x.block_hash,
          outcome: { executor_id: o.executor_id, logs: o.logs },
        };
      }),
  };
}

/**
 * A read as the recorded file keeps it: the fields CHECKS read, in the shape the RPC gave them, without proofs, gas or
 * refunds, so the file stays small and the checks run on it unchanged.
 */
export function trimRead(name: ReadName, value: unknown): unknown {
  if (name === "config" || name === "key") return value;
  if (name === "base") {
    const rc = obj(value);
    return {
      status: rc.status,
      transactionHash: rc.transactionHash,
      blockHash: rc.blockHash,
      blockNumber: rc.blockNumber,
      logs: list(rc.logs).map((l) => {
        const x = obj(l);
        return {
          address: x.address,
          topics: x.topics,
          data: x.data,
          blockTimestamp: x.blockTimestamp,
        };
      }),
    };
  }
  return trimTx(value);
}
