import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  actionLabel,
  approveTx,
  createMandateTx,
  createVaultTx,
  GAS,
  isGasMethod,
  isReadableMethod,
  MANDATE_STORAGE_DEPOSIT,
  type MandateInputJson,
  METHOD_DEPOSIT,
  withdrawTx,
} from "./tx";

const V = "acme.vaults.probarion.near";
const MANDATE: MandateInputJson = {
  payee: { type: "near", account_id: "bob.near" },
  purpose_hash: "a".repeat(64),
  max_per_payment: "100000000",
  max_total: "1000000000",
  max_uses: 10,
  expires_at_ns: "1798675200000000000",
  approval_above: "100000000",
  agent_pk: "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M",
  label: "Acme Design",
};

describe("U64 fields are bounded to 2^64-1 (the contract refuses the rest)", () => {
  const U64_MAX = (2n ** 64n - 1n).toString();
  const ok = {
    name: "acme",
    approvers: ["cfo.near"],
    dailyBackstop: "500000000",
    heldTtlNs: "259200000000000",
    deposit: "1000000000000000000000000",
  };

  it("held_ttl_ns accepts 2^64-1 and refuses 2^64", () => {
    expect(
      createVaultTx("vaults.probarion.near", { ...ok, heldTtlNs: U64_MAX }).actions[0]?.params.args,
    ).toMatchObject({ held_ttl_ns: U64_MAX });
    expect(() =>
      createVaultTx("vaults.probarion.near", { ...ok, heldTtlNs: (2n ** 64n).toString() }),
    ).toThrow(/2\^64-1/);
  });

  it("expires_at_ns accepts 2^64-1 and refuses 2^64", () => {
    expect(
      createMandateTx(V, { ...MANDATE, expires_at_ns: U64_MAX }).actions[0]?.params.args,
    ).toMatchObject({ input: { expires_at_ns: U64_MAX } });
    expect(() => createMandateTx(V, { ...MANDATE, expires_at_ns: (2n ** 64n).toString() })).toThrow(
      /2\^64-1/,
    );
  });

  it("amounts keep the U128 bound (2^64 is fine for an amount)", () => {
    expect(withdrawTx(V, (2n ** 64n).toString()).actions[0]?.params.args).toEqual({
      amount: (2n ** 64n).toString(),
    });
    expect(() => withdrawTx(V, (2n ** 128n).toString())).toThrow(/2\^128-1/);
  });
});

describe("isReadableMethod and actionLabel", () => {
  it("a method is readable if it is in the gas table, or is Transfer", () => {
    for (const m of [...Object.keys(GAS), "Transfer"]) expect(isReadableMethod(m), m).toBe(true);
    for (const m of ["transfer", "spend", "constructor", "__proto__", "", 5, null, undefined]) {
      expect(isReadableMethod(m), String(m)).toBe(false);
    }
  });

  it("names a call by its method and a transfer by its type", () => {
    expect(actionLabel({ type: "Transfer", params: { deposit: "1" } })).toBe("Transfer");
    const call = approveTx(V, 1).actions[0];
    expect(call && actionLabel(call)).toBe("approve");
  });
});

describe("isGasMethod", () => {
  it("is true for the gas table's methods only, and never for a prototype key", () => {
    for (const m of Object.keys(GAS)) expect(isGasMethod(m), m).toBe(true);
    for (const m of ["spend", "constructor", "toString", "__proto__", "", 5, null, undefined]) {
      expect(isGasMethod(m), String(m)).toBe(false);
    }
  });
});

