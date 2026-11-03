import { createHash } from "node:crypto";
import { RpcError } from "@probarion/sdk";
import { PublicKey } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { AUTH_RECIPIENT } from "@/lib/config";
import { decodeCanonical } from "@/lib/crypto/sodium";
import { rpcCauseName } from "@/lib/near/reader";
import { isNearAccountId } from "@/lib/near/validate";

export interface SignedLogin {
  accountId: string;
  publicKey: string;
  signature: string; // base64, 64 bytes
}

export type Nep413Verifier = (a: {
  accountId: string;
  publicKey: string;
  signature: Uint8Array;
  message: string;
  recipient: string;
  nonce: Uint8Array;
}) => Promise<void>;

/**
 * The one provider call `verifyMessage` makes (near-api-js 7.4, nep413/verify): the access key of the
 * signer. Kept this small so the route can back it with the shared SDK RpcClient (`rpcLoginProvider`).
 */
export interface AccessKeyProvider {
  viewAccessKey(a: {
    accountId: string;
    publicKey: string | PublicKey;
  }): Promise<{ permission: unknown }>;
}

type VerifyProvider = Parameters<typeof verifyMessage>[0]["provider"];

/**
 * The key could not be looked up (no node answered, or an answer that is not about the key). That is not
 * the same as "this key is not on this account", and the sign-in page should say "try again", not "bad signature".
 */
export class VerifierUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("verifier_unavailable", options);
    this.name = "VerifierUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The causes nearcore gives when the account, or the key on it, is not there: a definitive "no". */
const NOT_FOUND_CAUSES: ReadonlySet<string> = new Set([
  "UNKNOWN_ACCESS_KEY",
  "UNKNOWN_ACCOUNT",
  "INVALID_ACCOUNT",
]);

/** True only for a JSON-RPC answer that says the key or its account does not exist. */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof RpcError) || error.rpcError === null) return false;
  const cause = rpcCauseName(error.rpcError);
  return cause !== null && NOT_FOUND_CAUSES.has(cause);
}

/** What older nodes put in `result.error` (HTTP 200, no JSON-RPC error) for a key or account that is not there. */
const MISSING_TEXT = /^(?:access key|account) .+ does not exist while viewing$/;

/**
 * `viewAccessKey` over the shared SDK RpcClient (failover, backoff, URL redaction). A definitive chain answer
 * (the key or the account does not exist) is thrown as it came, and the sign-in is refused. Anything else,
 * a transport failure, a node-side error or a result that is not an access key, becomes `VerifierUnavailableError`.
 *
 * The permission is passed through untouched: `verifyMessage` accepts the exact string "FullAccess" and nothing
 * else. Do not swap this for the console's `reader.accessKey`. It reads permissions fail-closed now, but its
 * `fullAccess` is true for `GasKeyFullAccess` (right for a display of what a key can do), and a login must
 * accept a plain full-access key only: the ruling excludes gas keys.
 */
export function rpcLoginProvider(rpc: {
  call<T>(method: string, params: unknown): Promise<T>;
}): AccessKeyProvider {
  return {
    async viewAccessKey({ accountId, publicKey }) {
      let result: unknown;
      try {
        result = await rpc.call<unknown>("query", {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey.toString(),
        });
      } catch (error) {
        if (isNotFound(error)) throw error;
        throw new VerifierUnavailableError({ cause: error });
      }
      if (isRecord(result) && typeof result.error === "string") {
        // Some nodes answer a missing key as HTTP 200 with the text in result.error, not as a JSON-RPC error.
        if (MISSING_TEXT.test(result.error)) throw new Error("access key not found");
        throw new VerifierUnavailableError();
      }
      if (!isRecord(result) || !("permission" in result)) {
        throw new VerifierUnavailableError();
      }
      return { permission: result.permission };
    },
  };
}

const NEP413_TAG = 2147484061; // 2^31 + 413
const NONCE_BYTES = 32;

