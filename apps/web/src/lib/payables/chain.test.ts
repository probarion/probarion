import type { SpendView } from "@probarion/core";
import { describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";
import { fakeReader } from "../../../test/fixtures/reader";
import { readSpendsNow } from "./chain";

// What Payables reads from the chain to show a held spend as it is now: the vault's spends, by the same paged
// list_spends view the overview reads, and never a write.

const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

const spend = (id: number, status: SpendView["status"]): SpendView => ({
  id,
  mandate_id: 1,
  amount: "4000000",
  invoice_hash: "a".repeat(64),
  ref: `inv-${id}`,
  decision_hash: "d".repeat(64),
  agent_pk: "ed25519:x",
  destination: { type: "near", account_id: "payee.near" },
  status,
  created_at_ns: "1",
  held_until_ns: null,
  memo: null,
});

describe("readSpendsNow", () => {
  it("reads every page of the vault's spends and keys them by id", async () => {
    const all = Array.from({ length: 120 }, (_, i) => spend(i + 1, i === 2 ? "paid" : "held"));
    const calls: [string, number, number][] = [];
    const reader = fakeReader({
      listSpends: async (vault, from, limit) => {
        calls.push([vault, from, limit]);
        return all.slice(from, from + limit);
      },
    });
    const now = await readSpendsNow(reader, "demo.vaults.probarion.testnet");
    if (now === "unread") throw new Error("unread");
    expect(now.size).toBe(120);
    expect(now.get(3)?.status).toBe("paid");
    expect(calls.every(([v]) => v === "demo.vaults.probarion.testnet")).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("says the spends are unread, and logs why, when the chain does not answer", async () => {
    const reader = fakeReader({ listSpends: () => Promise.reject(new Error("no node")) });
    expect(await readSpendsNow(reader, "v.near")).toBe("unread");
    expect(warn).toHaveBeenCalledWith(
      "payables.spends_unavailable",
      expect.objectContaining({ vault: "v.near", error: "no node" }),
    );
  });
});
