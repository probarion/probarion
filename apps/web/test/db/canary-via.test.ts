import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CANARY_VIA } from "@/lib/canary/via";
import type { Db } from "@/lib/db/port";
import { freshDb } from "./harness";
import { at } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// Where a Canary visitor came from (migration 0014, site audit P1-17): one short word per attempt, from the link the
// visitor followed, never shown in public.

const H = (c: string) => c.repeat(64);

describe("canary_attempts.via (migration 0014)", () => {
  let pg: PGlite;
  let service: Db;
  let anon: Db;

  beforeAll(async () => {
    pg = await freshDb();
    service = pgliteDb(pg);
    anon = pgliteDb(pg, "anon");
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec("truncate public.canary_attempts");
  });

  let n = 0;
  const attempt = (over: Record<string, unknown> = {}) => {
    n += 1;
    return service.rpc<{ id: string }>("canary_attempt_insert", {
      visitor_hash: H("1"),
      ip_hash: H("2"),
      mode: "live",
      text_sha256: n.toString(16).padStart(64, "0"),
      text_length: 10,
      code_status: "refused_by_code",
      request_id: "r",
      network: "mainnet",
      ...over,
    });
  };
  const vias = async () =>
    (
      await pg.query<{ via: string | null }>("select via from canary_attempts order by created_at")
    ).rows.map((r) => r.via);

  it("stores the source the attempt came with, and none when it came with none", async () => {
    await attempt({ via: "x" });
    await attempt({ via: "readme" });
    await attempt();
    await attempt({ via: null });
    expect(await vias()).toEqual(["x", "readme", null, null]);
  });

  it("accepts every source the app knows", async () => {
    for (const via of CANARY_VIA) await attempt({ via });
    expect(await vias()).toEqual([...CANARY_VIA]);
  });

  it("refuses anything but a short lowercase word, so no visitor's text can land in it", async () => {
    for (const via of ["", "X", "x y", "x\n", "a".repeat(17), "x1", "pay-me", "😀"]) {
      await expect(attempt({ via }), JSON.stringify(via)).rejects.toThrow();
    }
    expect(await vias()).toEqual([]);
  });

  it("keeps what 0009 checks: an attempt still needs its network", async () => {
    await expect(attempt({ via: "x", network: undefined })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("is never changed by the update that records the outcome", async () => {
    const { id } = await attempt({ via: "x" });
    await service.rpc("canary_attempt_update", {
      id,
      code_status: "refused_by_contract",
      contract_status: "refused_by_contract",
      contract_code: "NoMandate",
      via: "readme",
    });
    expect(await vias()).toEqual(["x"]);
  });

  it("is not in the public feed, and the leaderboard does not split by it", async () => {
    await attempt({ via: "readme" });
    const feed = await anon.rpc<Record<string, unknown>[]>("public_canary_feed", {
      network: "mainnet",
    });
    expect(Object.keys(at(feed))).not.toContain("via");
    expect(JSON.stringify(feed)).not.toContain("readme");
    const board = await service.rpc<Record<string, unknown>>("public_canary_leaderboard", {
      network: "mainnet",
    });
    expect(JSON.stringify(board)).not.toContain("readme");
    expect(JSON.stringify(board)).not.toContain("via");
  });
});
