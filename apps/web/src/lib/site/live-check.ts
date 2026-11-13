// The landing page's live check: what the agent tries, asked of the testnet vault's `check_spend` view. Pure, with no
// imports, so the server component, the client component and scripts/record-live-check.ts all use the same code. The
// words live in lib/site/facts.ts (LIVE_CHECK); this file only has data, parsers and the RPC call.

/** The vault the page asks. contracts/deployments/testnet.json `accounts.vault_v0`; the recorded-file test holds it. */
export const LIVE_VAULT = "v0.probarion.testnet";

/**
 * Public testnet RPCs, tried in order. Not from env: NEAR_RPC_URLS_* is server-only and may carry a provider key, and
 * this list ships to the browser. A test holds each host to the env.ts rule that a testnet host has a "testnet" word.
 */
export const LIVE_RPC_URLS: readonly string[] = [
  "https://rpc.testnet.fastnear.com",
  "https://rpc.testnet.near.org",
];

/** A well-formed ed25519 key that is no key of the vault. The recorded-file test checks it is not on the vault. */
export const OTHER_PK = "ed25519:22222222222222222222222222222222222222222222";

export type ScenarioId = "normal" | "hijack" | "inflated" | "nomandate" | "otherkey";
export type KeyChoice = "agent" | "other";

export interface ScenarioInput {
  id: ScenarioId;
  mandateId: number;
  amount: string;
  key: KeyChoice;
}

/**
 * The hijacked prompt sends what the normal invoice sends: the agent can pass on the amount and nothing else, so its
 * request is the same, and only its invoice text differs. The inflated invoice is the one above the limit.
 */
export const SCENARIO_INPUTS: readonly ScenarioInput[] = [
  { id: "normal", mandateId: 1, amount: "2", key: "agent" },
  { id: "hijack", mandateId: 1, amount: "2", key: "agent" },
  { id: "inflated", mandateId: 1, amount: "50", key: "agent" },
  { id: "nomandate", mandateId: 999, amount: "1", key: "agent" },
  { id: "otherkey", mandateId: 1, amount: "1", key: "other" },
];

/** The mandates the select offers: two real ones and one that does not exist. */
export const MANDATE_IDS = [1, 2, 999] as const;

// --- amounts --------------------------------------------------------------------------------------

const DECIMALS = 6n;
const UNIT = 10n ** DECIMALS;
const MAX_UNITS = 1_000_000n * UNIT;
const USDC = /^(\d{1,7})(?:\.(\d{1,6}))?$/;

/** A decimal USDC amount as base units (6 decimals), or null when it is not one: no float ever touches it. */
export function parseUsdc(input: string): bigint | null {
  const m = USDC.exec(input.trim());
  if (m === null) return null;
  const units = BigInt(m[1] ?? "0") * UNIT + BigInt((m[2] ?? "").padEnd(6, "0"));
  return units > MAX_UNITS ? null : units;
}

