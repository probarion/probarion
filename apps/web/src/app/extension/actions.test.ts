import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { exchangePairCode, listTokens, useToken } from "@/lib/ext/store";
import { codeHash, newToken, readPairCode, tokenHash } from "@/lib/ext/token";
import { freshDb } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  session: null as null | { accountId: string; network: "mainnet" | "testnet"; exp: number },
}));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/console/action-auth", () => ({
  sessionForAction: async () =>
    h.session ?? { error: "Your session ended. Sign in again.", status: 401 },
  isDenied: (v: unknown) => typeof v === "object" && v !== null && "status" in v,
}));

const { connectExtensionAction, revokeExtensionAction, showPairCodeAction } = await import(
  "./actions"
);

const A = "alice.testnet";

describe("the /extension page's actions", () => {
  quietLogs();
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    h.db = pgliteDb(pg);
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec(
      "delete from public.extension_tokens; delete from public.extension_pair_codes; delete from public.rate_limits;",
    );
    h.session = { accountId: A, network: "testnet", exp: Date.now() + 3_600_000 };
  });

  it("mints a token for the signed-in account on its network, with a clean label", async () => {
    const r = await connectExtensionAction("Chrome on Windows\u202E");
    if ("error" in r) throw new Error(r.error);
    expect(r).toMatchObject({ account: A, network: "testnet" });
    expect(await useToken(h.db, tokenHash(r.token), "testnet")).toMatchObject({ account_id: A });
    expect((await listTokens(h.db, A, "testnet"))[0]?.label).toBe("Chrome on Windows");
  });

  it("shows a code that exchanges for a token of the same account", async () => {
    const r = await showPairCodeAction();
    if ("error" in r) throw new Error(r.error);
    expect(r.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const t = newToken();
    const ex = await exchangePairCode(h.db, {
      codeSha256: codeHash(readPairCode(r.code) ?? ""),
      network: "testnet",
      sha256: t.sha256,
      hint: t.hint,
      label: "x",
    });
    expect(ex).toMatchObject({ ok: true, account_id: A });
  });

  it("revokes only a well-formed id of the account's own", async () => {
    const r = await connectExtensionAction("x");
    if ("error" in r) throw new Error(r.error);
    const [item] = await listTokens(h.db, A, "testnet");
    expect(await revokeExtensionAction("not-an-id")).toEqual({ error: "No such browser." });
    expect(await revokeExtensionAction(item?.id)).toEqual({ ok: true });
    expect(await useToken(h.db, tokenHash(r.token), "testnet")).toBeNull();
  });

  it("does nothing signed out, and limits minting per account", async () => {
    h.session = null;
    expect(await connectExtensionAction("x")).toEqual({
      error: "Your session ended. Sign in again.",
    });
    h.session = { accountId: A, network: "testnet", exp: Date.now() + 3_600_000 };
    for (let i = 0; i < 10; i++) expect("token" in (await connectExtensionAction("x"))).toBe(true);
    expect(await connectExtensionAction("x")).toEqual({
      error: "Too many tries. Wait ten minutes, then try again.",
    });
  });
});
