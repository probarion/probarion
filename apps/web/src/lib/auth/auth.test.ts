import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_RECIPIENT } from "@/lib/config";
import { decodeCanonical, deriveSubkey, macToken, parseMasterKey } from "@/lib/crypto/sodium";
import {
  FULL_ACCESS_KEY,
  FUNCTION_CALL_KEY,
  nep413Hash,
  signNep413,
} from "../../../test/fixtures/nep413";
import { httpStatus, rpcErr, rpcOk, scriptedRpc } from "../../../test/fixtures/rpc";
import {
  CHALLENGE_TTL_MS,
  challengeMessage,
  issueChallenge,
  NONCE_BURN_WINDOW_SECONDS,
  openChallenge,
} from "./challenge";
import {
  clearedCookieOptions,
  cookieOptions,
  createSessionToken,
  readSessionToken,
  SESSION_TTL_MS,
} from "./session";
import { type Nep413Verifier, nearApiVerifier, rpcLoginProvider, verifyLogin } from "./verify";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const NOW = Date.UTC(2026, 10, 8, 10, 0, 0);
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const challengeKey = deriveSubkey(MASTER, "challenge");
const sessionKey = deriveSubkey(MASTER, "session");

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Replaces the character at `i` with a different one from the same alphabet. */
function tamperAt(encoded: string, i: number, alphabet: string): string {
  const next = encoded.charAt(i) === alphabet.charAt(0) ? alphabet.charAt(1) : alphabet.charAt(0);
  return encoded.slice(0, i) + next + encoded.slice(i + 1);
}

/**
 * Swaps the last data character for its sibling that differs only in the lowest bit. When the encoded
 * length leaves unused trailing bits, a lenient decoder reads the sibling as the very same bytes.
 */
function lowBitSibling(encoded: string, alphabet: string): string {
  const end = encoded.replace(/=+$/, "").length - 1;
  const sibling = alphabet[alphabet.indexOf(encoded.charAt(end)) ^ 1];
  return encoded.slice(0, end) + sibling + encoded.slice(end + 1);
}

function providerWith(permission: unknown) {
  return {
    viewAccessKey: async () => ({ nonce: 0n, permission, block_hash: "h", block_height: 1 }),
  } as unknown as Parameters<typeof nearApiVerifier>[0];
}

async function signedFor(recipient = AUTH_RECIPIENT) {
  const key = await challengeKey;
  const { challenge, cookie } = await issueChallenge(key, NOW);
  const opened = await openChallenge(key, cookie, NOW + 1000);
  if (!opened) throw new Error("the challenge just issued did not open");
  const signed = signNep413({ message: challenge.message, nonce: opened.nonce, recipient });
  return {
    key,
    now: NOW,
    cookie,
    challenge,
    opened,
    login: {
      accountId: "alice.near",
      publicKey: signed.publicKey,
      signature: signed.signature,
    },
  };
}

/** A challenge token with arbitrary payload fields, sealed under `key` (default: the right key). */
async function forgeChallenge(fields: Record<string, unknown>, key?: Uint8Array) {
  const nonce = Buffer.alloc(32, 7).toString("base64");
  return macToken(key ?? (await challengeKey), {
    typ: "challenge",
    v: 1,
    n: nonce,
    exp: NOW + CHALLENGE_TTL_MS,
    ...fields,
  });
}

async function forgeSession(fields: Record<string, unknown>, key?: Uint8Array) {
  return macToken(key ?? (await sessionKey), {
    typ: "session",
    v: 1,
    a: "alice.near",
    exp: NOW + SESSION_TTL_MS,
    ...fields,
  });
}