export function formatUsdc(units: bigint | string): string {
  const u = BigInt(units);
  const frac = (u % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? `${u / UNIT}` : `${u / UNIT}.${frac}`;
}

// --- the request ----------------------------------------------------------------------------------

const DEMO_HASH = "0".repeat(64);

export interface CheckSpendArgs {
  request: {
    mandate_id: number;
    amount: string;
    invoice_hash: string;
    ref: string;
    decision_hash: string;
  };
  signer_pk: string;
}

/** `check_spend(request, signer_pk)`. The contract's SpendRequest has no recipient field, so neither has this. */
export function checkSpendArgs(
  mandateId: number,
  amount: bigint,
  signerPk: string,
): CheckSpendArgs {
  return {
    request: {
      mandate_id: mandateId,
      amount: amount.toString(),
      invoice_hash: DEMO_HASH,
      ref: "landing-demo",
      decision_hash: DEMO_HASH,
    },
    signer_pk: signerPk,
  };
}

// --- answers --------------------------------------------------------------------------------------

export type LiveCheckErrorKind = "transport" | "rpc" | "contract";

/** transport: no host answered. rpc: a host answered something unreadable. contract: the chain's own answer. */
export class LiveCheckError extends Error {
  constructor(
    readonly kind: LiveCheckErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LiveCheckError";
  }
}

const bad = (what: string) => new LiveCheckError("rpc", `unreadable ${what}`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isU128 = (v: unknown): v is string => typeof v === "string" && /^\d{1,39}$/.test(v);
const U64_MAX = 2n ** 64n - 1n;
/** A u64 as the contract's JSON has it: a decimal string of at most 20 digits that fits. */
const isU64 = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,20}$/.test(v) && BigInt(v) <= U64_MAX;

/** What a refusal code looks like: letters only, so it can never be an object key like `__proto__`. */
const CODE = /^[A-Za-z]{1,64}$/;

export interface Verdict {
  ok: boolean;
  code: string | null;
  wouldHold: boolean;
}

/** `check_spend`'s Verdict, exactly: three keys, a code only when refused, no `PROBARION:` prefix. */
export function parseVerdict(raw: unknown): Verdict {
  if (!isObj(raw) || Object.keys(raw).length !== 3) throw bad("verdict");
  const { ok, code, would_hold } = raw;
  if (typeof ok !== "boolean" || typeof would_hold !== "boolean") throw bad("verdict");
  if (ok ? code !== null : typeof code !== "string" || code === "") throw bad("verdict");
  const bare = typeof code === "string" ? code.replace(/^PROBARION:/, "") : null;
  if (bare !== null && !CODE.test(bare)) throw bad("verdict code");
  return { ok, code: bare, wouldHold: would_hold };
}

export type Payee =
  | { type: "near"; account_id: string }
  | { type: "intents"; chain: string; address: string; asset: string };

export interface MandateFacts {
  id: number;
  payee: Payee;
  maxPerPayment: string;
  maxTotal: string;
  spent: string;
  reserved: string;
  maxUses: number;
  uses: number;
  expiresAtNs: string;
  approvalAbove: string;
  agentPk: string;
  status: string;
}

function parsePayee(p: unknown): Payee {
  if (isObj(p) && p.type === "near" && typeof p.account_id === "string") {
    return { type: "near", account_id: p.account_id };
  }
  if (
    isObj(p) &&
    p.type === "intents" &&
    typeof p.chain === "string" &&
    typeof p.address === "string" &&
    typeof p.asset === "string"
  ) {
    return { type: "intents", chain: p.chain, address: p.address, asset: p.asset };
  }
  throw bad("payee");
}

/** `get_mandate`'s MandateView (packages/core/src/types.ts), the fields the page shows. null = no such mandate. */
export function parseMandate(raw: unknown): MandateFacts | null {
  if (raw === null) return null;
  if (!isObj(raw)) throw bad("mandate");
  for (const k of ["max_per_payment", "max_total", "spent", "reserved", "approval_above"]) {
    if (!isU128(raw[k])) throw bad(`mandate.${k}`);
  }
  if (!isU64(raw.expires_at_ns)) throw bad("mandate.expires_at_ns");
  for (const k of ["id", "max_uses", "uses"]) {
    if (!Number.isSafeInteger(raw[k])) throw bad(`mandate.${k}`);
  }
  if (typeof raw.agent_pk !== "string" || typeof raw.status !== "string") throw bad("mandate");
  return {
    id: raw.id as number,
    payee: parsePayee(raw.payee),
    maxPerPayment: raw.max_per_payment as string,
    maxTotal: raw.max_total as string,
    spent: raw.spent as string,
    reserved: raw.reserved as string,
    maxUses: raw.max_uses as number,
    uses: raw.uses as number,
    expiresAtNs: raw.expires_at_ns as string,
    approvalAbove: raw.approval_above as string,
    agentPk: raw.agent_pk,
    status: raw.status,
  };
}

export function payeeText(p: Payee): string {
  return p.type === "near"
    ? p.account_id
    : `${p.address.slice(0, 6)}…${p.address.slice(-4)} on ${p.chain}`;
}

export function remaining(m: MandateFacts): bigint {
  const left = BigInt(m.maxTotal) - BigInt(m.spent) - BigInt(m.reserved);
  return left > 0n ? left : 0n;
}

export function expiryDate(m: MandateFacts): string {
  const date = new Date(Number(BigInt(m.expiresAtNs) / 1_000_000n));
  // A time the calendar cannot hold stays as the chain wrote it, rather than throwing in a render.
  return Number.isNaN(date.getTime()) ? m.expiresAtNs : date.toISOString().slice(0, 10);
}

// --- the RPC call ---------------------------------------------------------------------------------

/** JSON-RPC causes that are the chain's own answer about the target: another host would say the same. */
const CONTRACT_CAUSES = new Set([
  "UNKNOWN_ACCOUNT",
  "NO_CONTRACT_CODE",
  "CONTRACT_EXECUTION_ERROR",
]);

export interface ViewAnswer {
  value: unknown;
  blockHeight: number;
  rpcHost: string;
}

export interface ViewOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * A `call_function` view at final finality. Hosts are tried in order; a transport or unreadable answer moves on, a
 * contract answer does not. The caller's abort stops at once with the AbortError, and no other host is tried.
 */
export async function viewCall(
  urls: readonly string[],
  account: string,
  method: string,
  args: unknown,
  { fetch = globalThis.fetch, signal, timeoutMs = 6000 }: ViewOptions = {},
): Promise<ViewAnswer> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "landing",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: account,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  });
  let last = new LiveCheckError("transport", "no RPC host");
  for (const url of urls) {
    if (signal?.aborted) throw signal.reason;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => ctl.abort(new LiveCheckError("transport", "timeout")),
      timeoutMs,
    );
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: ctl.signal,
        });
      } catch {
        if (signal?.aborted) throw signal.reason;
        last = new LiveCheckError("transport", `${new URL(url).host} did not answer`);
        continue;
      }
      if (!res.ok) {
        last = new LiveCheckError("transport", `${new URL(url).host} answered HTTP ${res.status}`);
        continue;
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        if (signal?.aborted) throw signal.reason;
        last = bad("RPC body");
        continue;
      }
      if (!isObj(json)) {
        last = bad("RPC body");
        continue;
      }
      if (json.error !== undefined) {
        const cause =
          isObj(json.error) && isObj(json.error.cause) ? json.error.cause.name : undefined;
        if (typeof cause === "string" && CONTRACT_CAUSES.has(cause)) {
          throw new LiveCheckError("contract", cause);
        }
        last = bad("RPC error");
        continue;
      }
      const r = json.result;
      if (isObj(r) && typeof r.error === "string") throw new LiveCheckError("contract", r.error);
      if (
        !isObj(r) ||
        !Array.isArray(r.result) ||
        !r.result.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ||
        !Number.isSafeInteger(r.block_height)
      ) {
        last = bad("RPC result");
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result as number[])));
      } catch {
        last = bad("view result");
        continue;
      }
      return { value, blockHeight: r.block_height as number, rpcHost: new URL(url).host };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw last;
}

