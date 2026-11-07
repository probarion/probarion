import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { findCanaryTenant, ledgerKeyAllowance } from "./tenant";

const logs = quietLogs();

const VAULT = "canary.vaults.probarion.testnet";
const ROW = {
  tenant_id: "t-1",
  vault_id: VAULT,
  network: "testnet",
  kind: "canary",
  proof_public: false,
};

/** A database whose tenant_by_vault answers `row`, and that records what it was asked. */
function db(row: unknown) {
  const calls: { fn: string; p?: Record<string, unknown> }[] = [];
  const fake: Db = {
    rpc: async <T>(fn: string, p?: Record<string, unknown>) => {
      calls.push({ fn, p });
      return row as T;
    },
  };
  return { fake, calls };
}

describe("findCanaryTenant", () => {
  it("finds the Canary tenant of the vault on the network asked for, by its vault id", async () => {
    const { fake, calls } = db(ROW);
    expect(await findCanaryTenant(fake, VAULT, "testnet")).toEqual({
      ok: true,
      tenant: { tenant_id: "t-1", vault_id: VAULT, network: "testnet" },
    });
    expect(calls).toEqual([{ fn: "tenant_by_vault", p: { vault_id: VAULT } }]);
  });

  it("refuses a vault that is not registered, or is not a Canary tenant", async () => {
    expect(await findCanaryTenant(db(null).fake, VAULT, "testnet")).toEqual({
      ok: false,
      reason: "not_canary",
    });
    expect(await findCanaryTenant(db({ ...ROW, kind: "team" }).fake, VAULT, "testnet")).toEqual({
      ok: false,
      reason: "not_canary",
    });
  });

  it("refuses a Canary vault registered on the other network, and logs it as an error with the context given", async () => {
    const r = await findCanaryTenant(db({ ...ROW, network: "mainnet" }).fake, VAULT, "testnet", {
      request_id: "r-1",
    });
    expect(r).toEqual({ ok: false, reason: "other_network" });
    const line = logs.lines.find((l) => l.includes("canary.vault_on_other_network")) ?? "";
    expect(line).toContain("r-1");
    expect(line).toContain("testnet");
  });

  it("refuses a Canary tenant whose ledger is public, and logs it as an error with the tenant", async () => {
    const r = await findCanaryTenant(db({ ...ROW, proof_public: true }).fake, VAULT, "testnet");
    expect(r).toEqual({ ok: false, reason: "public_ledger" });
    const line = logs.lines.find((l) => l.includes("canary.public_ledger")) ?? "";
    expect(line).toContain("t-1");
  });

  it("lets a failed database read through, for the caller to answer", async () => {
    const failing: Db = { rpc: () => Promise.reject(new Error("db down")) };
    await expect(findCanaryTenant(failing, VAULT, "testnet")).rejects.toThrow("db down");
  });
});

describe("ledgerKeyAllowance", () => {
  const TENANT = { tenant_id: "t-1", vault_id: VAULT, network: "testnet" as const };
  const KEYS = [
    { purpose: "agent", status: "active", public_key: "ed25519:agent" },
    { purpose: "ledger", status: "revoked", public_key: "ed25519:old" },
    { purpose: "ledger", status: "active", public_key: "ed25519:ledger" },
  ];

  it("reads the allowance of the tenant's active ledger key on the vault", async () => {
    const asked: string[][] = [];
    const allowance = await ledgerKeyAllowance(
      async () => KEYS,
      async (account, pk) => {
        asked.push([account, pk]);
        return { exists: true, allowance: "700", kind: "FunctionCall" } as never;
      },
      TENANT,
    );
    expect(allowance).toBe(700n);
    expect(asked).toEqual([[VAULT, "ed25519:ledger"]]);
  });

  it("is null for a key with no limit, and 0 with no active ledger key or a key the chain does not show", async () => {
    const exists = async () => ({ exists: true, allowance: null }) as never;
    expect(await ledgerKeyAllowance(async () => KEYS, exists, TENANT)).toBeNull();
    expect(await ledgerKeyAllowance(async () => KEYS.slice(0, 2), exists, TENANT)).toBe(0n);
    const gone = async () => ({ exists: false, allowance: null }) as never;
    expect(await ledgerKeyAllowance(async () => KEYS, gone, TENANT)).toBe(0n);
  });
});
