import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPairCode,
  exchangePairCode,
  listTokens,
  mintToken,
  revokeToken,
  useToken,
} from "@/lib/ext/store";
import { codeHash, newToken } from "@/lib/ext/token";
import { asRole, freshDb } from "./harness";
import { pgliteDb } from "./pglite-db";

// Migration 0013: the extension's tokens and pairing codes, called as the app calls them.
const A = "alice.testnet";
const B = "bob.testnet";

describe("migration 0013: extension tokens and pairing codes", () => {
  let pg: PGlite;
  const db = () => pgliteDb(pg);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec("delete from public.extension_tokens; delete from public.extension_pair_codes;");
  });

  async function mint(account = A, network: "mainnet" | "testnet" = "testnet") {
    const t = newToken();
    const r = await mintToken(db(), {
      account,
      network,
      sha256: t.sha256,
      hint: t.hint,
      label: "Chrome on Windows",
    });
    return { ...t, ...r };
  }

  it("finds a live token by its hash, on its own network only, for 30 days", async () => {
    const t = await mint();
    expect(await useToken(db(), t.sha256, "testnet")).toMatchObject({
      id: t.id,
      account_id: A,
      network: "testnet",
    });
    expect(await useToken(db(), t.sha256, "mainnet")).toBeNull();
    const days = (Date.parse(t.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const stored = await pg.query<{ token_sha256: string }>(
      "select token_sha256 from public.extension_tokens",
    );
    expect(stored.rows).toEqual([{ token_sha256: t.sha256 }]);
  });

  it("is not found once revoked or expired", async () => {
    const t = await mint();
    expect(await revokeToken(db(), A, "testnet", t.id)).toEqual({ revoked: true });
    expect(await useToken(db(), t.sha256, "testnet")).toBeNull();
    const u = await mint();
    await pg.query(
      "update public.extension_tokens set expires_at = now() - interval '1 second' where id = $1",
      [u.id],
    );
    expect(await useToken(db(), u.sha256, "testnet")).toBeNull();
  });

  it("records its use at most once a minute", async () => {
    const t = await mint();
    const last = async () =>
      (
        await pg.query<{ at: string | null }>(
          "select last_used_at::text as at from public.extension_tokens where id = $1",
          [t.id],
        )
      ).rows[0]?.at;
    await useToken(db(), t.sha256, "testnet");
    expect(await last()).not.toBeNull();
    await pg.query(
      "update public.extension_tokens set last_used_at = now() - interval '30 seconds' where id = $1",
      [t.id],
    );
    const recent = await last();
    await useToken(db(), t.sha256, "testnet");
    expect(await last()).toBe(recent);
    await pg.query(
      "update public.extension_tokens set last_used_at = now() - interval '2 minutes' where id = $1",
      [t.id],
    );
    const old = await last();
    await useToken(db(), t.sha256, "testnet");
    expect(await last()).not.toBe(old);
  });

  it("keeps at most five live tokens per account and network", async () => {
    const first = await mint();
    for (let i = 0; i < 5; i++) await mint();
    await mint(A, "mainnet");
    const live = await listTokens(db(), A, "testnet");
    expect(live).toHaveLength(5);
    expect(live.map((x) => x.id)).not.toContain(first.id);
    expect(await useToken(db(), first.sha256, "testnet")).toBeNull();
    expect(await listTokens(db(), A, "mainnet")).toHaveLength(1);
  });

  it("lists the account's own live tokens, newest first, without any hash", async () => {
    const older = await mint();
    const newer = await mint();
    await mint(B);
    const ended = await mint();
    await revokeToken(db(), A, "testnet", ended.id);
    const list = await listTokens(db(), A, "testnet");
    expect(list.map((x) => x.id)).toEqual([newer.id, older.id]);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual([
      "created_at",
      "expires_at",
      "hint",
      "id",
      "label",
      "last_used_at",
    ]);
  });

  it("revokes only the caller's own token", async () => {
    const theirs = await mint(B);
    expect(await revokeToken(db(), A, "testnet", theirs.id)).toEqual({ revoked: false });
    expect(await useToken(db(), theirs.sha256, "testnet")).not.toBeNull();
  });

  it("refuses malformed input", async () => {
    const t = newToken();
    const base = {
      account: A,
      network: "testnet" as const,
      sha256: t.sha256,
      hint: t.hint,
      label: "x",
    };
    for (const bad of [
      { ...base, sha256: "x" },
      { ...base, hint: "!!!!" },
      { ...base, label: "" },
      { ...base, label: "y".repeat(65) },
      { ...base, account: "" },
    ]) {
      await expect(mintToken(db(), bad)).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      db().rpc("ext_token_use", { token_sha256: t.sha256, network: "devnet" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("pairing codes", () => {
    const CODE = "K7QM4XRA";

    it("exchange once for a token of the code's account and network", async () => {
      await createPairCode(db(), A, "testnet", codeHash(CODE));
      const t = newToken();
      const r = await exchangePairCode(db(), {
        codeSha256: codeHash(CODE),
        network: "testnet",
        sha256: t.sha256,
        hint: t.hint,
        label: "Chrome on Windows",
      });
      expect(r).toMatchObject({ ok: true, account_id: A, network: "testnet" });
      expect(await useToken(db(), t.sha256, "testnet")).toMatchObject({ account_id: A });
      const u = newToken();
      expect(
        await exchangePairCode(db(), {
          codeSha256: codeHash(CODE),
          network: "testnet",
          sha256: u.sha256,
          hint: u.hint,
          label: "again",
        }),
      ).toEqual({ ok: false });
    });

    it("do not exchange after ten minutes or on the other network", async () => {
      await createPairCode(db(), A, "testnet", codeHash(CODE));
      const t = newToken();
      const ex = (network: "mainnet" | "testnet") =>
        exchangePairCode(db(), {
          codeSha256: codeHash(CODE),
          network,
          sha256: t.sha256,
          hint: t.hint,
          label: "x",
        });
      expect(await ex("mainnet")).toEqual({ ok: false });
      await pg.query(
        "update public.extension_pair_codes set expires_at = now() - interval '1 second'",
      );
      expect(await ex("testnet")).toEqual({ ok: false });
    });

    it("keep at most three open codes per account and network", async () => {
      for (const c of ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "DDDDDDDD"]) {
        await createPairCode(db(), A, "testnet", codeHash(c));
      }
      const t = newToken();
      const ex = (c: string) =>
        exchangePairCode(db(), {
          codeSha256: codeHash(c),
          network: "testnet",
          sha256: newToken().sha256,
          hint: t.hint,
          label: "x",
        });
      expect(await ex("AAAAAAAA")).toEqual({ ok: false });
      expect(await ex("DDDDDDDD")).toMatchObject({ ok: true });
    });

    it("are not used up when the token cannot be minted", async () => {
      await createPairCode(db(), A, "testnet", codeHash(CODE));
      await expect(
        exchangePairCode(db(), {
          codeSha256: codeHash(CODE),
          network: "testnet",
          sha256: "bad",
          hint: "abcd",
          label: "x",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      const t = newToken();
      expect(
        await exchangePairCode(db(), {
          codeSha256: codeHash(CODE),
          network: "testnet",
          sha256: t.sha256,
          hint: t.hint,
          label: "x",
        }),
      ).toMatchObject({ ok: true });
    });
  });

  it("takes a lock per account and network before it counts live tokens or open codes", () => {
    // PGlite has one connection, so the race cannot run here: the lock is pinned in the source instead.
    const sql = readFileSync(
      fileURLToPath(
        new URL("../../supabase/migrations/20261108000013_extension_tokens.sql", import.meta.url),
      ),
      "utf8",
    );
    for (const kind of ["token", "code"]) {
      expect(sql, kind).toContain(
        `pg_advisory_xact_lock(hashtextextended('probarion/ext/${kind}/' || v_account || '/' || v_network, 0))`,
      );
    }
  });

  it("are the service role's alone", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(pg, role, A, (tx) => tx.query("select * from public.extension_tokens")),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pgliteDb(pg, role, A).rpc("ext_token_list", { account_id: A, network: "testnet" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
  });
});