// The numbers below are read from the repository's own sources, so a runbook or a contract that
// changes without the table (or the other way round) fails here.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("the gas table is the runbooks' (parsed from docs/runbooks)", () => {
  interface Row {
    tgas: number;
    deposit: string;
  }

  /** The rows of testnet.md §5: | `a`, `b` | signer | deposit | `'30 Tgas'` ... | */
  function section5(): Map<string, Row> {
    const md = read("docs/runbooks/testnet.md");
    const start = md.indexOf("## 5. Gas and deposits");
    const end = md.indexOf("\n## 6.", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const rows = md
      .slice(start, end)
      .split("\n")
      .filter((line) => line.startsWith("| `"));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const out = new Map<string, Row>();
    for (const row of rows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c !== "");
      const [calls, , deposit, gas] = cells;
      const tgas = /'(\d+(?:\.\d+)?) Tgas'/.exec(gas ?? "")?.[1];
      expect(tgas, row).toBeDefined();
      for (const m of (calls ?? "").matchAll(/`([a-z_]+)`/g)) {
        out.set(m[1] as string, { tgas: Number(tgas), deposit: deposit ?? "" });
      }
    }
    return out;
  }

  it("matches every owner and approver row of §5, and §5 lists every vault method we build", () => {
    const rows = section5();
    for (const [method, { tgas }] of rows) {
      // spend and anchor are signed by the agent and ledger keys, which this app never builds
      if (method === "spend" || method === "anchor") continue;
      expect(isGasMethod(method), `§5 has ${method}, which the gas table lacks`).toBe(true);
      expect(GAS[method as keyof typeof GAS], method).toBe(tgas);
    }
    const vaultMethods = Object.keys(GAS).filter(
      (m) => !["create_vault", "storage_deposit", "ft_transfer"].includes(m),
    );
    for (const m of vaultMethods) expect(rows.has(m), `§5 lacks ${m}`).toBe(true);
  });

  it("matches the §5 deposit column: one yocto, none for freeze, 0.05 NEAR for create_mandate", () => {
    for (const [method, { deposit }] of section5()) {
      if (method === "spend" || method === "anchor") continue;
      if (method === "freeze") expect(deposit).toContain("0 NEAR");
      else if (method === "create_mandate") {
        expect(deposit).toContain("0.05 NEAR");
        expect(MANDATE_STORAGE_DEPOSIT).toBe("50000000000000000000000");
      } else expect(deposit, method).toContain("1 yoctoNEAR");
    }
  });

  it("gives create_vault what factory.md attaches, and the USDC calls what mainnet-v0.md attaches", () => {
    const factory = read("docs/runbooks/factory.md");
    const fromFactory = /`create_vault` attaches `'(\d+(?:\.\d+)?) Tgas'`/.exec(factory)?.[1];
    expect(Number(fromFactory)).toBe(GAS.create_vault);
    const mainnet = read("docs/runbooks/mainnet-v0.md");
    for (const m of ["storage_deposit", "ft_transfer"] as const) {
      const call = new RegExp(`as-transaction "\\$USDC" ${m}[\\s\\S]*?prepaid-gas '(\\d+) Tgas'`);
      expect(Number(call.exec(mainnet)?.[1]), m).toBe(GAS[m]);
    }
  });
});

describe("the one-yocto table is the contract's (parsed from contracts/vault/src)", () => {
  /** Public methods whose body calls require_one_yocto(), and every #[payable] method. */
  function scan() {
    const oneYocto = new Set<string>();
    const payable = new Set<string>();
    const dir = resolve(ROOT, "contracts/vault/src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".rs") && f !== "errors.rs");
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      // the unit tests at the bottom of a file call these too
      const src = read(`contracts/vault/src/${file}`).split("#[cfg(test)]")[0] ?? "";
      const heads = [...src.matchAll(/(#\[payable\]\s*)?pub fn (\w+)/g)];
      for (const [i, head] of heads.entries()) {
        const name = head[2] as string;
        const body = src.slice(head.index + head[0].length, heads[i + 1]?.index ?? src.length);
        if (head[1] !== undefined) payable.add(name);
        if (/require_one_yocto\(\);/.test(body)) oneYocto.add(name);
      }
    }
    return { oneYocto, payable };
  }

  it("finds the nine one-yocto methods in the contract source", () => {
    expect([...scan().oneYocto].sort()).toEqual([
      "add_agent",
      "approve",
      "reject",
      "remove_agent",
      "revoke_mandate",
      "set_ledger_key",
      "unfreeze",
      "withdraw",
      "withdraw_intents",
    ]);
  });

  it("METHOD_DEPOSIT is exactly those, at one yocto, plus freeze at zero (which is not payable)", () => {
    const { oneYocto, payable } = scan();
    const expected: Record<string, string> = Object.fromEntries([...oneYocto].map((m) => [m, "1"]));
    expected.freeze = "0";
    expect(METHOD_DEPOSIT).toEqual(expected);
    expect(payable.has("freeze")).toBe(false);
    for (const m of oneYocto) expect(payable.has(m), `${m} must be #[payable]`).toBe(true);
    // create_mandate is payable but takes a storage deposit, not one yocto
    expect(payable.has("create_mandate")).toBe(true);
    expect(oneYocto.has("create_mandate")).toBe(false);
  });
});
