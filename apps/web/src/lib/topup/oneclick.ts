import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { formatUsdc } from "@/lib/near/units";
import { isNearAccountId } from "@/lib/near/validate";

export const ONECLICK_BASE = "https://1click.chaindefuser.com";

/** A 1Click call that failed or answered something we will not use. The message is safe to show the owner. */
export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteError";
  }
}

export interface QuoteRequestBody {
  dry: boolean;
  swapType: "EXACT_OUTPUT";
  slippageTolerance: number; // basis points
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string; // exact output, smallest units
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "INTENTS";
  deadline: string;
  quoteWaitingTimeMs: number;
  referral: string;
}

/** Report §8 (i), mode A: the owner tops up the vault's own Base-USDC balance inside intents.near. */
export function buildQuoteRequest(
  i: { vault: string; owner: string; amountOut: string; usdc: string; baseAsset: string },
  now: Date,
): QuoteRequestBody {
  return {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: `nep141:${i.usdc}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${i.baseAsset}`,
    amount: i.amountOut,
    refundTo: i.owner,
    refundType: "ORIGIN_CHAIN",
    recipient: i.vault,
    recipientType: "INTENTS",
    deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
    referral: "probarion",
  };
}

const headers = (jwt: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${jwt}`,
});

/** What a failed call may tell the owner of 1Click's own reason: one short printable line. */
const reasonOf = (json: { message?: unknown } | null): string => {
  if (typeof json?.message !== "string") return "no detail";
  const line = json.message
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim()
    .slice(0, 200);
  return line === "" ? "no detail" : line;
};

/** One call to 1Click. A network failure or a timeout is a QuoteError with no detail from the failure. */
async function call(fetchImpl: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(`${ONECLICK_BASE}${path}`, init);
  } catch {
    throw new QuoteError("1Click could not be reached");
  }
}

export async function fetchQuote(
  body: QuoteRequestBody,
  jwt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await call(fetchImpl, "/v0/quote", {
    method: "POST",
    headers: headers(jwt),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (!res.ok) throw new QuoteError(`1Click quote failed (${res.status}): ${reasonOf(json)}`);
  return json;
}

export interface VerifiedQuote {
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  /** Written by this server from `amountIn` (6 decimals), never copied from the text 1Click sent. */
  amountInFormatted: string;
  amountOut: string;
  /** Written by this server from `amountOut` (6 decimals). */
  amountOutFormatted: string;
  /** When the deposit address stops being active: sending after it can lose the funds (1Click's words). */
  deadline: string;
  timeEstimate: number;
  correlationId: string;
  signature: string;
  timestamp: string;
  /** The recipient and the refund address of the signed request, as checked equal to what was asked for. */
  recipient: string;
  refundTo: string;
}

/** Why a quote was refused. `mismatch:<field>` names the first bound field that differs. */
export type QuoteRejection =
  | "malformed"
  | "bad_signature"
  | `mismatch:${(typeof BOUND_FIELDS)[number]}`
  | "bad_deposit_address"
  | "amount_out_too_low"
  | "price_too_high"
  | "stale_quote"
  | "deadline_too_close";

export type QuoteCheck = { ok: true; quote: VerifiedQuote } | { ok: false; reason: QuoteRejection };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** The fields of the request that the signature covers and that we compare with what we asked for. */
export const BOUND_FIELDS = [
  "dry",
  "swapType",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
] as const;

const U128_MAX = 2n ** 128n - 1n;
const CANONICAL = /^(0|[1-9][0-9]{0,38})$/;

/** An amount in smallest units: canonical digits that fit a U128, the form the transaction builder takes. Else null. */
function units(x: unknown): bigint | null {
  if (typeof x !== "string" || !CANONICAL.test(x)) return null;
  const v = BigInt(x);
  return v <= U128_MAX ? v : null;
}

const defaultVerify = (r: unknown) =>
  verifyQuoteSignature(r as Parameters<typeof verifyQuoteSignature>[0]);

const FIVE_MINUTES = 5 * 60_000;

/**
 * 1) The signature must verify against 1Click's published key (SDK default).
 * 2) What was signed must be what we asked for.
 * Only then does the UI say "sign in your wallet".
 *
 * It fails closed and never throws: a response of any other shape, an amount that is not plain digits and a
 * verifier that throws are all refusals. The amounts it returns are the same digits the deposit
 * transaction takes, and the deadline is always a real time.
 */
export function checkQuote(
  resp: unknown,
  expected: QuoteRequestBody,
  now: Date,
  verify: (r: unknown) => boolean = defaultVerify,
): QuoteCheck {
  const fail = (reason: QuoteRejection): QuoteCheck => ({ ok: false, reason });
  try {
    if (!isObj(resp) || !isObj(resp.quote) || !isObj(resp.quoteRequest)) return fail("malformed");
    const { quote, quoteRequest } = resp;
    if (typeof resp.signature !== "string" || typeof resp.timestamp !== "string") {
      return fail("malformed");
    }
    let signed: boolean;
    try {
      signed = verify(resp) === true;
    } catch {
      signed = false;
    }
    if (!signed) return fail("bad_signature");

    for (const k of BOUND_FIELDS) {
      if (quoteRequest[k] !== expected[k]) return fail(`mismatch:${k}`);
    }

    const depositAddress = quote.depositAddress;
    if (typeof depositAddress !== "string" || !isNearAccountId(depositAddress)) {
      return fail("bad_deposit_address");
    }
    const amountIn = units(quote.amountIn);
    const amountOut = units(quote.amountOut);
    const asked = units(expected.amount);
    if (amountIn === null || amountIn === 0n || amountOut === null || asked === null) {
      return fail("malformed");
    }
    if (amountOut < asked) return fail("amount_out_too_low");
    // Stable-to-stable: more than 5% over the output means fees or slippage we refuse to show as "OK".
    if (amountIn * 100n > asked * 105n) return fail("price_too_high");

    const ts = Date.parse(resp.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now.getTime() - ts) > FIVE_MINUTES) {
      return fail("stale_quote");
    }
    // The deposit address stops being active at the deadline, and a deposit after it can be lost.
    const deadline = quote.deadline;
    const deadlineMs = typeof deadline === "string" ? Date.parse(deadline) : Number.NaN;
    if (typeof deadline !== "string" || !Number.isFinite(deadlineMs)) return fail("malformed");
    if (deadlineMs < now.getTime() + FIVE_MINUTES) return fail("deadline_too_close");

    const memo = quote.depositMemo;
    if (memo !== undefined && memo !== null && typeof memo !== "string") return fail("malformed");

    return {
      ok: true,
      quote: {
        depositAddress,
        depositMemo: typeof memo === "string" && memo !== "" ? memo : null,
        amountIn: amountIn.toString(),
        amountInFormatted: formatUsdc(amountIn.toString()),
        amountOut: amountOut.toString(),
        amountOutFormatted: formatUsdc(amountOut.toString()),
        deadline,
        timeEstimate: typeof quote.timeEstimate === "number" ? quote.timeEstimate : 0,
        correlationId: String(resp.correlationId ?? ""),
        signature: resp.signature,
        timestamp: resp.timestamp,
        recipient: expected.recipient,
        refundTo: expected.refundTo,
      },
    };
  } catch {
    // Not reached for any input checked above; it keeps a surprise from becoming a thrown error in a security check.
    return fail("malformed");
  }
}

export async function submitDeposit(
  jwt: string,
  i: { txHash: string; depositAddress: string; nearSenderAccount: string },
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await call(fetchImpl, "/v0/deposit/submit", {
    method: "POST",
    headers: headers(jwt),
    body: JSON.stringify(i),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new QuoteError(`1Click deposit/submit failed (${res.status})`);
  return res.json().catch(() => null);
}

/** 1Click's execution states are single upper-case words (KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, REFUNDED, ...). */
const STATUS_WORD = /^[A-Z_]{1,40}$/;

/** The state of a deposit and when it last changed: nothing else of 1Click's answer is passed on. */
export async function getDepositStatus(
  jwt: string,
  depositAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: string; updatedAt?: string }> {
  const res = await call(
    fetchImpl,
    `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    { headers: headers(jwt), signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new QuoteError(`1Click status failed (${res.status})`);
  const json: unknown = await res.json().catch(() => null);
  if (!isObj(json) || typeof json.status !== "string" || !STATUS_WORD.test(json.status)) {
    throw new QuoteError("1Click gave a status this console cannot read");
  }
  return typeof json.updatedAt === "string" && json.updatedAt.length <= 40
    ? { status: json.status, updatedAt: json.updatedAt }
    : { status: json.status };
}
