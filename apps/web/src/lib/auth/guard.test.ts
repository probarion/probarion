import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey, macToken, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { issueChallenge } from "./challenge";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from "./session";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  calls: [] as { fn: string; p: Record<string, unknown> | undefined }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
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

// Imported after the mocks are registered (vi.mock is hoisted above these anyway).
import { getSession, memberForApi, requireMember, requireSession } from "./guard";

const sessionKey = deriveSubkey(MASTER, "session");
const challengeKey = deriveSubkey(MASTER, "challenge");

let pg: PGlite;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  pg = await freshDb();
  const real = pgliteDb(pg);
  h.db = {
    rpc: (fn, p) => {
      h.calls.push({ fn, p });
      return real.rpc(fn, p);
    },
  };
  // Vault A: alice owns it, bob approves, carol only views. Vault B belongs to mallory alone.
  tenantA = await seedTenant(pg, {
    vault: "vault-a.near",
    owner: "alice.near",
    approvers: ["bob.near"],
  });
  await pg.query(
    `insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'carol.near', 'viewer')`,
    [tenantA],
  );
  tenantB = await seedTenant(pg, { vault: "vault-b.near", owner: "mallory.near" });
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  h.jar.clear();
  h.calls.length = 0;
});

async function signInAs(account: string, now = Date.now()) {
  h.jar.set(SESSION_COOKIE, await createSessionToken(await sessionKey, account, now));
}

/** What a guard threw: the digest Next uses to turn it into a 404 or a redirect. */
async function thrownDigest(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { digest?: unknown }).digest ?? e);
  }
  throw new Error("expected the guard to throw");
}

async function statusOf(r: Response | object): Promise<number | null> {
  return r instanceof Response ? r.status : null;
}

describe("getSession / requireSession", () => {
  it("is null without a cookie, and requireSession redirects to /login", async () => {
    expect(await getSession()).toBeNull();
    expect(await thrownDigest(requireSession())).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
  });

  it("reads a live session cookie", async () => {
    await signInAs("alice.near");
    const s = await getSession();
    expect(s?.accountId).toBe("alice.near");
    expect((await requireSession()).accountId).toBe("alice.near");
  });

  it("rejects an expired session", async () => {
    await signInAs("alice.near", Date.now() - SESSION_TTL_MS - 1000);
    expect(await getSession()).toBeNull();
  });

  it("rejects a cookie that is junk, tampered or empty", async () => {
    h.jar.set(SESSION_COOKIE, "");
    expect(await getSession()).toBeNull();
    h.jar.set(SESSION_COOKIE, "junk");
    expect(await getSession()).toBeNull();
    await signInAs("alice.near");
    h.jar.set(SESSION_COOKIE, `${h.jar.get(SESSION_COOKIE)}x`);
    expect(await getSession()).toBeNull();
  });

  it("does not take a challenge cookie for a session, under either key or payload", async () => {
    // a real challenge cookie, put where a session belongs
    const { cookie } = await issueChallenge(await challengeKey);
    h.jar.set(SESSION_COOKIE, cookie);
    expect(await getSession()).toBeNull();
    // sealed under the challenge key with a session payload
    h.jar.set(
      SESSION_COOKIE,
      await macToken(await challengeKey, {
        typ: "session",
        v: 1,
        a: "alice.near",
        exp: Date.now() + 60_000,
      }),
    );
    expect(await getSession()).toBeNull();
    // sealed under the session key with a challenge payload and an account
    h.jar.set(
      SESSION_COOKIE,
      await macToken(await sessionKey, {
        typ: "challenge",
        v: 1,
        a: "alice.near",
        exp: Date.now() + 60_000,
      }),
    );
    expect(await getSession()).toBeNull();
  });
});

