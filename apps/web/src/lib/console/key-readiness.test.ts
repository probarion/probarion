import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import type { KeyRow } from "@/lib/keys/service";
import { readKeyReadiness, readKeySteps, selfHeldKeys } from "./key-readiness";

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

  it("gives the public key of every row, whatever its status, from the same read", async () => {
    const rows = [
      { purpose: "agent", status: "revoked", public_key: "ed25519:a" },
      { purpose: "ledger", status: "active", public_key: "ed25519:l" },
    ] as unknown as KeyRow[];
    expect(await readKeySteps(dbWith(rows), "t")).toEqual({
      readiness: { ok: true, value: { agent: false, ledger: true } },
      known: { ok: true, value: ["ed25519:a", "ed25519:l"] },
    });
    expect(await readKeySteps(dbWith(new Error("db down")), "t")).toEqual({
      readiness: { ok: false, kind: "error" },
      known: { ok: false, kind: "error" },
    });
  });

  it("is a failed read when the rows cannot be listed: never no keys", async () => {
    expect(await readKeyReadiness(dbWith(new Error("db down")), "t")).toEqual({
      ok: false,
      kind: "error",
    });
  });
});

describe("selfHeldKeys: both keys held by the user's own agent", () => {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const down = { ok: false as const, kind: "rpc" as const };
  const agents = (...pks: string[]) => ok(pks.map((public_key) => ({ public_key, label: "x" })));

  it("is yes when the ledger key and an agent key on the vault have no key row here", () => {
    expect(selfHeldKeys(ok([]), "ed25519:L", agents("ed25519:A"))).toEqual(ok(true));
    expect(selfHeldKeys(ok(["ed25519:H"]), "ed25519:L", agents("ed25519:H", "ed25519:A"))).toEqual(
      ok(true),
    );
  });

  it("is no without a ledger key, with a hosted ledger key, or with only hosted agent keys", () => {
    expect(selfHeldKeys(ok([]), null, agents("ed25519:A"))).toEqual(ok(false));
    expect(selfHeldKeys(ok(["ed25519:L"]), "ed25519:L", agents("ed25519:A"))).toEqual(ok(false));
    expect(selfHeldKeys(ok(["ed25519:H"]), "ed25519:L", agents("ed25519:H"))).toEqual(ok(false));
    expect(selfHeldKeys(ok([]), "ed25519:L", agents())).toEqual(ok(false));
  });

  it("is a failed read when the rows or the agent list could not be read, or the list is not one", () => {
    expect(selfHeldKeys({ ok: false, kind: "error" }, "ed25519:L", agents("ed25519:A"))).toEqual({
      ok: false,
      kind: "error",
    });
    expect(selfHeldKeys(ok([]), "ed25519:L", down)).toEqual(down);
    expect(selfHeldKeys(ok([]), "ed25519:L", ok("not a list"))).toEqual({ ok: false, kind: "rpc" });
    // No ledger key is an answer the agent list cannot change.
    expect(selfHeldKeys(ok([]), null, down)).toEqual(ok(false));
  });
});
