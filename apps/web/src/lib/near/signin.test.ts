import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  decodeNonce,
  type Nep413Wallet,
  normalizeSignature,
  type SignedMessage,
  signInWithWallet,
} from "./signin";

const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SIG = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
const SIG_B64 = Buffer.from(SIG).toString("base64");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const CHALLENGE = {
  message: "Sign in to Probarion. Nonce 0102",
  recipient: "probarion.xyz",
  nonce: b64(NONCE),
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(replies: Response[]) {
  const calls: Call[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = replies.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeWallet(signed: Partial<SignedMessage> | Error) {
  const seen: Parameters<Nep413Wallet["signMessage"]>[0][] = [];
  const wallet: Nep413Wallet = {
    async signMessage(p) {
      seen.push(p);
      if (signed instanceof Error) throw signed;
      return {
        accountId: "alice.near",
        publicKey: "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M",
        signature: SIG_B64,
        ...signed,
      };
    },
  };
  return { wallet, seen };
}

describe("signInWithWallet (NEP-413)", () => {
  it("fetches the challenge, signs it with the decoded nonce, and posts the signature", async () => {
    const { impl, calls } = fakeFetch([json(CHALLENGE), json({ accountId: "alice.near" })]);
    const { wallet, seen } = fakeWallet({});
    await expect(signInWithWallet(wallet, impl)).resolves.toBe("alice.near");

    expect(calls[0]?.url).toBe("/api/auth/challenge");
    expect(calls[0]?.init?.credentials).toBe("same-origin");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe(CHALLENGE.message);
    expect(seen[0]?.recipient).toBe("probarion.xyz");
    expect(Array.from(seen[0]?.nonce ?? [])).toEqual(Array.from(NONCE));

    expect(calls[1]?.url).toBe("/api/auth/verify");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.credentials).toBe("same-origin");
    expect(new Headers(calls[1]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      accountId: "alice.near",
      publicKey: "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M",
      signature: SIG_B64,
    });
  });

  it("posts the signature as base64 whatever encoding the wallet used", async () => {
    const encodings = [`ed25519:${bs58.encode(SIG)}`, Buffer.from(SIG).toString("hex")];
    for (const signature of encodings) {
      const { impl, calls } = fakeFetch([json(CHALLENGE), json({ accountId: "alice.near" })]);
      await signInWithWallet(fakeWallet({ signature }).wallet, impl);
      expect(JSON.parse(String(calls[1]?.init?.body)).signature, signature).toBe(SIG_B64);
    }
  });

  it("does not ask the wallet to sign when the challenge cannot be fetched", async () => {
    const { impl } = fakeFetch([json({}, 503)]);
    const { wallet, seen } = fakeWallet({});
    await expect(signInWithWallet(wallet, impl)).rejects.toThrow(
      "Sign-in is unavailable right now. Nothing was signed. Try again later.",
    );
    expect(seen).toHaveLength(0);
  });

  it("says the same when the challenge request itself fails", async () => {
    const { wallet, seen } = fakeWallet({});
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(signInWithWallet(wallet, offline)).rejects.toThrow(
      "Sign-in is unavailable right now. Nothing was signed. Try again later.",
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a challenge whose nonce is not 32 bytes (NEP-413) before asking the wallet", async () => {
    for (const nonce of [b64(new Uint8Array(31)), b64(new Uint8Array(33)), "", "###", 7]) {
      const { impl } = fakeFetch([json({ ...CHALLENGE, nonce })]);
      const { wallet, seen } = fakeWallet({});
      await expect(signInWithWallet(wallet, impl), String(nonce)).rejects.toThrow(/challenge/i);
      expect(seen).toHaveLength(0);
    }
  });

  it("refuses a challenge without a message or recipient", async () => {
    for (const bad of [
      { ...CHALLENGE, message: "" },
      { ...CHALLENGE, recipient: undefined },
      null,
    ]) {
      const { impl } = fakeFetch([json(bad)]);
      const { wallet, seen } = fakeWallet({});
      await expect(signInWithWallet(wallet, impl)).rejects.toThrow(/challenge/i);
      expect(seen).toHaveLength(0);
    }
  });

  it("does not post anything when the wallet refuses to sign", async () => {
    const { impl, calls } = fakeFetch([json(CHALLENGE)]);
    const { wallet } = fakeWallet(new Error("User rejected the request"));
    await expect(signInWithWallet(wallet, impl)).rejects.toThrow("User rejected the request");
    expect(calls).toHaveLength(1);
  });

  it("does not post an incomplete signed message", async () => {
    for (const missing of [{ accountId: "" }, { publicKey: "" }, { signature: "" }]) {
      const { impl, calls } = fakeFetch([json(CHALLENGE)]);
      await expect(signInWithWallet(fakeWallet(missing).wallet, impl)).rejects.toThrow(
        /did not return/i,
      );
      expect(calls).toHaveLength(1);
    }
  });

  it("explains the server's refusal code and keeps the code, else a generic message", async () => {
    const a = fakeFetch([json(CHALLENGE), json({ error: "bad_signature" }, 401)]);
    await expect(signInWithWallet(fakeWallet({}).wallet, a.impl)).rejects.toThrow(
      /signature was not accepted.*\(bad_signature\)/,
    );
    for (const code of [
      "challenge_missing_or_expired",
      "verifier_unavailable",
      "wrong_chain",
      "invalid_input",
      "bad_origin",
      "rate_limited",
    ]) {
      const f = fakeFetch([json(CHALLENGE), json({ error: code }, 400)]);
      await expect(signInWithWallet(fakeWallet({}).wallet, f.impl), code).rejects.toThrow(
        new RegExp(`\\(${code}\\)$`),
      );
    }
    // a code we do not know is shown as it is, and never matches a prototype key
    for (const code of ["something_new", "constructor", "toString"]) {
      const f = fakeFetch([json(CHALLENGE), json({ error: code }, 400)]);
      await expect(signInWithWallet(fakeWallet({}).wallet, f.impl), code).rejects.toThrow(
        new RegExp(`^${code}$`),
      );
    }
    const b = fakeFetch([json(CHALLENGE), new Response("<html>", { status: 502 })]);
    await expect(signInWithWallet(fakeWallet({}).wallet, b.impl)).rejects.toThrow("Sign-in failed");
  });

  it("returns the account the server verified, and falls back to the signed one on an empty 200", async () => {
    const a = fakeFetch([json(CHALLENGE), json({ accountId: "server.near" })]);
    await expect(
      signInWithWallet(fakeWallet({ accountId: "alice.near" }).wallet, a.impl),
    ).resolves.toBe("server.near");
    const b = fakeFetch([json(CHALLENGE), new Response(null, { status: 200 })]);
    await expect(
      signInWithWallet(fakeWallet({ accountId: "alice.near" }).wallet, b.impl),
    ).resolves.toBe("alice.near");
  });
});

describe("decodeNonce", () => {
  it("decodes standard and url-safe base64 to exactly 32 bytes", () => {
    expect(Array.from(decodeNonce(b64(NONCE)))).toEqual(Array.from(NONCE));
    const urlSafe = b64(NONCE).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(decodeNonce(urlSafe))).toEqual(Array.from(NONCE));
  });
  it("throws on anything else", () => {
    expect(() => decodeNonce("AAAA")).toThrow();
    expect(() => decodeNonce("!!!")).toThrow();
  });
});

describe("normalizeSignature: the server wants base64 of 64 bytes", () => {
  it("keeps a base64 signature (any padding, either alphabet) as canonical base64", () => {
    expect(normalizeSignature(SIG_B64)).toBe(SIG_B64);
    expect(normalizeSignature(`  ${SIG_B64}\n`)).toBe(SIG_B64);
    expect(normalizeSignature(SIG_B64.replace(/=+$/, ""))).toBe(SIG_B64);
    expect(normalizeSignature(SIG_B64.replace(/\+/g, "-").replace(/\//g, "_"))).toBe(SIG_B64);
  });

  it("converts an ed25519:<base58> signature", () => {
    expect(normalizeSignature(`ed25519:${bs58.encode(SIG)}`)).toBe(SIG_B64);
  });

  it("converts 128 hex characters, either case", () => {
    const hex = Buffer.from(SIG).toString("hex");
    expect(normalizeSignature(hex)).toBe(SIG_B64);
    expect(normalizeSignature(hex.toUpperCase())).toBe(SIG_B64);
  });

  it("handles base58 with leading zero bytes", () => {
    const sig = Uint8Array.from({ length: 64 }, (_, i) => (i < 3 ? 0 : i));
    expect(normalizeSignature(`ed25519:${bs58.encode(sig)}`)).toBe(b64(sig));
  });

  it("passes anything it cannot read through unchanged, for the server to refuse", () => {
    for (const odd of [
      "",
      "garbage",
      "ed25519:",
      "ed25519:0OIl",
      `ed25519:${bs58.encode(new Uint8Array(10))}`,
      "ab".repeat(63),
    ]) {
      expect(normalizeSignature(odd), odd).toBe(odd);
    }
  });
});
