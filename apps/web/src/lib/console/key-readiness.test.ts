import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import type { KeyRow } from "@/lib/keys/service";
import { readKeyReadiness } from "./key-readiness";

// The checklist's keys step (site audit P1-8) reads the console's own key rows, as Payables does: it runs an invoice
// only with an active agent key and an active ledger key.

const row = (purpose: KeyRow["purpose"], status: KeyRow["status"]) =>
  ({ purpose, status }) as unknown as KeyRow;
const dbWith = (rows: KeyRow[] | Error) =>
  ({
    rpc: async (fn: string) => {
      if (fn !== "agent_key_list") throw new Error(`unexpected ${fn}`);
      if (rows instanceof Error) throw rows;
      return rows;
    },
  }) as unknown as Db;

describe("readKeyReadiness", () => {
  it("says which of the two the console holds active", async () => {
    expect(await readKeyReadiness(dbWith([]), "t")).toEqual({
      ok: true,
      value: { agent: false, ledger: false },
    });
    expect(
      await readKeyReadiness(dbWith([row("agent", "active"), row("ledger", "active")]), "t"),
    ).toEqual({ ok: true, value: { agent: true, ledger: true } });
  });

  it("does not count a key that is pending, revoked or removed", async () => {
    const rows = [
      row("agent", "pending"),
      row("agent", "revoked"),
      row("ledger", "removed"),
      row("ledger", "pending"),
    ];
    expect(await readKeyReadiness(dbWith(rows), "t")).toEqual({
      ok: true,
      value: { agent: false, ledger: false },
    });
  });

  it("is a failed read when the rows cannot be listed: never no keys", async () => {
    expect(await readKeyReadiness(dbWith(new Error("db down")), "t")).toEqual({
      ok: false,
      kind: "error",
    });
  });
});
