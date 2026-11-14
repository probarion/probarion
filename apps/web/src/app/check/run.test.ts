// /check's one run, over a scripted chain (test/fixtures/payee-chain.ts: no socket is opened): the reads the browser
// makes, the hosts it records, and above all the rule the page lives by. A read that fails is unknown and warns, and a
// check that throws is a failed run: neither is ever an allow.
import type { NetworkId, PayeeRef } from "@probarion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_A,
  MAINNET_HISTORY,
  NO_CODE,
  rateLimited,
  scriptedChain,
  unreachable,
} from "../../../test/fixtures/payee-chain";

const sdk = vi.hoisted(() => ({ throwNext: null as Error | null }));
vi.mock("@probarion/sdk/payee", async (importOriginal) => {
  const real = await importOriginal<typeof import("@probarion/sdk/payee")>();
  return {
    ...real,
    readPayeeSignals: (...args: Parameters<typeof real.readPayeeSignals>) => {
      const error = sdk.throwNext;
      sdk.throwNext = null;
      return error === null ? real.readPayeeSignals(...args) : Promise.reject(error);
    },
  };
});

import { POISONED_BASE, readRows } from "./check-view";
import { type DoneRun, runCheck } from "./run";

const VAULT = "v0.probarion.near";
const DUONG: PayeeRef = { chain: "near", address: "probarion-duong.near" };
const BASE: PayeeRef = { chain: "base", address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27" };
/** Short limits, so a run over a node that never answers ends quickly here. */
const FAST = { timeoutMs: 50, budgetMs: 400 };

let clock = 0;
const deps = (fetch: typeof globalThis.fetch) => ({ fetch, now: () => (clock += 5) });

async function done(
  payee: PayeeRef,
  fetch: typeof globalThis.fetch,
  opts: { network?: NetworkId; vault?: string } = {},
): Promise<DoneRun> {
  const input = {
    network: opts.network ?? "mainnet",
    payee,
    ...(opts.vault === undefined ? {} : { vault: opts.vault }),
  };
  const run = await runCheck(input, deps(fetch), FAST);
  if (run.kind !== "done") throw new Error(`run failed: ${run.message}`);
  return run;
}

afterEach(() => {
  sdk.throwNext = null;
});

describe("a check, read through the browser's fetch", () => {
  it("allows a payee the vault paid before, whose account is old and plain, and says where each read came from", async () => {
    const chain = scriptedChain({
      accounts: { "probarion-duong.near": NO_CODE },
      ...MAINNET_HISTORY,
    });
    const run = await done(DUONG, chain.fetch, { vault: VAULT });
    expect(run.assessment.verdict).toBe("allow");
    expect(run.assessment.reasons.map((r) => r.id)).toEqual([
      "not_blocklisted",
      "no_lookalike",
      "paid_before",
      "found",
      "no_contract",
      "older_than_7d",
      "code_unchanged_7d",
    ]);
    // Every request is written down, with the default public hosts the page names.
    expect(run.log).toHaveLength(chain.calls.length);
    const hosts = new Set(run.log.map((e) => e.host));
    expect(hosts).toEqual(
      new Set(["rpc.mainnet.fastnear.com", "archival-rpc.mainnet.fastnear.com"]),
    );
    expect(run.log.every((e) => e.answer === "HTTP 200")).toBe(true);
    const rows = readRows(run.input, run.signals, run.assessment, run.log);
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["blocklist", "read"],
      ["account_now", "read"],
      ["account_past", "read"],
      ["history", "read"],
    ]);
    expect(rows.find((r) => r.id === "account_past")?.from).toEqual([
      "rpc.mainnet.fastnear.com",
      "archival-rpc.mainnet.fastnear.com",
    ]);
    expect(rows.find((r) => r.id === "history")?.value).toBe("2 payees in its mandates and spends");
  });

  it("blocks a name one edit from mandate 1's payee, which no one holds", async () => {
    const chain = scriptedChain({
      accounts: { "probarion-duong.near": NO_CODE },
      ...MAINNET_HISTORY,
    });
    const run = await done({ chain: "near", address: "probarion-duonq.near" }, chain.fetch, {
      vault: VAULT,
    });
    expect(run.assessment.verdict).toBe("block");
    const ids = run.assessment.reasons.map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual(["lookalike", "not_found"]);
    expect(run.assessment.reasons[0]?.text).toContain("the payee of mandate 1 (one edit apart)");
    const rows = readRows(run.input, run.signals, run.assessment, run.log);
    expect(rows.find((r) => r.id === "account_past")).toMatchObject({
      state: "not_read",
      value: "not used: there is no account now",
    });
  });

  it("warns on a new account with code, and on a code change, from the archival read", async () => {
    const fresh = scriptedChain({ accounts: { "vendor.near": CODE_A }, weekAgo: {} });
    const a = await done({ chain: "near", address: "vendor.near" }, fresh.fetch, { vault: VAULT });
    expect(a.assessment.verdict).toBe("warn");
    expect(a.assessment.reasons.map((r) => r.id)).toEqual(
      expect.arrayContaining(["contract", "new_7d", "first_payment"]),
    );
    const changed = scriptedChain({
      accounts: { "vendor.near": CODE_A },
      weekAgo: { "vendor.near": NO_CODE },
    });
    const b = await done({ chain: "near", address: "vendor.near" }, changed.fetch, {
      vault: VAULT,
    });
    expect(b.assessment.reasons.map((r) => r.id)).toContain("code_changed_7d");
  });

  it("reads Base on mainnet from mainnet.base.org, and blocks a poisoned address beside the vault's Base payee", async () => {
    const chain = scriptedChain({
      accounts: {},
      ...MAINNET_HISTORY,
      base: { [BASE.address.toLowerCase()]: { code: "0x", nonce: "0x5" } },
    });
    const real = await done(BASE, chain.fetch, { vault: VAULT });
    expect(real.assessment.verdict).toBe("allow");
    expect(real.assessment.reasons.find((r) => r.id === "paid_before")?.text).toContain("2 times");
    const baseHosts = real.log.filter((e) => e.call.startsWith("eth_")).map((e) => e.host);
    expect(new Set(baseHosts)).toEqual(new Set(["mainnet.base.org"]));
    const poisoned = await done({ chain: "base", address: POISONED_BASE }, chain.fetch, {
      vault: VAULT,
    });
    expect(poisoned.assessment.verdict).toBe("block");
    expect(poisoned.assessment.reasons[0]).toMatchObject({ id: "lookalike", level: "block" });
    expect(poisoned.assessment.reasons[0]?.text).toContain(
      "the same first 4 and last 4 hex characters",
    );
  });

  it("blocks a name on the seed blocklist, and warns that no vault was given", async () => {
    const chain = scriptedChain({ accounts: {} });
    const run = await done({ chain: "near", address: "attacker-eval.testnet" }, chain.fetch, {
      network: "testnet",
    });
    expect(run.assessment.verdict).toBe("block");
    expect(run.assessment.reasons[0]).toMatchObject({ id: "blocklisted", level: "block" });
    expect(run.assessment.reasons[0]?.evidence).toMatch(
      /^https:\/\/github\.com\/probarion\/probarion\//,
    );
    expect(run.assessment.reasons.map((r) => r.id)).toContain("history_not_checked");
    const rows = readRows(run.input, run.signals, run.assessment, run.log);
    expect(rows[0]).toMatchObject({ id: "blocklist", value: "listed" });
    expect(rows.find((r) => r.id === "history")).toMatchObject({ state: "not_read" });
    expect(new Set(run.log.map((e) => e.host))).toEqual(
      new Set(["rpc.testnet.fastnear.com", "archival-rpc.testnet.fastnear.com"]),
    );
  });
});