/**
 * The NEP-413 digest a wallet signs (NEPs/nep-0413.md): sha256(u32le(2^31 + 413) || borsh(Payload)), with the
 * payload { message: string, nonce: [u8; 32], recipient: string, callbackUrl: None }. This is the construction
 * near-api-js's `verifyMessage` hashes (we verify with no callback URL); it is written out here so the
 * signature can be checked before any RPC call. A test compares it with an independent copy.
 */
export function nep413Digest(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error(`the nonce must be ${NONCE_BYTES} bytes`);
  const enc = new TextEncoder();
  const str = (s: string): Uint8Array => {
    const bytes = enc.encode(s);
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length, true);
    out.set(bytes, 4);
    return out;
  };
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const payload = Buffer.concat([tag, str(message), nonce, str(recipient), new Uint8Array([0])]);
  return new Uint8Array(createHash("sha256").update(payload).digest());
}

/**
 * Two checks, in this order. First the ed25519 signature, here and now, with the claimed key: a forgery is
 * refused without an RPC call (it would otherwise cost a full round trip, and during an outage turn a plain
 * "bad signature" into a 503). Only then `verifyMessage`, which checks the signature again and, through the
 * provider, that publicKey is a FullAccess key of accountId on chain.
 */
export function nearApiVerifier(provider: AccessKeyProvider): Nep413Verifier {
  return async (a) => {
    const digest = nep413Digest(a.message, a.nonce, a.recipient);
    if (!PublicKey.fromString(a.publicKey).verify(digest, a.signature)) {
      throw new Error("signature does not match");
    }
    await verifyMessage({
      signerAccountId: a.accountId,
      signerPublicKey: a.publicKey,
      signature: a.signature,
      payload: { message: a.message, recipient: a.recipient, nonce: a.nonce },
      // verifyMessage reads viewAccessKey and nothing else from the provider.
      provider: provider as unknown as VerifyProvider,
    });
  };
}

const SIGNATURE_BYTES = 64;
const ED25519_KEY_BYTES = 32;

/** An `ed25519:<base58>` key of exactly 32 bytes, in the one spelling `PublicKey` prints. */
function isEd25519PublicKey(s: string): boolean {
  if (!s.startsWith("ed25519:")) return false;
  try {
    const key = PublicKey.fromString(s);
    return key.keyType === 0 && key.data.length === ED25519_KEY_BYTES && key.toString() === s;
  } catch {
    return false;
  }
}

function parseLogin(x: unknown): (SignedLogin & { sigBytes: Uint8Array }) | null {
  if (typeof x !== "object" || x === null) return null;
  const { accountId, publicKey, signature } = x as Record<string, unknown>;
  if (typeof accountId !== "string" || !isNearAccountId(accountId)) return null;
  if (typeof publicKey !== "string" || !isEd25519PublicKey(publicKey)) return null;
  // R7: one spelling of the signature (standard, padded base64), not whatever Buffer.from tolerates.
  const sigBytes = decodeCanonical(signature, "base64");
  if (sigBytes === null || sigBytes.length !== SIGNATURE_BYTES) return null;
  return { accountId, publicKey, signature: signature as string, sigBytes };
}

export type LoginResult =
  | { ok: true; accountId: string }
  | {
      ok: false;
      reason:
        | "challenge_missing_or_expired"
        | "invalid_input"
        | "bad_signature"
        | "verifier_unavailable";
    };

/**
 * The message, the nonce and the recipient come from the server's own challenge and constant, never from the
 * login the client sent: whatever extra fields it carries are ignored. A challenge must already be opened
 * (and its nonce burned) by the caller.
 */
export async function verifyLogin(
  login: unknown,
  challenge: { nonce: Uint8Array; message: string } | null,
  verifier: Nep413Verifier,
): Promise<LoginResult> {
  if (!challenge) return { ok: false, reason: "challenge_missing_or_expired" };
  const l = parseLogin(login);
  if (!l) return { ok: false, reason: "invalid_input" };
  try {
    await verifier({
      accountId: l.accountId,
      publicKey: l.publicKey,
      signature: l.sigBytes,
      message: challenge.message,
      recipient: AUTH_RECIPIENT,
      nonce: challenge.nonce,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof VerifierUnavailableError ? "verifier_unavailable" : "bad_signature",
    };
  }
  return { ok: true, accountId: l.accountId };
}
