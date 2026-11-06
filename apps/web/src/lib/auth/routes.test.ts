import type { PGlite } from "@electric-sql/pglite";
import { KeyPair } from "near-api-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey, macToken, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { LIMITS } from "@/lib/ratelimit";
import { freshDb } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { FULL_ACCESS_KEY, FUNCTION_CALL_KEY, signNep413 } from "../../../test/fixtures/nep413";
import { MAINNET_HOST, TESTNET_HOST } from "../../../test/fixtures/networks";
import { httpStatus, rpcErr, rpcOk, scriptedRpc } from "../../../test/fixtures/rpc";
import {
  burnChallenge,
  CHALLENGE_COOKIE,
  issueChallenge,
  NONCE_BURN_WINDOW_SECONDS,
} from "./challenge";
import { readSessionToken, SESSION_COOKIE } from "./session";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

const h = vi.hoisted(() => ({
  /** Cookies the browser sends with the request about to be made. */
  sent: new Map<string, string>(),
  /** A response the fake cookie jar serialises into, exactly as the framework's jar does. */
  out: null as unknown as import("next/server").NextResponse,
  db: null as unknown as Db,
  rpc: null as unknown,
  /** The address the request is opened at: its host decides the network (both are served, testnet by default). */
  host: null as string | null,
  /** The networks getRpc was asked for. */
  rpcFor: [] as string[],
  /**
   * Whether sign-in really asks the node which chain it serves (lib/near/chain). Off for the tests that script the key
   * lookup alone; the tests of that check switch it on and script its `status` answer first.
   */
  realChain: false,
  /** Switches that make one piece of infrastructure fail, to see that each gives a 503 and never a 500. */
  fail: {
    db: null as null | ((fn: string, p?: Record<string, unknown>) => boolean),
    subkey: new Set<string>(),
    serviceDb: false,
    getRpc: false,
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "host" ? h.host : null) }),
  cookies: async () => ({
    get: (name: string) => (h.sent.has(name) ? { name, value: h.sent.get(name) } : undefined),
    set: (name: string, value: string, options?: object) => {
      h.out.cookies.set(name, value, options);
    },
    delete: (name: string) => {
      h.out.cookies.delete(name);
    },
  }),
}));
vi.mock("@/lib/crypto/server", async () => {
  const sodium = await import("@/lib/crypto/sodium");
  const master = sodium.parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
  return {
    masterKey: () => master,
    subkey: (purpose: Parameters<typeof sodium.deriveSubkey>[1]) =>
      h.fail.subkey.has(purpose)
        ? Promise.reject(new Error("kdf down"))
        : sodium.deriveSubkey(master, purpose),
  };
});
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => {
    if (h.fail.serviceDb) throw new Error("SUPABASE_URL is required");
    return h.db;
  },
}));
vi.mock("@/lib/near/server", () => ({
  getRpc: (network: string) => {
    h.rpcFor.push(network);
    if (h.fail.getRpc) throw new Error("NEAR_RPC_URLS is invalid");
    return h.rpc;
  },
}));
vi.mock("@/lib/near/chain", async (orig) => {
  const real = await orig<typeof import("@/lib/near/chain")>();
  return {
    ...real,
    ensureChain: (
      network: Parameters<typeof real.ensureChain>[0],
      rpc: Parameters<typeof real.ensureChain>[1],
    ) => (h.realChain ? real.ensureChain(network, rpc) : Promise.resolve()),
  };
});
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../test/fixtures/networks");
  return { getEnv: () => networkPart({ defaultNetwork: "testnet", both: true }) };
});

import { GET as challengeRoute } from "@/app/api/auth/challenge/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { POST as verifyRoute } from "@/app/api/auth/verify/route";

const ORIGIN = "http://localhost:3000";
const challengeKey = deriveSubkey(MASTER, "challenge");
const sessionKey = deriveSubkey(MASTER, "session");

let pg: PGlite;
let ipCounter = 0;
/** A fresh client address per test, so one test's rate-limit hits never reach another's. */
const nextIp = () => {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
};

beforeAll(async () => {
  pg = await freshDb();
  const real = pgliteDb(pg);
  h.db = {
    rpc: (fn, p) => (h.fail.db?.(fn, p) ? Promise.reject(new Error("db down")) : real.rpc(fn, p)),
  };
});

afterAll(async () => {
  await pg.close();
});

