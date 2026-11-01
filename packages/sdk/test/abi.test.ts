import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FactoryClient } from "../src/factory-client.js";
import { IntentsClient } from "../src/intents-client.js";
import { isSpendResult, MAX_PAGE_LIMIT, VaultClient } from "../src/vault-client.js";
import { fakeSender, okOutcome, ROOT, request, VAULT, viewRpc } from "./helpers/client-fakes.js";

// The Rust contracts are the ABI. These tests read their source and check that every method the
// clients call exists, takes exactly the arguments the client sends, and is not payable (a
// function-call key cannot attach a deposit, so a payable method must never be the agent's or the
// ledger's call).
const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));

function source(crate: string): string {
  const dir = join(CONTRACTS, crate, "src");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".rs") && file !== "test_utils.rs" && file !== "tests.rs")
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}

const VAULT_RS = source("vault");
const FACTORY_RS = source("factory");
const INTENTS_RS = source("intents-stub");

interface RustMethod {
  params: string[];
  mutates: boolean;
  payable: boolean;
}

function rustMethod(src: string, name: string): RustMethod | null {
  const match = new RegExp(`pub fn ${name}\\(([^)]*)\\)`).exec(src);
  if (match === null) return null;
  const parts = (match[1] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const params = parts
    .filter((part) => !part.startsWith("&"))
    .map((part) => (part.split(":")[0] ?? "").trim().replace(/^r#/, ""));
  const before = src.slice(0, match.index).trimEnd();
  return {
    params,
    mutates: parts.some((part) => part.startsWith("&mut self")),
    payable: before.endsWith("#[payable]"),
  };
}

const FACTORY = "factory.test";
const INTENTS = "intents.test";

function answer(method: string): unknown {
  switch (method) {
    case "check_spend":
      return { ok: true, code: null, would_hold: false };
    case "get_config":
    case "get_mandate":
    case "get_spend":
    case "vault_version":
      return null;
    case "is_auth_by_predecessor_id_enabled":
      return true;
    case "mt_balance_of":
      return "0";
    default:
      return [];
  }
}

describe("the clients match the Rust ABI", () => {
  it("every view the clients call exists, is read-only and takes exactly the arguments sent", async () => {
    const { rpc, calls } = viewRpc((_contract, method) => answer(method));
    const vault = new VaultClient(VAULT, rpc);
    await vault.getConfig();
    await vault.getMandate(1);
    await vault.listMandates(0, 10);
    await vault.getSpend(1);
    await vault.listSpends(0, 10);
    await vault.listAnchors(0, 10);
    await vault.listAgents();
    await vault.checkSpend(request, "ed25519:Agent");
    const intents = new IntentsClient(INTENTS, rpc);
    await intents.publicKeysOf("a.near");
    await intents.isAuthByPredecessorIdEnabled("a.near");
    await intents.poaBalance("a.near", "base-0xabc.omft.near");
    const factory = new FactoryClient(FACTORY, rpc);
    await factory.versions();
    await factory.vaultVersion("a.near");
    await factory.getConfig();
    await factory.listVaults(0, 10);

    expect(calls).toHaveLength(15);
    for (const call of calls) {
      const src = { [VAULT]: VAULT_RS, [FACTORY]: FACTORY_RS, [INTENTS]: INTENTS_RS }[
        call.contract
      ];
      const label = `${call.contract}.${call.method}`;
      const method = rustMethod(src ?? "", call.method);
      expect(method, `${label} exists in the Rust source`).not.toBeNull();
      expect(Object.keys(call.args).sort(), `${label} arguments`).toEqual(
        [...(method?.params ?? [])].sort(),
      );
      expect(method?.mutates, `${label} is a view`).toBe(false);
      expect(method?.payable, `${label} is not payable`).toBe(false);
    }
  });

  it("spend and anchor are non-payable change methods taking exactly the arguments sent", async () => {
    const { rpc } = viewRpc(() => null);
    const agent = fakeSender(okOutcome({ spend_id: 1, status: "paid" }));
    const ledger = fakeSender(okOutcome(null));
    const vault = new VaultClient(VAULT, rpc, { agent: agent.sender, ledger: ledger.sender });
    await vault.spend(request);
    await vault.anchor(1, ROOT, 1);
    for (const tx of [...agent.sent, ...ledger.sent]) {
      const method = rustMethod(VAULT_RS, tx.methodName);
      expect(method, `vault.${tx.methodName} exists`).not.toBeNull();
      expect(Object.keys(tx.args).sort()).toEqual([...(method?.params ?? [])].sort());
      expect(method?.mutates).toBe(true);
      expect(method?.payable, `${tx.methodName} must not need a deposit`).toBe(false);
      expect(tx.deposit).toBe(0n);
    }
    expect(agent.sent.map((tx) => tx.methodName)).toEqual(["spend"]);
    expect(ledger.sent.map((tx) => tx.methodName)).toEqual(["anchor"]);
  });

  it("the clients' page cap is the contracts' MAX_PAGE", () => {
    for (const src of [VAULT_RS, FACTORY_RS]) {
      expect(/pub const MAX_PAGE: u64 = (\d+);/.exec(src)?.[1]).toBe(String(MAX_PAGE_LIMIT));
    }
  });

  it("isSpendResult accepts exactly the SpendStatus variants of the contract", () => {
    const body = /pub enum SpendStatus \{([^}]*)\}/.exec(VAULT_RS)?.[1] ?? "";
    const statuses = body
      .split(",")
      .map((variant) => variant.trim())
      .filter((variant) => variant.length > 0)
      .map((variant) => variant.toLowerCase());
    expect(statuses).toHaveLength(7);
    for (const status of statuses) expect(isSpendResult({ spend_id: 1, status })).toBe(true);
    expect(isSpendResult({ spend_id: 1, status: "unknown" })).toBe(false);
  });
});