// --- small helpers the page uses ------------------------------------------------------------------

/** `{name}` placeholders in a sentence from facts.ts. An unknown name stays, so a missing value shows in review. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : all,
  );
}

/**
 * The scenario whose controls these are, or null. Amounts compare as base units, so "50.0" is "50". The first match
 * wins: fields typed by hand that send the hijack's request are the normal invoice, since no field holds the hijack's
 * invoice text. Its button picks the hijack itself.
 */
export function matchScenario(c: {
  mandateId: number;
  amount: string;
  key: KeyChoice;
}): ScenarioId | null {
  const units = parseUsdc(c.amount);
  if (units === null) return null;
  const hit = SCENARIO_INPUTS.find(
    (s) => s.mandateId === c.mandateId && s.key === c.key && parseUsdc(s.amount) === units,
  );
  return hit?.id ?? null;
}

/** lib/site/live-check-recorded.json, written by scripts/record-live-check.ts. */
export interface RecordedFile {
  recordedAt: string;
  blockHeight: number;
  vault: string;
  accessKeys: { public_key: string; access_key: { permission: unknown } }[];
  mandates: Record<string, unknown>;
  /** `args` is the exact `check_spend` argument object the recorder sent for the answer (spec 5.3). */
  answers: Record<ScenarioId, { args: CheckSpendArgs; value: unknown; blockHeight: number }>;
}