let logged: string[];
beforeEach(async () => {
  const { NextResponse } = await import("next/server");
  h.out = new NextResponse(null);
  h.sent = new Map();
  h.fail.db = null;
  h.fail.subkey.clear();
  h.fail.serviceDb = false;
  h.fail.getRpc = false;
  h.host = null;
  h.rpcFor = [];
  h.realChain = false;
  logged = [];
  const sink = (line: unknown) => {
    logged.push(String(line));
  };
  vi.spyOn(console, "log").mockImplementation(sink);
  vi.spyOn(console, "warn").mockImplementation(sink);
  vi.spyOn(console, "error").mockImplementation(sink);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fresh() {
  const { NextResponse } = await import("next/server");
  h.out = new NextResponse(null);
}

/** Runs a handler as one request: the browser sends `cookies`, and the Set-Cookie lines come back. */
async function run(
  handler: (req: Request) => Promise<Response>,
  req: Request,
  cookies: Record<string, string> = {},
) {
  await fresh();
  h.sent = new Map(Object.entries(cookies));
  const res = await handler(req);
  return { res, setCookies: h.out.headers.getSetCookie() };
}

function setCookieOf(lines: string[], name: string): string | undefined {
  return lines.find((l) => l.startsWith(`${name}=`));
}
function cookieValue(lines: string[], name: string): string {
  const line = setCookieOf(lines, name);
  if (!line) throw new Error(`no Set-Cookie for ${name}: ${JSON.stringify(lines)}`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

interface ChallengeBody {
  message: string;
  recipient: string;
  nonce: string;
}

async function getChallenge(ip = nextIp()) {
  const { res, setCookies } = await run(
    challengeRoute,
    new Request(`${ORIGIN}/api/auth/challenge`, { headers: { "x-forwarded-for": ip } }),
  );
  const body = (await res.json()) as ChallengeBody;
  return {
    res,
    setCookies,
    body,
    cookie: setCookieOf(setCookies, CHALLENGE_COOKIE)
      ? cookieValue(setCookies, CHALLENGE_COOKIE)
      : "",
  };
}

function login(
  body: ChallengeBody,
  account = "alice.near",
  keyPair = KeyPair.fromRandom("ed25519"),
) {
  const signed = signNep413({
    message: body.message,
    nonce: Buffer.from(body.nonce, "base64"),
    recipient: body.recipient,
    keyPair,
  });
  return { accountId: account, publicKey: signed.publicKey, signature: signed.signature };
}

function verifyRequest(
  body: unknown,
  ip: string,
  headers: Record<string, string> = { origin: ORIGIN },
) {
  return new Request(`${ORIGIN}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postVerify(
  body: unknown,
  chal: string | undefined,
  ip = nextIp(),
  headers?: Record<string, string>,
) {
  const { res, setCookies } = await run(
    verifyRoute,
    verifyRequest(body, ip, headers),
    chal === undefined ? {} : { [CHALLENGE_COOKIE]: chal },
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { res, setCookies, json };
}

function useRpc(...answers: Parameters<typeof scriptedRpc>[0]) {
  const s = scriptedRpc(answers, ["https://a.example"], { maxRounds: 1 });
  h.rpc = s.rpc;
  return s;
}

const NONCE_BUCKET = /^auth:nonce:[0-9a-f]{64}$/;
async function burnedBuckets() {
  const r = await pg.query<{ bucket: string }>(
    "select bucket from public.rate_limits where bucket like 'auth:nonce:%'",
  );
  return r.rows.map((x) => x.bucket);
}

describe("GET /api/auth/challenge", () => {
  it("returns the message, the recipient and a 32-byte nonce, and sets the challenge cookie", async () => {
    const { res, body, setCookies, cookie } = await getChallenge();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.recipient).toBe("probarion.xyz");
    expect(Buffer.from(body.nonce, "base64")).toHaveLength(32);
    expect(body.message).toContain(`Nonce: ${Buffer.from(body.nonce, "base64").toString("hex")}`);
    expect(setCookies).toHaveLength(1);
    // sealed under the challenge subkey, as a challenge
    const parts = cookie.split(".");
    expect(parts).toHaveLength(2);
    const { openChallenge } = await import("./challenge");
    expect((await openChallenge(await challengeKey, cookie, "testnet"))?.message).toBe(
      body.message,
    );
    expect(await openChallenge(await sessionKey, cookie, "testnet")).toBeNull();
  });

  it("sets the cookie HttpOnly, SameSite=Lax, Path=/ for five minutes (not Secure outside production)", async () => {
    const { setCookies } = await getChallenge();
    const line = setCookieOf(setCookies, CHALLENGE_COOKIE) ?? "";
    expect(line).toMatch(/; Path=\//i);
    expect(line).toMatch(/; Max-Age=300(;|$)/i);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=lax/i);
    expect(line).not.toMatch(/; Secure/i);
  });

  it("sets the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { setCookies } = await getChallenge();
    expect(setCookieOf(setCookies, CHALLENGE_COOKIE)).toMatch(/; Secure/i);
  });

  it("gives every caller a different nonce", async () => {
    const a = await getChallenge();
    const b = await getChallenge();
    expect(a.body.nonce).not.toBe(b.body.nonce);
  });

  it("is rate limited per client address", async () => {
    const ip = nextIp();
    const [max] = LIMITS.authChallenge;
    for (let i = 0; i < max; i += 1) expect((await getChallenge(ip)).res.status).toBe(200);
    const over = await getChallenge(ip);
    expect(over.res.status).toBe(429);
    expect(over.res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(over.setCookies).toEqual([]);
    // another address is not affected
    expect((await getChallenge(nextIp())).res.status).toBe(200);
  });
});

describe("POST /api/auth/verify", () => {
  it("signs a wallet in: a session cookie for the account, and the challenge cookie cleared", async () => {
    const c = await getChallenge();
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const { res, json, setCookies } = await postVerify(login(c.body), c.cookie);
    expect(res.status).toBe(200);
    expect(json).toEqual({ accountId: "alice.near" });
    expect(rpc.remaining()).toBe(0);
    const session = await readSessionToken(
      await sessionKey,
      cookieValue(setCookies, SESSION_COOKIE),
    );
    expect(session?.accountId).toBe("alice.near");
    // the challenge cookie is spent on every attempt
    expect(setCookieOf(setCookies, CHALLENGE_COOKIE)).toMatch(/Max-Age=0/i);
  });

  it("sets the session cookie HttpOnly, SameSite=Lax, Path=/ for twelve hours", async () => {
    const c = await getChallenge();
    useRpc(rpcOk(FULL_ACCESS_KEY));
    const { setCookies } = await postVerify(login(c.body), c.cookie);
    const line = setCookieOf(setCookies, SESSION_COOKIE) ?? "";
    expect(line).toMatch(/; Path=\//i);
    expect(line).toMatch(/; Max-Age=43200(;|$)/i);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=lax/i);
    expect(line).not.toMatch(/; Secure/i);
    vi.stubEnv("NODE_ENV", "production");
    const d = await getChallenge();
    useRpc(rpcOk(FULL_ACCESS_KEY));
    const prod = await postVerify(login(d.body), d.cookie);
    expect(setCookieOf(prod.setCookies, SESSION_COOKIE)).toMatch(/; Secure/i);
    expect(setCookieOf(prod.setCookies, CHALLENGE_COOKIE)).toMatch(/; Secure/i);
  });

  it("R8: burns the nonce, so a second verify with the same cookie and signature is a 401", async () => {
    const c = await getChallenge();
    const l = login(c.body);
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY), rpcOk(FULL_ACCESS_KEY));
    const first = await postVerify(l, c.cookie);
    expect(first.res.status).toBe(200);
    // the attacker kept the cookie and the signature
    const replay = await postVerify(l, c.cookie);
    expect(replay.res.status).toBe(401);
    expect(replay.json).toEqual({ error: "challenge_missing_or_expired" });
    expect(setCookieOf(replay.setCookies, SESSION_COOKIE)).toBeUndefined();
    // the replay never reached the RPC
    expect(rpc.remaining()).toBe(1);
    const nonceHex = Buffer.from(c.body.nonce, "base64").toString("hex");
    expect(await burnedBuckets()).toContain(`auth:nonce:${nonceHex}`);
    // and the replay was logged as such, without the signature or the cookie
    const line = logged.find((x) => x.includes("auth.rejected")) ?? "";
    expect(line).toContain("challenge_replayed");
    expect(line).not.toContain(l.signature);
    expect(line).not.toContain(c.cookie);
  });

  it("R8: the nonce is burned before the signature is looked at, success or not", async () => {
    const c = await getChallenge();
    const rpc = useRpc(rpcOk(FUNCTION_CALL_KEY), rpcOk(FULL_ACCESS_KEY));
    const l = login(c.body);
    // first attempt fails (function-call key) ...
    expect((await postVerify(l, c.cookie)).res.status).toBe(401);
    // ... and the very same, now acceptable, login does not get a second go
    const second = await postVerify(l, c.cookie);
    expect(second.res.status).toBe(401);
    expect(rpc.remaining()).toBe(1);
  });

  it("R8: of two parallel submissions with one cookie, exactly one signs in", async () => {
    const c = await getChallenge();
    const l = login(c.body);
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY), rpcOk(FULL_ACCESS_KEY));
    h.sent = new Map([[CHALLENGE_COOKIE, c.cookie]]);
    await fresh();
    const ip = nextIp();
    const [a, b] = await Promise.all([
      verifyRoute(verifyRequest(l, ip)),
      verifyRoute(verifyRequest(l, ip)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(rpc.remaining()).toBe(1);
  });

  it("does not let one browser's challenge be redeemed with another's signature", async () => {
    const a = await getChallenge();
    const b = await getChallenge();
    useRpc(rpcOk(FULL_ACCESS_KEY));
    const r = await postVerify(login(a.body), b.cookie);
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "bad_signature" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
  });

  it("answers 401 without a challenge cookie, and does not ask the RPC", async () => {
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const c = await getChallenge();
    const r = await postVerify(login(c.body), undefined);
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "challenge_missing_or_expired" });
    expect(rpc.remaining()).toBe(1);
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
  });

  it("answers 401 for an expired challenge, one sealed under the session key, and a session as a challenge", async () => {
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const body = (await getChallenge()).body;
    const l = login(body);
    const expired = await issueChallenge(await challengeKey, "testnet", Date.now() - 6 * 60_000);
    const wrongKey = await issueChallenge(await sessionKey, "testnet");
    const asSession = await macToken(await challengeKey, {
      typ: "session",
      v: 1,
      a: "alice.near",
      exp: Date.now() + 60_000,
    });
    for (const cookie of [expired.cookie, wrongKey.cookie, asSession, "junk"]) {
      const r = await postVerify(l, cookie);
      expect(r.res.status, cookie.slice(0, 12)).toBe(401);
      expect(r.json).toEqual({ error: "challenge_missing_or_expired" });
    }
    expect(rpc.remaining()).toBe(1);
  });

  it("rejects a function-call key", async () => {
    const c = await getChallenge();
    useRpc(rpcOk(FUNCTION_CALL_KEY));
    const r = await postVerify(login(c.body), c.cookie);
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "bad_signature" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a public key that is not on the account", async () => {
    const c = await getChallenge();
    useRpc(rpcErr("UNKNOWN_ACCESS_KEY"));
    const r = await postVerify(login(c.body), c.cookie);
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "bad_signature" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a signature made for another recipient", async () => {
    const c = await getChallenge();
    useRpc(rpcOk(FULL_ACCESS_KEY));
    const signed = signNep413({
      message: c.body.message,
      nonce: Buffer.from(c.body.nonce, "base64"),
      recipient: "evil.example",
    });
    const r = await postVerify(
      { accountId: "alice.near", publicKey: signed.publicKey, signature: signed.signature },
      c.cookie,
    );
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "bad_signature" });
  });

  it("says 503, not 'bad signature', when no node can be asked, and signs nobody in", async () => {
    const c = await getChallenge();
    useRpc(httpStatus(503));
    const r = await postVerify(login(c.body), c.cookie);
    expect(r.res.status).toBe(503);
    expect(r.json).toEqual({ error: "unavailable" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
    expect(logged.join(" | ")).toContain("verifier_unavailable");
  });

  it("refuses a forged signature with a 401 and no RPC call, even while the nodes are down", async () => {
    const c = await getChallenge();
    const rpc = useRpc(httpStatus(503), httpStatus(503));
    const forged = { ...login(c.body), signature: Buffer.alloc(64, 9).toString("base64") };
    const r = await postVerify(forged, c.cookie);
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "bad_signature" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
    expect(rpc.calls).toHaveLength(0);
    expect(rpc.remaining()).toBe(2);
  });

  it("answers invalid_input for a body that is not a login, and never asks the RPC", async () => {
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    for (const body of ["not json", "null", "[]", '{"accountId":"Alice.near"}', "{}", ""]) {
      const c = await getChallenge();
      const r = await postVerify(body, c.cookie);
      expect(r.res.status, body).toBe(401);
      expect(r.json, body).toEqual({ error: "invalid_input" });
    }
    expect(rpc.remaining()).toBe(1);
  });

  it("refuses a body far larger than a login with a 413", async () => {
    const c = await getChallenge();
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const l = login(c.body);
    const r = await postVerify({ ...l, padding: "x".repeat(100_000) }, c.cookie);
    expect(r.res.status).toBe(413);
    expect(r.json).toEqual({ error: "payload_too_large" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
    expect(rpc.remaining()).toBe(1);
  });

  describe("the body cap counts real bytes as they arrive (no Content-Length)", () => {
    const MAX = 2048;
    const enc = new TextEncoder();

    /** A chunked request body: `next()` gives the next piece, or null at the end. `state` is what the route took. */
    function streamed(next: () => Uint8Array | null, headers: Record<string, string> = {}) {
      const state = { pulls: 0, bytes: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            state.pulls += 1;
            const chunk = next();
            if (chunk === null) {
              controller.close();
              return;
            }
            state.bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const req = new Request(`${ORIGIN}/api/auth/verify`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-forwarded-for": nextIp(), ...headers },
        body,
        duplex: "half",
      } as RequestInit);
      return { req, state };
    }

    /** The bytes of `text` in pieces of `size`. */
    function pieces(bytes: Uint8Array, size: number) {
      let at = 0;
      return () => {
        if (at >= bytes.byteLength) return null;
        const chunk = bytes.slice(at, at + size);
        at += size;
        return chunk;
      };
    }

    async function send(req: Request, chal: string) {
      const { res, setCookies } = await run(verifyRoute, req, { [CHALLENGE_COOKIE]: chal });
      return { res, setCookies, json: (await res.json()) as Record<string, unknown> };
    }

    it("has no Content-Length on these requests (so the header cannot be what stops them)", () => {
      const { req } = streamed(() => null);
      expect(req.headers.get("content-length")).toBeNull();
    });

    it("stops reading an endless chunked body at the cap, and cancels the stream", async () => {
      const c = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      const { req, state } = streamed(() => new Uint8Array(1000).fill(0x20));
      const r = await send(req, c.cookie);
      expect(r.res.status).toBe(413);
      expect(r.json).toEqual({ error: "payload_too_large" });
      // 1000-byte chunks: the third pushes the total past 2048, and nothing more is pulled
      expect(state.bytes).toBeLessThanOrEqual(MAX + 1000);
      expect(state.pulls).toBeLessThanOrEqual(3);
      expect(state.cancelled).toBe(true);
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
      expect(rpc.remaining()).toBe(1);
    });

    it("counts bytes, not characters", async () => {
      const c = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      const text = JSON.stringify({ padding: "é".repeat(1100) }); // about 1100 characters, 2200+ bytes
      expect(text.length).toBeLessThan(MAX);
      expect(enc.encode(text).byteLength).toBeGreaterThan(MAX);
      const { req } = streamed(pieces(enc.encode(text), 64));
      const r = await send(req, c.cookie);
      expect(r.res.status).toBe(413);
      expect(rpc.remaining()).toBe(1);
    });

    it("accepts a login of exactly the cap and refuses one byte more", async () => {
      const padTo = (json: string, size: number) =>
        enc.encode(json + " ".repeat(size - enc.encode(json).byteLength));
      const c1 = await getChallenge();
      useRpc(rpcOk(FULL_ACCESS_KEY));
      const exact = streamed(pieces(padTo(JSON.stringify(login(c1.body)), MAX), 100));
      const ok = await send(exact.req, c1.cookie);
      expect(ok.res.status).toBe(200);
      expect(ok.json).toEqual({ accountId: "alice.near" });

      const c2 = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      const over = streamed(pieces(padTo(JSON.stringify(login(c2.body)), MAX + 1), 100));
      const no = await send(over.req, c2.cookie);
      expect(no.res.status).toBe(413);
      expect(rpc.remaining()).toBe(1);
    });

    it("refuses a declared length over the cap without reading the body", async () => {
      const c = await getChallenge();
      useRpc(rpcOk(FULL_ACCESS_KEY));
      const { req, state } = streamed(() => new Uint8Array(10), { "content-length": "5000" });
      const r = await send(req, c.cookie);
      expect(r.res.status).toBe(413);
      expect(state.pulls).toBe(0);
    });
  });

  it("checks the origin first: no Origin or a foreign one is a 403, and nothing is spent", async () => {
    const c = await getChallenge();
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const l = login(c.body);
    const ip = nextIp();
    const refused: Record<string, string>[] = [
      {},
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "not a url" },
    ];
    for (const headers of refused) {
      const r = await postVerify(l, c.cookie, ip, headers);
      expect(r.res.status, JSON.stringify(headers)).toBe(403);
      expect(r.json).toEqual({ error: "bad_origin" });
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
    }
    // the challenge was not burned by the refused requests, and no rate-limit hit was taken for them
    expect(await burnedBuckets()).not.toContain(
      `auth:nonce:${Buffer.from(c.body.nonce, "base64").toString("hex")}`,
    );
    expect(rpc.remaining()).toBe(1);
    const ok = await postVerify(l, c.cookie, ip);
    expect(ok.res.status).toBe(200);
  });

  it("is rate limited per client address", async () => {
    const ip = nextIp();
    const [max] = LIMITS.authVerify;
    useRpc();
    for (let i = 0; i < max; i += 1) {
      expect((await postVerify("{}", undefined, ip)).res.status).toBe(401);
    }
    const over = await postVerify("{}", undefined, ip);
    expect(over.res.status).toBe(429);
    expect(over.res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("does not burn a nonce for a request that was rate limited", async () => {
    const ip = nextIp();
    const [max] = LIMITS.authVerify;
    useRpc();
    for (let i = 0; i < max; i += 1) await postVerify("{}", undefined, ip);
    const c = await getChallenge();
    const r = await postVerify(login(c.body), c.cookie, ip);
    expect(r.res.status).toBe(429);
    expect(await burnedBuckets()).not.toContain(
      `auth:nonce:${Buffer.from(c.body.nonce, "base64").toString("hex")}`,
    );
  });

  it("fails closed when the nonce cannot be burned: no sign-in, no RPC", async () => {
    const c = await getChallenge();
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const real = h.db;
    h.db = {
      rpc: (fn, p) => {
        if (p?.bucket && String(p.bucket).startsWith("auth:nonce:")) {
          return Promise.reject(new Error("db down"));
        }
        return real.rpc(fn, p);
      },
    };
    try {
      const r = await run(verifyRoute, verifyRequest(login(c.body), nextIp()), {
        [CHALLENGE_COOKIE]: c.cookie,
      });
      expect(r.res.status).toBe(503);
      expect(await r.res.json()).toEqual({ error: "unavailable" });
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
      expect(logged.join(" | ")).toContain("auth.nonce_burn_failed");
    } finally {
      h.db = real;
    }
    expect(rpc.remaining()).toBe(1);
  });

  it("logs the sign-in and the refusals without the signature, the cookie or the key", async () => {
    const c = await getChallenge();
    const l = login(c.body);
    useRpc(rpcOk(FULL_ACCESS_KEY));
    await postVerify(l, c.cookie);
    const all = logged.join("\n");
    expect(all).toContain("auth.signed_in");
    expect(all).toContain("alice.near");
    for (const secret of [l.signature, c.cookie, l.publicKey, c.body.nonce]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("burnChallenge", () => {
  it("is allowed once per nonce and refused after, for the length of the window", async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    expect(await burnChallenge(h.db, nonce)).toBe(true);
    expect(await burnChallenge(h.db, nonce)).toBe(false);
    expect(await burnChallenge(h.db, nonce)).toBe(false);
    expect(await burnChallenge(h.db, crypto.getRandomValues(new Uint8Array(32)))).toBe(true);
    const hex = Buffer.from(nonce).toString("hex");
    expect(await burnedBuckets()).toContain(`auth:nonce:${hex}`);
    expect((await burnedBuckets()).every((b) => NONCE_BUCKET.test(b))).toBe(true);
    // 600 s is the window the rate limiter uses for it
    expect(NONCE_BURN_WINDOW_SECONDS).toBe(600);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie with the attributes it was set with", async () => {
    const { res, setCookies } = await run(
      logoutRoute,
      new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: ORIGIN } }),
      { [SESSION_COOKIE]: "whatever" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const line = setCookieOf(setCookies, SESSION_COOKIE) ?? "";
    expect(line.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(line).toMatch(/; Path=\//i);
    expect(line).toMatch(/; Max-Age=0(;|$)/i);
    expect(line).toMatch(/; Expires=Thu, 01 Jan 1970/i);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=lax/i);
  });

  it("clears it Secure in production, matching how it was set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { setCookies } = await run(
      logoutRoute,
      new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: ORIGIN } }),
    );
    expect(setCookieOf(setCookies, SESSION_COOKIE)).toMatch(/; Secure/i);
  });

  it("requires the same origin", async () => {
    const refused: Record<string, string>[] = [{}, { origin: "https://evil.example" }];
    for (const headers of refused) {
      const { res, setCookies } = await run(
        logoutRoute,
        new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers }),
        { [SESSION_COOKIE]: "whatever" },
      );
      expect(res.status).toBe(403);
      expect(setCookies).toEqual([]);
    }
  });
});

describe("infrastructure failures answer 503 'unavailable', never an unhandled 500", () => {
  const isRateLimit = (fn: string) => fn === "rate_limit_take";

  /** The response the browser would get: a handler that threw would have rejected before reaching here. */
  function unavailable(res: Response, json: unknown) {
    expect(res.status).toBe(503);
    expect(json).toEqual({ error: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  }

  describe("GET /api/auth/challenge", () => {
    it("when the rate-limit database is down", async () => {
      h.fail.db = isRateLimit;
      const c = await getChallenge();
      unavailable(c.res, c.body);
      expect(c.setCookies).toEqual([]);
      expect(logged.join(" | ")).toContain("auth.challenge_failed");
    });

    it("when the database client cannot be built (environment)", async () => {
      h.fail.serviceDb = true;
      const c = await getChallenge();
      unavailable(c.res, c.body);
      expect(c.setCookies).toEqual([]);
    });

    it("when the challenge subkey cannot be derived", async () => {
      h.fail.subkey.add("challenge");
      const c = await getChallenge();
      unavailable(c.res, c.body);
      expect(c.setCookies).toEqual([]);
    });

    it("does not put the failure's text in the response", async () => {
      h.fail.db = isRateLimit;
      const c = await getChallenge();
      expect(JSON.stringify(c.body)).not.toContain("db down");
    });
  });

  describe("POST /api/auth/verify", () => {
    it("when the rate-limit database is down", async () => {
      const c = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      h.fail.db = isRateLimit;
      const r = await postVerify(login(c.body), c.cookie);
      unavailable(r.res, r.json);
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
      expect(rpc.remaining()).toBe(1);
      expect(logged.join(" | ")).toContain("auth.verify_failed");
    });

    it("when the database client cannot be built (environment)", async () => {
      const c = await getChallenge();
      h.fail.serviceDb = true;
      const r = await postVerify(login(c.body), c.cookie);
      expect(r.res.status).toBe(503);
      expect(r.json).toEqual({ error: "unavailable" });
    });

    it("when the challenge subkey cannot be derived", async () => {
      const c = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      h.fail.subkey.add("challenge");
      const r = await postVerify(login(c.body), c.cookie);
      expect(r.res.status).toBe(503);
      expect(r.json).toEqual({ error: "unavailable" });
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
      expect(rpc.remaining()).toBe(1);
    });

    it("when the nonce cannot be burned", async () => {
      const c = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      h.fail.db = (_fn, p) => String(p?.bucket).startsWith("auth:nonce:");
      const r = await postVerify(login(c.body), c.cookie);
      expect(r.res.status).toBe(503);
      expect(r.json).toEqual({ error: "unavailable" });
      expect(rpc.remaining()).toBe(1);
    });

    it("when the request body read is aborted", async () => {
      const c = await getChallenge();
      const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode('{"accountId":'));
            return;
          }
          controller.error(new Error("client went away"));
        },
      });
      const req = new Request(`${ORIGIN}/api/auth/verify`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-forwarded-for": nextIp() },
        body,
        duplex: "half",
      } as RequestInit);
      const { res, setCookies } = await run(verifyRoute, req, { [CHALLENGE_COOKIE]: c.cookie });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(setCookieOf(setCookies, SESSION_COOKIE)).toBeUndefined();
      expect(rpc.remaining()).toBe(1);
    });

    it("when no node can be asked", async () => {
      const c = await getChallenge();
      useRpc(httpStatus(503));
      const r = await postVerify(login(c.body), c.cookie);
      expect(r.res.status).toBe(503);
      expect(r.json).toEqual({ error: "unavailable" });
    });

    it("when the RPC client cannot be built (environment)", async () => {
      const c = await getChallenge();
      h.fail.getRpc = true;
      const r = await postVerify(login(c.body), c.cookie);
      expect(r.res.status).toBe(503);
      expect(r.json).toEqual({ error: "unavailable" });
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
    });

    it("when the session subkey cannot be derived after a good signature: no session", async () => {
      const c = await getChallenge();
      useRpc(rpcOk(FULL_ACCESS_KEY));
      h.fail.subkey.add("session");
      const r = await postVerify(login(c.body), c.cookie);
      expect(r.res.status).toBe(503);
      expect(r.json).toEqual({ error: "unavailable" });
      expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
    });

    it("never puts the failure's text, a key or a URL in the response", async () => {
      const c = await getChallenge();
      h.fail.serviceDb = true;
      const r = await postVerify(login(c.body), c.cookie);
      expect(JSON.stringify(r.json)).not.toMatch(/SUPABASE|NEAR_RPC|kdf|db down/);
    });
  });
});

// Fix round 1 (W-NET-R4): before a session is minted, the network's RPC must answer for that network's chain.
describe("sign-in checks that the network's RPC serves its chain", () => {
  const status = (chain_id: unknown) => rpcOk({ chain_id, protocol_version: 73 });
  beforeEach(async () => {
    const { forgetVerifiedChains } = await import("@/lib/near/chain");
    forgetVerifiedChains();
    h.realChain = true;
  });

  it.each([
    [MAINNET_HOST, "mainnet", "testnet"],
    [TESTNET_HOST, "testnet", "mainnet"],
  ] as const)(
    "at %s: an RPC that answers for %s is a 503 wrong_chain, with no session and no key lookup",
    async (host, network, answers) => {
      h.host = host;
      const c = await getChallenge();
      const rpc = useRpc(status(answers), rpcOk(FULL_ACCESS_KEY));
      const { res, json, setCookies } = await postVerify(login(c.body), c.cookie);
      expect(res.status).toBe(503);
      expect(json).toEqual({ error: "wrong_chain" });
      expect(setCookieOf(setCookies, SESSION_COOKIE)).toBeUndefined();
      // Only `status` was asked: the key lookup that would have signed the person in never ran.
      expect(rpc.remaining()).toBe(1);
      expect(rpc.calls).toHaveLength(1);
      // The log names the network, and nothing of the RPC.
      const line = logged.find((l) => l.includes("chain.wrong")) ?? "";
      expect(line).toContain(`"network":"${network}"`);
      expect(logged.join(" | ")).not.toMatch(/a\.example/);
    },
  );

  it("asks `status` once, then remembers the pass for that network: the next sign-in only looks up the key", async () => {
    h.host = MAINNET_HOST;
    const first = await getChallenge();
    const rpc1 = useRpc(status("mainnet"), rpcOk(FULL_ACCESS_KEY));
    expect((await postVerify(login(first.body), first.cookie)).res.status).toBe(200);
    expect(rpc1.remaining()).toBe(0);
    expect(rpc1.calls.map((c) => c.body.method)).toEqual(["status", "query"]);

    const second = await getChallenge();
    const rpc2 = useRpc(rpcOk(FULL_ACCESS_KEY));
    expect((await postVerify(login(second.body), second.cookie)).res.status).toBe(200);
    expect(rpc2.calls.map((c) => c.body.method)).toEqual(["query"]);

    // The other network was not covered by it: its first sign-in asks again, and a wrong answer is refused.
    h.host = TESTNET_HOST;
    const other = await getChallenge();
    const rpc3 = useRpc(status("mainnet"), rpcOk(FULL_ACCESS_KEY));
    const refused = await postVerify(login(other.body), other.cookie);
    expect(refused.json).toEqual({ error: "wrong_chain" });
    expect(rpc3.calls).toHaveLength(1);
  });

  it("answers an unreachable node as it answers any RPC failure (503 unavailable) and does not remember it", async () => {
    h.host = MAINNET_HOST;
    const c = await getChallenge();
    useRpc(httpStatus(503));
    const down = await postVerify(login(c.body), c.cookie);
    expect(down.res.status).toBe(503);
    expect(down.json).toEqual({ error: "unavailable" });
    expect(setCookieOf(down.setCookies, SESSION_COOKIE)).toBeUndefined();
    // The node is back: the next sign-in asks again (status, then the key) and succeeds.
    const again = await getChallenge();
    const rpc = useRpc(status("mainnet"), rpcOk(FULL_ACCESS_KEY));
    expect((await postVerify(login(again.body), again.cookie)).res.status).toBe(200);
    expect(rpc.calls.map((x) => x.body.method)).toEqual(["status", "query"]);
  });

  it("is not asked for a request that has no valid challenge: no chain call, the same 401", async () => {
    h.host = MAINNET_HOST;
    const c = await getChallenge();
    const rpc = useRpc(status("testnet"));
    const { res, json } = await postVerify(login(c.body), undefined);
    expect(res.status).toBe(401);
    expect(json).toEqual({ error: "challenge_missing_or_expired" });
    expect(rpc.calls).toHaveLength(0);
  });
});

// W-NET-R3: the network of a sign-in is the network of the address it is opened at, and nothing else.
describe("sign-in on each network's address (W-NET-R3)", () => {
  it.each([
    [MAINNET_HOST, "mainnet"],
    [TESTNET_HOST, "testnet"],
    ["preview-git-x.vercel.app", "testnet"], // any other address is the default network
  ] as const)(
    "issues the challenge for the network of %s, and mints the session for it",
    async (host, network) => {
      h.host = host;
      h.rpcFor = [];
      const c = await getChallenge();
      const { openChallenge } = await import("./challenge");
      expect(await openChallenge(await challengeKey, c.cookie, network), host).not.toBeNull();
      useRpc(rpcOk(FULL_ACCESS_KEY));
      const { res, setCookies } = await postVerify(login(c.body), c.cookie);
      expect(res.status, host).toBe(200);
      const session = await readSessionToken(
        await sessionKey,
        cookieValue(setCookies, SESSION_COOKIE),
      );
      expect(session?.network, host).toBe(network);
      // The key was checked on that network's chain, and on no other.
      expect(h.rpcFor, host).toEqual([network]);
    },
  );

  it("refuses a challenge from one address at the other, before any chain call", async () => {
    h.host = MAINNET_HOST;
    const c = await getChallenge();
    h.host = TESTNET_HOST;
    h.rpcFor = [];
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const { res, json, setCookies } = await postVerify(login(c.body), c.cookie);
    expect(res.status).toBe(401);
    expect(json).toEqual({ error: "challenge_missing_or_expired" });
    expect(setCookieOf(setCookies, SESSION_COOKIE)).toBeUndefined();
    expect(rpc.remaining()).toBe(1);
    // The mainnet challenge was not burned on the way: it still signs in at its own address.
    h.host = MAINNET_HOST;
    const again = await postVerify(login(c.body), c.cookie);
    expect(again.res.status).toBe(200);
  });
});
