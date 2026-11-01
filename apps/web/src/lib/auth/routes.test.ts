import type { PGlite } from "@electric-sql/pglite";
import { KeyPair } from "near-api-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey, macToken, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { LIMITS } from "@/lib/ratelimit";
import { freshDb } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { FULL_ACCESS_KEY, FUNCTION_CALL_KEY, signNep413 } from "../../../test/fixtures/nep413";
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
  rpcCalls: 0,
}));

vi.mock("next/headers", () => ({
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
      sodium.deriveSubkey(master, purpose),
  };
});
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("@/lib/near/server", () => ({ getRpc: () => h.rpc }));

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
  h.db = pgliteDb(pg);
});

afterAll(async () => {
  await pg.close();
});

let logged: string[];
beforeEach(async () => {
  const { NextResponse } = await import("next/server");
  h.out = new NextResponse(null);
  h.sent = new Map();
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
    expect((await openChallenge(await challengeKey, cookie))?.message).toBe(body.message);
    expect(await openChallenge(await sessionKey, cookie)).toBeNull();
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
    const expired = await issueChallenge(await challengeKey, Date.now() - 6 * 60_000);
    const wrongKey = await issueChallenge(await sessionKey);
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
    expect(r.json).toEqual({ error: "verifier_unavailable" });
    expect(setCookieOf(r.setCookies, SESSION_COOKIE)).toBeUndefined();
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

  it("refuses a body far larger than a login", async () => {
    const c = await getChallenge();
    const rpc = useRpc(rpcOk(FULL_ACCESS_KEY));
    const l = login(c.body);
    const r = await postVerify({ ...l, padding: "x".repeat(100_000) }, c.cookie);
    expect(r.res.status).toBe(401);
    expect(r.json).toEqual({ error: "invalid_input" });
    expect(rpc.remaining()).toBe(1);
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