describe("NEP-413 sign-in", () => {
  // probarion-claim: NEAR-CONNECT
  it("accepts a full-access signature over our challenge", async () => {
    const { opened, login } = await signedFor();
    const r = await verifyLogin(login, opened, nearApiVerifier(providerWith("FullAccess")));
    expect(r).toEqual({ ok: true, accountId: "alice.near" });
  });

  it("rejects a function-call key (NEP-413 requires a full-access key)", async () => {
    const { opened, login } = await signedFor();
    const fc = { FunctionCall: { allowance: null, receiver_id: "x.near", method_names: [] } };
    expect(await verifyLogin(login, opened, nearApiVerifier(providerWith(fc)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects every permission that is not the exact string FullAccess", async () => {
    const { opened, login } = await signedFor();
    for (const permission of [
      "fullaccess",
      "FullAccess ",
      { FullAccess: {} },
      { GasKeyFullAccess: { balance: "0", num_nonces: 1 } },
      {},
      null,
      undefined,
      7,
    ]) {
      expect(
        await verifyLogin(login, opened, nearApiVerifier(providerWith(permission))),
        JSON.stringify(permission),
      ).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  it("rejects a signature made for another recipient", async () => {
    const { opened, login } = await signedFor("evil.example");
    expect(await verifyLogin(login, opened, nearApiVerifier(providerWith("FullAccess")))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature made for another recipient even when the client names that recipient", async () => {
    const { opened, login } = await signedFor("evil.example");
    const claimed = { ...login, recipient: "evil.example", message: "anything" };
    expect(await verifyLogin(claimed, opened, nearApiVerifier(providerWith("FullAccess")))).toEqual(
      { ok: false, reason: "bad_signature" },
    );
  });

  it("rejects a signature made over a different message, or with a callback URL", async () => {
    const { opened, login, challenge } = await signedFor();
    const kp = KeyPair.fromRandom("ed25519");
    const sign = (hash: Uint8Array) => ({
      accountId: "alice.near",
      publicKey: kp.getPublicKey().toString(),
      signature: Buffer.from(kp.sign(hash).signature).toString("base64"),
    });
    const ok = sign(nep413Hash(challenge.message, opened.nonce, AUTH_RECIPIENT));
    const verifier = nearApiVerifier(providerWith("FullAccess"));
    expect(await verifyLogin(ok, opened, verifier)).toEqual({ ok: true, accountId: "alice.near" });
    const otherMessage = sign(nep413Hash(`${challenge.message} `, opened.nonce, AUTH_RECIPIENT));
    expect(await verifyLogin(otherMessage, opened, verifier)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const withCallback = sign(
      nep413Hash(challenge.message, opened.nonce, AUTH_RECIPIENT, "https://evil.example"),
    );
    expect(await verifyLogin(withCallback, opened, verifier)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(login.accountId).toBe("alice.near");
  });

  it("rejects a signature replayed against a different challenge", async () => {
    const a = await signedFor();
    const b = await signedFor();
    expect(
      await verifyLogin(a.login, b.opened, nearApiVerifier(providerWith("FullAccess"))),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature by another key than the one claimed", async () => {
    const { opened, login } = await signedFor();
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    const r = await verifyLogin(
      { ...login, publicKey: other },
      opened,
      nearApiVerifier(providerWith("FullAccess")),
    );
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects expired and tampered challenge cookies", async () => {
    const { key, now, cookie } = await signedFor();
    expect(await openChallenge(key, cookie, now + 6 * 60_000)).toBeNull();
    expect(await openChallenge(key, `${cookie}x`, now)).toBeNull();
    expect(await openChallenge(key, undefined, now)).toBeNull();
    const r = await verifyLogin(
      { accountId: "alice.near", publicKey: "ed25519:x", signature: "AA==" },
      null,
      async () => {},
    );
    expect(r).toEqual({ ok: false, reason: "challenge_missing_or_expired" });
  });

  it("rejects malformed login payloads before touching RPC", async () => {
    const { opened } = await signedFor();
    const never = async () => {
      throw new Error("must not be called");
    };
    const goodKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    // starts with bytes that spell "++++////" in standard base64, so the URL-safe spelling differs
    const sigBytes = Buffer.alloc(64, 1);
    sigBytes.set([0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff]);
    const sig64 = sigBytes.toString("base64");
    expect(sig64.startsWith("++++////")).toBe(true);
    // the account alone is wrong: the key and the signature are well formed
    for (const accountId of ["Alice.near", "alice.near\n", "a", "", "alice..near", " alice.near"]) {
      expect(
        await verifyLogin({ accountId, publicKey: goodKey, signature: sig64 }, opened, never),
        JSON.stringify(accountId),
      ).toEqual({ ok: false, reason: "invalid_input" });
    }
    for (const bad of [
      {
        accountId: "Alice.near",
        publicKey: "ed25519:x",
        signature: Buffer.alloc(64).toString("base64"),
      },
      {
        accountId: "alice.near",
        publicKey: "secp256k1:x",
        signature: Buffer.alloc(64).toString("base64"),
      },
      {
        accountId: "alice.near",
        publicKey: "ed25519:x",
        signature: Buffer.alloc(10).toString("base64"),
      },
      "not an object",
      null,
      undefined,
      [],
      42,
      // a public key that is not a 32-byte ed25519 key
      { accountId: "alice.near", publicKey: "ed25519:x", signature: sig64 },
      { accountId: "alice.near", publicKey: "ed25519:", signature: sig64 },
      { accountId: "alice.near", publicKey: goodKey.replace("ed25519:", ""), signature: sig64 },
      { accountId: "alice.near", publicKey: ` ${goodKey}`, signature: sig64 },
      { accountId: "alice.near", publicKey: goodKey.toUpperCase(), signature: sig64 },
      { accountId: "alice.near", publicKey: 5, signature: sig64 },
      // signature: wrong type, wrong length, not base64, or not the canonical spelling
      { accountId: "alice.near", publicKey: goodKey, signature: 5 },
      { accountId: "alice.near", publicKey: goodKey, signature: "" },
      {
        accountId: "alice.near",
        publicKey: goodKey,
        signature: Buffer.alloc(63).toString("base64"),
      },
      {
        accountId: "alice.near",
        publicKey: goodKey,
        signature: Buffer.alloc(65).toString("base64"),
      },
      {
        accountId: "alice.near",
        publicKey: goodKey,
        signature: `${sig64.slice(0, 10)}\n${sig64.slice(10)}`,
      },
      { accountId: "alice.near", publicKey: goodKey, signature: ` ${sig64}` },
      { accountId: "alice.near", publicKey: goodKey, signature: sig64.replace(/=+$/, "") },
      {
        accountId: "alice.near",
        publicKey: goodKey,
        signature: sig64.replace(/\+/g, "-").replace(/\//g, "_"),
      },
      {
        accountId: "alice.near",
        publicKey: goodKey,
        signature: lowBitSibling(sig64, `${B64URL.slice(0, 62)}+/`),
      },
      { accountId: undefined, publicKey: goodKey, signature: sig64 },
    ]) {
      expect(await verifyLogin(bad, opened, never), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
  });

  it("hands the verifier our message, our nonce and our recipient, whatever the client sends", async () => {
    const { opened, login, challenge } = await signedFor();
    const calls: Parameters<Nep413Verifier>[0][] = [];
    const spy: Nep413Verifier = async (a) => {
      calls.push(a);
    };
    const r = await verifyLogin(
      {
        ...login,
        message: "Pay mallory 1000 USDC",
        recipient: "evil.example",
        nonce: Buffer.alloc(32, 1).toString("base64"),
      },
      opened,
      spy,
    );
    expect(r).toEqual({ ok: true, accountId: "alice.near" });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Parameters<Nep413Verifier>[0];
    expect(call.message).toBe(challenge.message);
    expect(call.message).toBe(opened.message);
    expect(call.recipient).toBe(AUTH_RECIPIENT);
    expect(Buffer.from(call.nonce).equals(Buffer.from(opened.nonce))).toBe(true);
    expect(call.accountId).toBe("alice.near");
    expect(call.publicKey).toBe(login.publicKey);
    expect(call.signature).toHaveLength(64);
  });

  it("maps a verifier that throws to bad_signature and does not leak its message", async () => {
    const { opened, login } = await signedFor();
    const r = await verifyLogin(login, opened, async () => {
      throw new Error("secret detail at https://rpc.example/key123");
    });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("NEP-413 sign-in against the RPC (near-api-js verifyMessage behind the SDK client)", () => {
  async function login() {
    const s = await signedFor();
    return { ...s, accountKey: s.login.publicKey };
  }

  it("asks the node for exactly this account's key, and accepts a full-access key", async () => {
    const { opened, login: l } = await login();
    const { rpc, calls } = scriptedRpc([rpcOk(FULL_ACCESS_KEY)]);
    const r = await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(rpc)));
    expect(r).toEqual({ ok: true, accountId: "alice.near" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.method).toBe("query");
    expect(calls[0]?.body.params).toMatchObject({
      request_type: "view_access_key",
      finality: "final",
      account_id: "alice.near",
      public_key: l.publicKey,
    });
  });

  it("rejects a function-call key", async () => {
    const { opened, login: l } = await login();
    const { rpc } = scriptedRpc([rpcOk(FUNCTION_CALL_KEY)]);
    expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(rpc)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a public key that is not on the account (a valid signature does not matter)", async () => {
    const { opened, login: l } = await login();
    const { rpc } = scriptedRpc([rpcErr("UNKNOWN_ACCESS_KEY")]);
    expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(rpc)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an account that does not exist", async () => {
    const { opened, login: l } = await login();
    const { rpc } = scriptedRpc([rpcErr("UNKNOWN_ACCOUNT")]);
    expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(rpc)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("reads a missing key the way older nodes say it (HTTP 200, text in result.error) as a refusal", async () => {
    const { opened, login: l } = await login();
    const legacy = (error: string) => rpcOk({ error, logs: [], block_height: 1, block_hash: "h" });
    const missing = scriptedRpc([legacy(`access key ${l.publicKey} does not exist while viewing`)]);
    expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(missing.rpc)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // any other text in result.error is a node problem, not an answer about the key
    const other = scriptedRpc([legacy("the node is busy")]);
    expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(other.rpc)))).toEqual({
      ok: false,
      reason: "verifier_unavailable",
    });
  });

  it("says the verifier is unavailable, not that the signature is bad, when no node answers", async () => {
    const { opened, login: l } = await login();
    const { rpc } = scriptedRpc(
      Array.from({ length: 4 }, () => httpStatus(503)),
      ["https://a.example", "https://b.example"],
      { maxRounds: 2 },
    );
    expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(rpc)))).toEqual({
      ok: false,
      reason: "verifier_unavailable",
    });
  });

  it("treats a node's internal error as unavailable too, and a malformed answer as unavailable", async () => {
    const { opened, login: l } = await login();
    for (const answer of [
      rpcErr("INTERNAL_ERROR", "INTERNAL_ERROR"),
      rpcOk({ nonce: 0 }),
      rpcOk("x"),
      rpcOk(null),
    ]) {
      const { rpc } = scriptedRpc([answer], ["https://a.example"], { maxRounds: 1 });
      expect(await verifyLogin(l, opened, nearApiVerifier(rpcLoginProvider(rpc)))).toEqual({
        ok: false,
        reason: "verifier_unavailable",
      });
    }
  });

  it("still rejects a wrong signature when the key is full access", async () => {
    const a = await login();
    const b = await login();
    const { rpc } = scriptedRpc([rpcOk(FULL_ACCESS_KEY)]);
    // a's signature, b's challenge
    expect(await verifyLogin(a.login, b.opened, nearApiVerifier(rpcLoginProvider(rpc)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("challenge cookies", () => {
  it("states the message from the nonce alone", () => {
    expect(challengeMessage("ab".repeat(32))).toBe(
      `Sign in to Probarion\n\nThis proves you control this NEAR account. It does not move funds or add keys.\n\nNonce: ${"ab".repeat(32)}`,
    );
  });

  it("issues a 32-byte nonce, the fixed recipient and a message derived from the nonce", async () => {
    const key = await challengeKey;
    const rand = vi.fn((n: number) => Uint8Array.from({ length: n }, (_, i) => i));
    const { challenge, cookie } = await issueChallenge(key, NOW, rand);
    expect(rand).toHaveBeenCalledWith(32);
    expect(challenge.recipient).toBe(AUTH_RECIPIENT);
    expect(challenge.nonce).toBe(
      Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
    );
    expect(challenge.message).toBe(
      challengeMessage(Buffer.from(challenge.nonce, "base64").toString("hex")),
    );
    const opened = await openChallenge(key, cookie, NOW);
    expect(opened?.message).toBe(challenge.message);
    expect(Buffer.from(opened?.nonce ?? []).toString("base64")).toBe(challenge.nonce);
  });

  it("uses fresh randomness every time", async () => {
    const key = await challengeKey;
    const a = await issueChallenge(key, NOW);
    const b = await issueChallenge(key, NOW);
    expect(a.challenge.nonce).not.toBe(b.challenge.nonce);
    expect(a.cookie).not.toBe(b.cookie);
  });

  it("refuses a random source that does not give 32 bytes", async () => {
    const key = await challengeKey;
    for (const n of [0, 16, 31, 33]) {
      await expect(issueChallenge(key, NOW, () => new Uint8Array(n))).rejects.toThrow(/32/);
    }
  });

  it("lives for five minutes, which is inside the nonce-burn window", async () => {
    const key = await challengeKey;
    expect(CHALLENGE_TTL_MS).toBe(5 * 60_000);
    expect(NONCE_BURN_WINDOW_SECONDS).toBe(600);
    expect(NONCE_BURN_WINDOW_SECONDS * 1000).toBeGreaterThan(CHALLENGE_TTL_MS);
    const { cookie } = await issueChallenge(key, NOW);
    expect(await openChallenge(key, cookie, NOW + CHALLENGE_TTL_MS - 1)).not.toBeNull();
    expect(await openChallenge(key, cookie, NOW + CHALLENGE_TTL_MS)).toBeNull();
    expect(await openChallenge(key, cookie, NOW + CHALLENGE_TTL_MS + 1)).toBeNull();
  });

  it("rejects a cookie with a changed middle character or a changed last character", async () => {
    const key = await challengeKey;
    const { cookie } = await issueChallenge(key, NOW);
    const [body, tag] = cookie.split(".") as [string, string];
    const midTag = tamperAt(tag, Math.floor(tag.length / 2), B64URL);
    const midBody = tamperAt(body, Math.floor(body.length / 2), B64URL);
    expect(midTag).not.toBe(tag);
    expect(await openChallenge(key, `${body}.${midTag}`, NOW)).toBeNull();
    expect(await openChallenge(key, `${midBody}.${tag}`, NOW)).toBeNull();
    // the last character's low-bit sibling decodes to the same bytes in a lenient decoder
    const sibling = lowBitSibling(tag, B64URL);
    expect(sibling).not.toBe(tag);
    expect(Buffer.from(sibling, "base64url").equals(Buffer.from(tag, "base64url"))).toBe(true);
    expect(await openChallenge(key, `${body}.${sibling}`, NOW)).toBeNull();
    expect(await openChallenge(key, `${lowBitSibling(body, B64URL)}.${tag}`, NOW)).toBeNull();
    expect(await openChallenge(key, `${body}.${tag}`, NOW)).not.toBeNull();
  });

  it("rejects junk cookies", async () => {
    const key = await challengeKey;
    for (const junk of ["", ".", "a.b", "a.b.c", "x".repeat(5000), "\u0000", "undefined"]) {
      expect(await openChallenge(key, junk, NOW), junk.slice(0, 20)).toBeNull();
    }
  });

  it("decodes the nonce canonically (R7): no whitespace, no other alphabet, no spare bits", async () => {
    const key = await challengeKey;
    const nonce = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 8 + 1));
    const canonical = nonce.toString("base64");
    expect(canonical).toHaveLength(44);
    const open = async (n: unknown) => openChallenge(key, await forgeChallenge({ n }), NOW);
    // control: the canonical spelling opens
    expect(Buffer.from((await open(canonical))?.nonce ?? []).equals(nonce)).toBe(true);
    const sibling = lowBitSibling(canonical, `${B64URL.slice(0, 62)}+/`);
    // the control for the attack itself: Buffer.from happily reads the sibling as the same 32 bytes
    expect(Buffer.from(sibling, "base64").equals(nonce)).toBe(true);
    const base64url = nonce.toString("base64url");
    for (const bad of [
      sibling,
      `${canonical.slice(0, 10)}\n${canonical.slice(10)}`,
      ` ${canonical}`,
      `${canonical} `,
      canonical.replace(/=+$/, ""),
      base64url === canonical ? "" : base64url,
      `${canonical}A`,
      5,
      null,
      ["x"],
    ]) {
      expect(await open(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("requires the nonce to be exactly 32 bytes", async () => {
    const key = await challengeKey;
    for (const n of [0, 1, 16, 31, 33, 64]) {
      const token = await forgeChallenge({ n: Buffer.alloc(n, 3).toString("base64") });
      expect(await openChallenge(key, token, NOW), `${n} bytes`).toBeNull();
    }
    expect(await openChallenge(key, await forgeChallenge({}), NOW)).not.toBeNull();
  });

  it("checks its own type, version and expiry on the payload", async () => {
    const key = await challengeKey;
    const open = async (fields: Record<string, unknown>) =>
      openChallenge(key, await forgeChallenge(fields), NOW);
    expect(await open({})).not.toBeNull();
    for (const typ of ["session", "Challenge", "", undefined, null, 1]) {
      expect(await open({ typ }), `typ ${String(typ)}`).toBeNull();
    }
    for (const v of [0, 2, "1", undefined, null]) {
      expect(await open({ v }), `v ${String(v)}`).toBeNull();
    }
    for (const exp of [
      NOW,
      NOW - 1,
      0,
      -1,
      "9999999999999",
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(await open({ exp }), `exp ${String(exp)}`).toBeNull();
    }
    expect(await open({ exp: NOW + 1 })).not.toBeNull();
  });

  it("ignores the old payload field e: expiry is exp", async () => {
    const key = await challengeKey;
    const nonce = Buffer.alloc(32, 7).toString("base64");
    const token = await macToken(key, { typ: "challenge", v: 1, n: nonce, e: NOW + 1000 });
    expect(await openChallenge(key, token, NOW)).toBeNull();
  });

  it("separates tokens by key: a challenge sealed under the session key does not open", async () => {
    const key = await challengeKey;
    const wrongKey = await sessionKey;
    const sealedWrong = await forgeChallenge({}, wrongKey);
    expect(await openChallenge(key, sealedWrong, NOW)).toBeNull();
    // and a good challenge does not open under the session key
    const { cookie } = await issueChallenge(key, NOW);
    expect(await openChallenge(wrongKey, cookie, NOW)).toBeNull();
  });

  it("separates tokens by type: a session payload sealed under the right key does not open", async () => {
    const key = await challengeKey;
    // the nonce field is present and valid, so only the type can stop this one
    const asSession = await forgeChallenge({ typ: "session", a: "alice.near" });
    expect(await openChallenge(key, asSession, NOW)).toBeNull();
    const real = await forgeSession({ n: Buffer.alloc(32, 7).toString("base64") }, key);
    expect(await openChallenge(key, real, NOW)).toBeNull();
  });
});

describe("session tokens", () => {
  it("round-trip, expire and resist tampering", async () => {
    const key = await sessionKey;
    const t = await createSessionToken(key, "alice.near", 1_000);
    expect(await readSessionToken(key, t, 2_000)).toEqual({
      accountId: "alice.near",
      exp: 1_000 + 12 * 3600_000,
    });
    expect(await readSessionToken(key, t, 1_000 + 12 * 3600_000 + 1)).toBeNull();
    expect(
      await readSessionToken(
        key,
        t.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
        2_000,
      ),
    ).toBeNull();
  });

  it("lasts twelve hours and not a moment longer", async () => {
    const key = await sessionKey;
    expect(SESSION_TTL_MS).toBe(12 * 3600_000);
    const t = await createSessionToken(key, "alice.near", NOW);
    expect(await readSessionToken(key, t, NOW + SESSION_TTL_MS - 1)).toEqual({
      accountId: "alice.near",
      exp: NOW + SESSION_TTL_MS,
    });
    expect(await readSessionToken(key, t, NOW + SESSION_TTL_MS)).toBeNull();
    expect(await readSessionToken(key, t, NOW + SESSION_TTL_MS + 1)).toBeNull();
  });

  it("rejects a changed middle character and a changed last character (R7)", async () => {
    const key = await sessionKey;
    const t = await createSessionToken(key, "alice.near", NOW);
    const [body, tag] = t.split(".") as [string, string];
    const midTag = tamperAt(tag, Math.floor(tag.length / 2), B64URL);
    const midBody = tamperAt(body, Math.floor(body.length / 2), B64URL);
    expect(midTag).not.toBe(tag);
    expect(midBody).not.toBe(body);
    expect(await readSessionToken(key, `${body}.${midTag}`, NOW)).toBeNull();
    expect(await readSessionToken(key, `${midBody}.${tag}`, NOW)).toBeNull();
    const sibling = lowBitSibling(tag, B64URL);
    expect(Buffer.from(sibling, "base64url").equals(Buffer.from(tag, "base64url"))).toBe(true);
    expect(await readSessionToken(key, `${body}.${sibling}`, NOW)).toBeNull();
    expect(await readSessionToken(key, `${lowBitSibling(body, B64URL)}.${tag}`, NOW)).toBeNull();
    expect(await readSessionToken(key, `${body}.${tag}`, NOW)).not.toBeNull();
  });

  it("rejects junk and a wrong key", async () => {
    const key = await sessionKey;
    const t = await createSessionToken(key, "alice.near", NOW);
    for (const junk of ["", ".", "a.b", "a.b.c", "x".repeat(5000), `${t}x`, `x${t}`]) {
      expect(await readSessionToken(key, junk, NOW), junk.slice(0, 20)).toBeNull();
    }
    expect(await readSessionToken(await deriveSubkey(MASTER, "telegram"), t, NOW)).toBeNull();
    const otherMaster = parseMasterKey(Buffer.alloc(32, 10).toString("base64"));
    expect(await readSessionToken(await deriveSubkey(otherMaster, "session"), t, NOW)).toBeNull();
  });

  it("checks its own type, version, account and expiry on the payload", async () => {
    const key = await sessionKey;
    const read = async (fields: Record<string, unknown>) =>
      readSessionToken(key, await forgeSession(fields), NOW);
    expect(await read({})).toEqual({ accountId: "alice.near", exp: NOW + SESSION_TTL_MS });
    for (const typ of ["challenge", "Session", "", undefined, null, 3]) {
      expect(await read({ typ }), `typ ${String(typ)}`).toBeNull();
    }
    for (const v of [0, 2, "1", undefined, null]) {
      expect(await read({ v }), `v ${String(v)}`).toBeNull();
    }
    for (const a of ["Alice.near", "", "a", 5, null, undefined, "alice.near\n"]) {
      expect(await read({ a }), `a ${String(a)}`).toBeNull();
    }
    for (const exp of [
      NOW,
      NOW - 1,
      0,
      -1,
      "9999999999999",
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(await read({ exp }), `exp ${String(exp)}`).toBeNull();
    }
  });

  it("ignores the old payload field e: expiry is exp", async () => {
    const key = await sessionKey;
    const token = await macToken(key, { typ: "session", v: 1, a: "alice.near", e: NOW + 1000 });
    expect(await readSessionToken(key, token, NOW)).toBeNull();
  });

  it("separates tokens by key: a session sealed under the challenge key is not a session", async () => {
    const wrongKey = await challengeKey;
    expect(
      await readSessionToken(await sessionKey, await forgeSession({}, wrongKey), NOW),
    ).toBeNull();
    // and a valid challenge token presented as a session, whichever key reads it
    const { cookie } = await issueChallenge(wrongKey, NOW);
    expect(await readSessionToken(await sessionKey, cookie, NOW)).toBeNull();
    expect(await readSessionToken(wrongKey, cookie, NOW)).toBeNull();
  });

  it("separates tokens by type: a challenge payload sealed under the session key is not a session", async () => {
    const key = await sessionKey;
    // every session field is present and valid, so only the type can stop this one
    const asChallenge = await forgeSession({
      typ: "challenge",
      n: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(await readSessionToken(key, asChallenge, NOW)).toBeNull();
    const real = await macToken(key, {
      typ: "challenge",
      v: 1,
      n: Buffer.alloc(32, 7).toString("base64"),
      exp: NOW + SESSION_TTL_MS,
    });
    expect(await readSessionToken(key, real, NOW)).toBeNull();
  });

  it("refuses to mint a session for something that is not a NEAR account", async () => {
    const key = await sessionKey;
    for (const bad of ["", "Alice.near", "a", "alice near", "alice.near\n"]) {
      await expect(createSessionToken(key, bad, NOW)).rejects.toThrow(/account/);
    }
  });

  it("carries nothing but type, version, account and expiry", async () => {
    const key = await sessionKey;
    const t = await createSessionToken(key, "alice.near", NOW);
    const body = decodeCanonical(t.split(".")[0], "base64url");
    expect(JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()))).toEqual({
      typ: "session",
      v: 1,
      a: "alice.near",
      exp: NOW + SESSION_TTL_MS,
    });
  });
});

describe("cookie options", () => {
  it("are HttpOnly, SameSite=Lax and Path=/, with the max-age in seconds", () => {
    expect(cookieOptions(SESSION_TTL_MS)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 43_200,
    });
    expect(cookieOptions(CHALLENGE_TTL_MS).maxAge).toBe(300);
    expect(cookieOptions(1999).maxAge).toBe(1);
  });

  it("are Secure in production only", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieOptions(1000).secure).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(cookieOptions(1000).secure).toBe(false);
  });

  it("clear with the same attributes, an empty value's lifetime of zero and an expiry in the past", () => {
    vi.stubEnv("NODE_ENV", "production");
    const set = cookieOptions(SESSION_TTL_MS);
    const cleared = clearedCookieOptions();
    expect(cleared).toMatchObject({
      httpOnly: set.httpOnly,
      secure: set.secure,
      sameSite: set.sameSite,
      path: set.path,
      maxAge: 0,
    });
    expect(cleared.expires.getTime()).toBe(0);
  });
});