describe("memberForApi", () => {
  it("answers 401 without a session, and does not touch the database", async () => {
    const r = await memberForApi("vault-a.near");
    expect(r).toBeInstanceOf(Response);
    expect(await statusOf(r)).toBe(401);
    expect(await (r as Response).json()).toEqual({ error: "unauthenticated" });
    expect(h.calls).toEqual([]);
  });

  it("gives a member their tenant and role, read from the database", async () => {
    await signInAs("alice.near");
    const r = await memberForApi("vault-a.near");
    expect(r).not.toBeInstanceOf(Response);
    const ok = r as Exclude<typeof r, Response>;
    expect(ok.session.accountId).toBe("alice.near");
    expect(ok.member.tenant_id).toBe(tenantA);
    expect(ok.member.vault_id).toBe("vault-a.near");
    expect(ok.member.role).toBe("owner");
    await signInAs("bob.near");
    const b = (await memberForApi("vault-a.near")) as Exclude<Response | object, Response> & {
      member: { role: string };
    };
    expect(b.member.role).toBe("approver");
  });

  it("answers 403 to a session whose account is not a member of that vault (tenant isolation)", async () => {
    await signInAs("alice.near"); // owner of vault A, nothing at vault B
    const r = await memberForApi("vault-b.near");
    expect(r).toBeInstanceOf(Response);
    expect(await statusOf(r)).toBe(403);
    expect(await (r as Response).json()).toEqual({ error: "forbidden" });
    // the other direction too
    await signInAs("mallory.near");
    expect(await statusOf(await memberForApi("vault-a.near"))).toBe(403);
    // and the right vault still works for its own owner
    expect(await statusOf(await memberForApi("vault-b.near"))).toBeNull();
    expect(tenantB).not.toBe(tenantA);
  });

  it("answers the same 403 for a vault that does not exist, so ids are not confirmed", async () => {
    await signInAs("alice.near");
    const missing = await memberForApi("no-such-vault.near");
    const other = await memberForApi("vault-b.near");
    expect(await statusOf(missing)).toBe(403);
    expect(await (missing as Response).text()).toBe(await (other as Response).text());
  });

  it("filters by role: an allow-list that does not hold the member's role is 403", async () => {
    await signInAs("carol.near");
    expect(await statusOf(await memberForApi("vault-a.near"))).toBeNull();
    expect(await statusOf(await memberForApi("vault-a.near", ["owner", "approver"]))).toBe(403);
    expect(await statusOf(await memberForApi("vault-a.near", ["viewer"]))).toBeNull();
    await signInAs("bob.near");
    expect(await statusOf(await memberForApi("vault-a.near", ["owner"]))).toBe(403);
    expect(await statusOf(await memberForApi("vault-a.near", ["owner", "approver"]))).toBeNull();
    await signInAs("alice.near");
    expect(await statusOf(await memberForApi("vault-a.near", ["owner"]))).toBeNull();
    // an empty allow-list lets nobody in
    expect(await statusOf(await memberForApi("vault-a.near", []))).toBe(403);
  });

  it("takes the role from the database, not from the token", async () => {
    // Only a holder of the key can make this token. It shows what happens if one ever carries extra fields.
    h.jar.set(
      SESSION_COOKIE,
      await macToken(await sessionKey, {
        typ: "session",
        v: 1,
        a: "carol.near",
        exp: Date.now() + 60_000,
        role: "owner",
        tenant_id: tenantB,
        t: tenantB,
        vault: "vault-b.near",
      }),
    );
    const r = (await memberForApi("vault-a.near")) as {
      member: { role: string; tenant_id: string };
    };
    expect(r.member.role).toBe("viewer");
    expect(r.member.tenant_id).toBe(tenantA);
    expect(await statusOf(await memberForApi("vault-b.near"))).toBe(403);
    expect(await statusOf(await memberForApi("vault-a.near", ["owner"]))).toBe(403);
  });

  it("checks membership on every request: removing a member takes effect at once", async () => {
    await pg.query(
      `insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'dave.near', 'approver')`,
      [tenantA],
    );
    await signInAs("dave.near");
    expect(await statusOf(await memberForApi("vault-a.near"))).toBeNull();
    await pg.query(
      `delete from public.tenant_members where tenant_id = $1 and account_id = 'dave.near'`,
      [tenantA],
    );
    expect(await statusOf(await memberForApi("vault-a.near"))).toBe(403);
  });

  it("refuses an id that is not a NEAR account without asking the database", async () => {
    await signInAs("alice.near");
    for (const bad of [
      "",
      "Vault-A.near",
      "vault-a.near ",
      "' or true --",
      "x".repeat(5000),
      "../vault-a.near",
    ]) {
      expect(await statusOf(await memberForApi(bad)), JSON.stringify(bad.slice(0, 30))).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it("answers 401 for an expired or foreign session, never 403 or the member", async () => {
    await signInAs("alice.near", Date.now() - SESSION_TTL_MS - 1000);
    expect(await statusOf(await memberForApi("vault-a.near"))).toBe(401);
    const { cookie } = await issueChallenge(await challengeKey);
    h.jar.set(SESSION_COOKIE, cookie);
    expect(await statusOf(await memberForApi("vault-a.near"))).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe("requireMember", () => {
  it("redirects to /login without a session", async () => {
    expect(await thrownDigest(requireMember("vault-a.near"))).toMatch(
      /^NEXT_REDIRECT;[a-z]+;\/login;/,
    );
    expect(h.calls).toEqual([]);
  });

  it("returns the session and the member for a member", async () => {
    await signInAs("bob.near");
    const { session, member } = await requireMember("vault-a.near");
    expect(session.accountId).toBe("bob.near");
    expect(member.tenant_id).toBe(tenantA);
    expect(member.role).toBe("approver");
  });

  it("shows a stranger a 404, as if the vault were not there", async () => {
    await signInAs("alice.near");
    expect(await thrownDigest(requireMember("vault-b.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await thrownDigest(requireMember("no-such-vault.near"))).toBe(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
  });

  it("shows a 404 to a member whose role is not allowed", async () => {
    await signInAs("carol.near");
    expect(await thrownDigest(requireMember("vault-a.near", ["owner"]))).toBe(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
    const { member } = await requireMember("vault-a.near", ["viewer", "owner"]);
    expect(member.role).toBe("viewer");
  });

  it("refuses an id that is not a NEAR account without asking the database", async () => {
    await signInAs("alice.near");
    expect(await thrownDigest(requireMember("x".repeat(500)))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(h.calls).toEqual([]);
  });
});