describe("reads the browser cannot make", () => {
  it("are unknown when no node answers, so a payee with every check unread warns and never allows", async () => {
    for (const fetch of [unreachable, rateLimited]) {
      const run = await done(DUONG, fetch, { vault: VAULT });
      expect(run.assessment.verdict).toBe("warn");
      expect(run.assessment.reasons.filter((r) => r.level === "warn").map((r) => r.id)).toEqual([
        "history_unknown",
        "exists_unknown",
        "contract_unknown",
        "age_unknown",
        "code_change_unknown",
      ]);
      const rows = readRows(run.input, run.signals, run.assessment, run.log);
      expect(rows.filter((r) => r.id !== "blocklist").map((r) => r.state)).toEqual([
        "unknown",
        "unknown",
        "unknown",
      ]);
      for (const r of rows.filter((x) => x.id !== "blocklist")) expect(r.value).toMatch(/^unknown/);
      expect(run.log.length).toBeGreaterThan(0);
      expect(run.log.every((e) => e.answer !== "HTTP 200")).toBe(true);
    }
    const blocked = await done(DUONG, unreachable);
    expect(blocked.log[0]?.answer).toBe("no answer (network or CORS error)");
    const limited = await done(DUONG, rateLimited);
    expect(limited.log[0]?.answer).toBe("HTTP 429");
  });

  it("are unknown for Base on testnet, with no request sent, and for Solana", async () => {
    const chain = scriptedChain();
    const base = await done(BASE, chain.fetch, { network: "testnet" });
    expect(base.assessment.verdict).toBe("warn");
    expect(base.log.filter((e) => e.call.startsWith("eth_"))).toEqual([]);
    const rows = readRows(base.input, base.signals, base.assessment, base.log);
    expect(rows.find((r) => r.id === "base_code")).toMatchObject({
      state: "unknown",
      value: "unknown: no Base RPC is mapped for testnet",
      from: [],
    });
    const sol = await done(
      { chain: "solana", address: "So11111111111111111111111111111111111111112" },
      chain.fetch,
    );
    expect(sol.assessment.verdict).toBe("warn");
    expect(
      readRows(sol.input, sol.signals, sol.assessment, sol.log).find((r) => r.id === "solana"),
    ).toMatchObject({
      state: "unknown",
      value: "unknown: Solana accounts are not read",
    });
  });

  it("come back as a failed run when the reads throw anyway, with what was sent so far", async () => {
    sdk.throwNext = new Error("a bug in the reads");
    const run = await runCheck(
      { network: "mainnet", payee: DUONG },
      deps(scriptedChain().fetch),
      FAST,
    );
    expect(run).toMatchObject({ kind: "failed", message: "a bug in the reads", log: [] });
    expect("assessment" in run).toBe(false);
  });
});
