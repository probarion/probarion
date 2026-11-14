/**
 * NEP-413 sign-in against our own endpoints (Task 5): fetch a challenge, have the wallet sign it,
 * post the signature. The wallet and `fetch` are passed in, so the whole flow runs in a unit test.
 * This is a message signature, not a transaction: it moves no funds and adds no keys.
 */

import {
  SIGN_IN_CLOSED,
  SIGN_IN_TIMED_OUT,
  SIGN_IN_TIMEOUT_MS,
  type SignInPhase,
} from "@/lib/ui/pending";

export interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface Nep413Wallet {
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<SignedMessage>;
}

const NONCE_BYTES = 32;
const SIGNATURE_BYTES = 64;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Standard or URL-safe base64, padded or not, to bytes; `null` when it is not base64. */
function base64ToBytes(text: string): Uint8Array | null {
  const std = text.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(std)) return null;
  const unpadded = std.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base58ToBytes(text: string): Uint8Array | null {
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === "1") leadingZeros++;
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}

/** The challenge nonce: base64 of exactly 32 bytes (NEP-413). */
export function decodeNonce(nonce: string): Uint8Array {
  const bytes = base64ToBytes(nonce);
  if (bytes === null || bytes.length !== NONCE_BYTES) {
    throw new Error("The sign-in challenge was malformed (nonce)");
  }
  return bytes;
}

/**
 * The server verifies base64 of the 64 signature bytes. Wallets differ in how they write the same
 * signature: base64 (standard or URL-safe), 128 hex characters, or `ed25519:<base58>`. Anything
 * unreadable is returned unchanged for the server to refuse.
 */
export function normalizeSignature(signature: string): string {
  const text = signature.trim();
  const fromBase64 = base64ToBytes(text);
  if (fromBase64?.length === SIGNATURE_BYTES) return bytesToBase64(fromBase64);
  if (/^[0-9a-fA-F]{128}$/.test(text)) {
    const bytes = Uint8Array.from({ length: SIGNATURE_BYTES }, (_, i) =>
      Number.parseInt(text.slice(i * 2, i * 2 + 2), 16),
    );
    return bytesToBase64(bytes);
  }
  if (text.startsWith("ed25519:")) {
    const fromBase58 = base58ToBytes(text.slice("ed25519:".length));
    if (fromBase58?.length === SIGNATURE_BYTES) return bytesToBase64(fromBase58);
  }
  return signature;
}

/** What the sign-in endpoints answer (apps/web/src/lib/auth, lib/http.ts), in words an owner can act on. */
const SIGN_IN_ERRORS: Record<string, string> = {
  bad_signature:
    "Your wallet's signature was not accepted. Choose an account whose full-access key can sign messages",
  challenge_missing_or_expired: "The sign-in challenge expired or was already used",
  verifier_unavailable: "No NEAR node could be reached to check your signature",
  wrong_chain: "This site is connected to the wrong NEAR network right now, so sign-in is paused",
  invalid_input: "The wallet's answer was not in the expected form",
  bad_origin: "This page's address is not allowed to sign in",
  rate_limited: "Too many sign-in attempts",
  // The verify route's 503 for every infrastructure failure. The wallet has signed by then, so the words do
  // not say "nothing was signed" (SIGN_IN_UNAVAILABLE below does, before the wallet is asked).
  unavailable: "Sign-in is unavailable right now, so you were not signed in. Try again later",
  payload_too_large: "The wallet's answer was too large to be a sign-in",
};

/** The server's refusal code, with the plain-language reason when we know it. */
function refusalMessage(code: string): string {
  return Object.hasOwn(SIGN_IN_ERRORS, code) ? `${SIGN_IN_ERRORS[code]} (${code})` : code;
}

/** The wallet has not been asked for anything yet when this shows, so "nothing was signed" holds. */
const SIGN_IN_UNAVAILABLE =
  "Sign-in is unavailable right now. Nothing was signed. Try again later.";

/** A request the browser stopped waiting for (`AbortSignal.timeout`), not one that failed on its own. */
function timedOut(e: unknown): boolean {
  return isRecord(e) && e.name === "TimeoutError";
}

/** Tells the caller the step, for its words only: what the callback does or throws changes nothing here. */
function tell(onPhase: ((phase: SignInPhase) => void) | undefined, phase: SignInPhase): void {
  try {
    onPhase?.(phase);
  } catch {
    // the caller's view only
  }
}

/**
 * Signs in and returns the account the server verified. Throws a message safe to show the user.
 *
 * `onPhase` hears "wallet" before the wallet is asked to sign, "verify" before the signature is posted, and "open" once
 * the server has signed the owner in. The challenge and the verify request each stop waiting after 15 s and say so; the
 * wallet's own step has no timeout.
 */
export async function signInWithWallet(
  wallet: Nep413Wallet,
  fetchImpl: typeof fetch = fetch,
  onPhase?: (phase: SignInPhase) => void,
): Promise<string> {
  let res0: Response | undefined;
  try {
    res0 = await fetchImpl("/api/auth/challenge", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(timedOut(e) ? SIGN_IN_TIMED_OUT : SIGN_IN_UNAVAILABLE);
  }
  if (!res0?.ok) throw new Error(SIGN_IN_UNAVAILABLE);
  const challenge: unknown = await res0.json().catch((e: unknown) => {
    if (timedOut(e)) throw new Error(SIGN_IN_TIMED_OUT);
    return null;
  });
  if (
    !isRecord(challenge) ||
    typeof challenge.message !== "string" ||
    challenge.message === "" ||
    typeof challenge.recipient !== "string" ||
    challenge.recipient === "" ||
    typeof challenge.nonce !== "string"
  ) {
    throw new Error("The sign-in challenge was malformed");
  }
  const nonce = decodeNonce(challenge.nonce);

  tell(onPhase, "wallet");
  const signed = await wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce,
  });
  if (!signed?.accountId || !signed.publicKey || !signed.signature) {
    throw new Error("The wallet did not return a complete signature");
  }

  tell(onPhase, "verify");
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/verify", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: normalizeSignature(signed.signature),
      }),
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
  } catch (e) {
    // Stopped before an answer came, so no session cookie was set: the owner is not signed in.
    if (timedOut(e)) throw new Error(SIGN_IN_TIMED_OUT);
    throw e;
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(
      isRecord(body) && typeof body.error === "string"
        ? refusalMessage(body.error)
        : "Sign-in failed",
    );
  }
  const verified: unknown = await res.json().catch(() => null);
  tell(onPhase, "open");
  return isRecord(verified) && typeof verified.accountId === "string" && verified.accountId !== ""
    ? verified.accountId
    : signed.accountId;
}

/**
 * What the selector or a wallet says when the owner closed it or said no: near-connect's "User rejected" (the
 * selector) and "Wallet closed" (a wallet's window), and the wallets' own "User cancelled" or "Rejected by user".
 */
const CLOSED =
  /\b(?:user (?:rejected|cancell?ed|closed|denied)|wallet closed|(?:rejected|cancell?ed|denied) by (?:the )?user)\b/i;

/** A sign-in error in words for the owner: a closed wallet or selector reads as such, not as "User rejected". */
export function signInErrorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return CLOSED.test(message) ? SIGN_IN_CLOSED : message;
}
