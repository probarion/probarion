import { describe, expect, it } from "vitest";
import {
  addAgentTx,
  approveTx,
  type ContractTx,
  createMandateTx,
  createVaultTx,
  FT_STORAGE_DEPOSIT,
  type FunctionCallAction,
  freezeTx,
  fundVaultUsdcTx,
  GAS,
  intentsDepositTx,
  MANDATE_STORAGE_DEPOSIT,
  type MandateInputJson,
  METHOD_DEPOSIT,
  ONE_YOCTO,
  rejectTx,
  removeAgentTx,
  revokeMandateTx,
  setLedgerKeyTx,
  TGAS,
  unfreezeTx,
  withdrawIntentsTx,
  withdrawTx,
} from "./tx";

const V = "acme.vaults.probarion.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BASE = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const PK = "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M";

/** Tgas written out in yocto-gas, the unit a wallet action carries. */
const tgas = (n: number) => (BigInt(n) * TGAS).toString();

const MANDATE: MandateInputJson = {
  payee: {
    type: "intents",
    chain: "base",
    address: "0x52908400098527886E0F7030069857D2E4169EE7",
    asset: BASE,
  },
  purpose_hash: "a".repeat(64),
  max_per_payment: "100000000",
  max_total: "1000000000",
  max_uses: 10,
  expires_at_ns: "1798675200000000000",
  approval_above: "100000000",
  agent_pk: PK,
  label: "Acme Design",
};

describe("owner transaction builders", () => {
  it("create_vault goes to the factory with the deposit attached", () => {
    const tx = createVaultTx("vaults.probarion.near", {
      name: "acme",
      approvers: ["cfo.near"],
      dailyBackstop: "500000000",
      heldTtlNs: "259200000000000",
      deposit: "5000000000000000000000000",
    });
    expect(tx.receiverId).toBe("vaults.probarion.near");
    expect(tx.actions).toEqual([
      {
        type: "FunctionCall",
        params: {
          methodName: "create_vault",
          args: {
            name: "acme",
            approvers: ["cfo.near"],
            daily_backstop: "500000000",
            held_ttl_ns: "259200000000000",
          },
          gas: "300000000000000",
          deposit: "5000000000000000000000000",
        },
      },
    ]);
    expect(tx.summary).toContain("acme.vaults.probarion.near");
  });

  it("create_mandate wraps the input and pays storage", () => {
    const tx = createMandateTx(V, MANDATE);
    expect(tx.receiverId).toBe(V);
    expect(tx.actions[0]?.params).toMatchObject({
      methodName: "create_mandate",
      args: { input: MANDATE },
      deposit: "50000000000000000000000",
    });
  });

  it("agent and ledger keys are added by the vault itself with an allowance", () => {
    expect(
      addAgentTx(V, "ed25519:pk", "1000000000000000000000000", "payables").actions[0]?.params,
    ).toMatchObject({
      methodName: "add_agent",
      args: { public_key: "ed25519:pk", allowance: "1000000000000000000000000", label: "payables" },
      deposit: "1",
    });
    expect(
      setLedgerKeyTx(V, "ed25519:lk", "250000000000000000000000").actions[0]?.params,
    ).toMatchObject({
      methodName: "set_ledger_key",
      args: { public_key: "ed25519:lk", allowance: "250000000000000000000000" },
    });
  });

  it("approve/reject/freeze carry only the spend id or nothing", () => {
    expect(approveTx(V, 7).actions[0]?.params).toMatchObject({
      methodName: "approve",
      args: { spend_id: 7 },
      gas: "150000000000000", // R13: testnet.md §5 (the brief's 300 was wrong)
    });
    expect(rejectTx(V, 7).actions[0]?.params).toMatchObject({
      methodName: "reject",
      args: { spend_id: 7 },
    });
    expect(freezeTx(V).actions[0]?.params).toMatchObject({ methodName: "freeze", args: {} });
  });

  it("attaches exactly 1 yocto to every one-yocto method and nothing to freeze (interfaces v2 §4.2)", () => {
    const cases: [ContractTx, string][] = [
      [addAgentTx(V, "ed25519:pk", "1", "l"), "1"],
      [removeAgentTx(V, "ed25519:pk"), "1"],
      [setLedgerKeyTx(V, "ed25519:pk", "1"), "1"],
      [revokeMandateTx(V, 1), "1"],
      [approveTx(V, 1), "1"],
      [rejectTx(V, 1), "1"],
      [unfreezeTx(V), "1"],
      [withdrawTx(V, "5000000"), "1"],
      [withdrawIntentsTx(V, BASE, "5000000"), "1"],
      [freezeTx(V), "0"],
    ];
    for (const [tx, deposit] of cases) {
      expect(tx.actions).toHaveLength(1);
      expect(tx.actions[0]?.params.deposit, tx.actions[0]?.params.methodName).toBe(deposit);
    }
    expect(Object.keys(METHOD_DEPOSIT).sort()).toEqual(
      cases.map(([tx]) => tx.actions[0]?.params.methodName).sort(),
    );
    expect(withdrawIntentsTx(V, "base-x.omft.near", "7").actions[0]?.params.args).toEqual({
      token: "base-x.omft.near",
      amount: "7",
    });
  });

  it("USDC top-ups register storage first, then transfer with exactly 1 yocto", () => {
    const fund = fundVaultUsdcTx(USDC, V, "25000000");
    expect(fund.receiverId).toBe(USDC);
    expect(fund.actions.map((a) => [a.params.methodName, a.params.deposit])).toEqual([
      ["storage_deposit", "1250000000000000000000"],
      ["ft_transfer", "1"],
    ]);
    const dep = intentsDepositTx(USDC, "ab".repeat(32), "20208197", null);
    expect(dep.actions[1]?.params.args).toEqual({
      receiver_id: "ab".repeat(32),
      amount: "20208197",
      memo: null,
    });
    expect(dep.actions[0]?.params.args).toEqual({
      account_id: "ab".repeat(32),
      registration_only: true,
    });
  });
});

describe("gas table (R13)", () => {
  // docs/runbooks/testnet.md §5 "Gas and deposits" (create_vault: docs/runbooks/factory.md §1-§2,
  // which attaches 300 Tgas in both modes). Never under-gas the owner's exit or freeze calls: a
  // value below these can fail a withdrawal or a freeze half-way, when the owner needs it most.
  it("pins every Tgas value to testnet.md §5", () => {
    expect(GAS).toEqual({
      add_agent: 30,
      remove_agent: 30,
      set_ledger_key: 30,
      revoke_mandate: 30,
      unfreeze: 30,
      reject: 30,
      freeze: 30,
      create_mandate: 100,
      approve: 150,
      withdraw: 100,
      withdraw_intents: 150,
      create_vault: 300,
      // Token calls the owner signs directly: mainnet-v0.md §4-§5 attach 30 Tgas to both.
      storage_deposit: 30,
      ft_transfer: 30,
    });
  });

  it("never lets a protective or exit call fall below the §5 minimum", () => {
    expect(GAS.freeze).toBeGreaterThanOrEqual(30);
    expect(GAS.unfreeze).toBeGreaterThanOrEqual(30);
    expect(GAS.reject).toBeGreaterThanOrEqual(30);
    expect(GAS.withdraw).toBeGreaterThanOrEqual(100);
    expect(GAS.withdraw_intents).toBeGreaterThanOrEqual(150);
    expect(GAS.approve).toBeGreaterThanOrEqual(150); // §5: "at least 130" for the payout and callback
  });

  it("writes gas as a yocto-gas decimal string, and no transaction asks for more than 300 Tgas", () => {
    expect(TGAS).toBe(1_000_000_000_000n);
    const txs: ContractTx[] = [
      createVaultTx("vaults.probarion.near", {
        name: "acme",
        approvers: ["cfo.near"],
        dailyBackstop: "1",
        heldTtlNs: "1",
        deposit: "1",
      }),
      createMandateTx(V, MANDATE),
      revokeMandateTx(V, 1),
      addAgentTx(V, PK, "1", "l"),
      removeAgentTx(V, PK),
      setLedgerKeyTx(V, PK, "1"),
      approveTx(V, 1),
      rejectTx(V, 1),
      freezeTx(V),
      unfreezeTx(V),
      withdrawTx(V, "1"),
      withdrawIntentsTx(V, BASE, "1"),
      fundVaultUsdcTx(USDC, V, "1"),
      intentsDepositTx(USDC, "ab".repeat(32), "1", null),
    ];
    for (const tx of txs) {
      let total = 0n;
      for (const a of tx.actions) {
        expect(a.params.gas, a.params.methodName).toMatch(/^[1-9][0-9]*$/);
        total += BigInt(a.params.gas);
      }
      expect(total, tx.summary).toBeLessThanOrEqual(300n * TGAS);
    }
  });
});

describe("one method, one exact action (methodName, args, gas, deposit)", () => {
  const action = (tx: ContractTx): FunctionCallAction => {
    expect(tx.actions).toHaveLength(1);
    return tx.actions[0] as FunctionCallAction;
  };

  it("create_vault", () => {
    const a = action(
      createVaultTx("vaults.probarion.testnet", {
        name: "acme",
        approvers: ["cfo.testnet", "ops.testnet"],
        dailyBackstop: "500000000",
        heldTtlNs: "259200000000000",
        deposit: "1000000000000000000000000",
      }),
    );
    expect(a).toEqual({
      type: "FunctionCall",
      params: {
        methodName: "create_vault",
        args: {
          name: "acme",
          approvers: ["cfo.testnet", "ops.testnet"],
          daily_backstop: "500000000",
          held_ttl_ns: "259200000000000",
        },
        gas: tgas(300),
        deposit: "1000000000000000000000000",
      },
    });
  });

  it("create_mandate", () => {
    expect(action(createMandateTx(V, MANDATE))).toEqual({
      type: "FunctionCall",
      params: {
        methodName: "create_mandate",
        args: { input: MANDATE },
        gas: tgas(100),
        deposit: "50000000000000000000000",
      },
    });
  });

  it("revoke_mandate", () => {
    expect(action(revokeMandateTx(V, 3)).params).toEqual({
      methodName: "revoke_mandate",
      args: { mandate_id: 3 },
      gas: tgas(30),
      deposit: "1",
    });
  });

  it("add_agent", () => {
    expect(action(addAgentTx(V, PK, "1000000000000000000000000", "payables")).params).toEqual({
      methodName: "add_agent",
      args: { public_key: PK, allowance: "1000000000000000000000000", label: "payables" },
      gas: tgas(30),
      deposit: "1",
    });
  });

  it("remove_agent", () => {
    expect(action(removeAgentTx(V, PK)).params).toEqual({
      methodName: "remove_agent",
      args: { public_key: PK },
      gas: tgas(30),
      deposit: "1",
    });
  });

  it("set_ledger_key", () => {
    expect(action(setLedgerKeyTx(V, PK, "250000000000000000000000")).params).toEqual({
      methodName: "set_ledger_key",
      args: { public_key: PK, allowance: "250000000000000000000000" },
      gas: tgas(30),
      deposit: "1",
    });
  });

  it("approve", () => {
    expect(action(approveTx(V, 12)).params).toEqual({
      methodName: "approve",
      args: { spend_id: 12 },
      gas: tgas(150),
      deposit: "1",
    });
  });

  it("reject", () => {
    expect(action(rejectTx(V, 12)).params).toEqual({
      methodName: "reject",
      args: { spend_id: 12 },
      gas: tgas(30),
      deposit: "1",
    });
  });

  it("freeze attaches nothing and still gets 30 Tgas", () => {
    expect(action(freezeTx(V)).params).toEqual({
      methodName: "freeze",
      args: {},
      gas: tgas(30),
      deposit: "0",
    });
  });

  it("unfreeze", () => {
    expect(action(unfreezeTx(V)).params).toEqual({
      methodName: "unfreeze",
      args: {},
      gas: tgas(30),
      deposit: "1",
    });
  });

  it("withdraw", () => {
    expect(action(withdrawTx(V, "5000000")).params).toEqual({
      methodName: "withdraw",
      args: { amount: "5000000" },
      gas: tgas(100),
      deposit: "1",
    });
  });

  it("withdraw_intents", () => {
    expect(action(withdrawIntentsTx(V, BASE, "5000000")).params).toEqual({
      methodName: "withdraw_intents",
      args: { token: BASE, amount: "5000000" },
      gas: tgas(150),
      deposit: "1",
    });
  });

  it("fundVaultUsdcTx: storage_deposit then ft_transfer, both on the USDC contract", () => {
    const tx = fundVaultUsdcTx(USDC, V, "25000000");
    expect(tx.receiverId).toBe(USDC);
    expect(tx.actions.map((a) => a.params)).toEqual([
      {
        methodName: "storage_deposit",
        args: { account_id: V, registration_only: true },
        gas: tgas(30),
        deposit: "1250000000000000000000",
      },
      {
        methodName: "ft_transfer",
        args: { receiver_id: V, amount: "25000000", memo: "probarion:fund" },
        gas: tgas(30),
        deposit: "1",
      },
    ]);
  });

  it("intentsDepositTx: storage_deposit then ft_transfer to the 1Click deposit address", () => {
    const addr = "ab".repeat(32);
    const tx = intentsDepositTx(USDC, addr, "20208197", "memo-1");
    expect(tx.receiverId).toBe(USDC);
    expect(tx.actions.map((a) => a.params)).toEqual([
      {
        methodName: "storage_deposit",
        args: { account_id: addr, registration_only: true },
        gas: tgas(30),
        deposit: "1250000000000000000000",
      },
      {
        methodName: "ft_transfer",
        args: { receiver_id: addr, amount: "20208197", memo: "memo-1" },
        gas: tgas(30),
        deposit: "1",
      },
    ]);
  });

  it("every owner builder sends to the vault, and the token builders to the USDC contract", () => {
    for (const tx of [
      revokeMandateTx(V, 1),
      addAgentTx(V, PK, "1", "l"),
      removeAgentTx(V, PK),
      setLedgerKeyTx(V, PK, "1"),
      approveTx(V, 1),
      rejectTx(V, 1),
      freezeTx(V),
      unfreezeTx(V),
      withdrawTx(V, "1"),
      withdrawIntentsTx(V, BASE, "1"),
      createMandateTx(V, MANDATE),
    ]) {
      expect(tx.receiverId, tx.summary).toBe(V);
    }
  });
});

describe("deposits match the contracts (vault and factory)", () => {
  it("METHOD_DEPOSIT is exactly the one-yocto table of interfaces v2 §4.2, plus freeze at 0", () => {
    // contracts/vault/src: require_one_yocto() in add_agent, remove_agent, set_ledger_key
    // (keys.rs), revoke_mandate (mandates.rs), approve, reject (held.rs), unfreeze, withdraw,
    // withdraw_intents (admin.rs). freeze is not #[payable].
    expect(METHOD_DEPOSIT).toEqual({
      add_agent: "1",
      remove_agent: "1",
      set_ledger_key: "1",
      revoke_mandate: "1",
      approve: "1",
      reject: "1",
      unfreeze: "1",
      withdraw: "1",
      withdraw_intents: "1",
      freeze: "0",
    });
    expect(ONE_YOCTO).toBe("1");
  });

  it("MANDATE_STORAGE_DEPOSIT is 0.05 NEAR, and the vault refunds what storage did not need", () => {
    expect(MANDATE_STORAGE_DEPOSIT).toBe("50000000000000000000000");
    expect(FT_STORAGE_DEPOSIT).toBe("1250000000000000000000"); // vault USDC_STORAGE_DEPOSIT, 0.00125 NEAR
  });

  it("0.05 NEAR covers the worst-case mandate that contracts/vault/src/mandates.rs can accept", () => {
    // create_mandate requires: byte cost (1e19 yocto per byte) of the storage the mandate adds,
    // plus 0.00125 NEAR for a NEAR payee. Worst case, from the field limits in mandates.rs and
    // types.rs (borsh): purpose_hash 4+64; four u128 (max_per_payment, max_total, spent,
    // reserved) 64; max_uses and uses 8; expires_at_ns 8; approval_above 16; agent_pk 65 (a
    // secp256k1 key is the longest); label 4+64; revoked 1; created_at_ns 8; the payee at most
    // 1+1+(4+44)+(4+64) for Intents or 1+(4+64) for NEAR; plus 5 key bytes and 40 record bytes.
    const BYTE_COST = 10n ** 19n;
    const common = 68n + 64n + 8n + 8n + 16n + 65n + 68n + 1n + 8n;
    const intents = (common + 118n + 45n) * BYTE_COST;
    const near = (common + 69n + 45n) * BYTE_COST + BigInt(FT_STORAGE_DEPOSIT);
    const attached = BigInt(MANDATE_STORAGE_DEPOSIT);
    // wide margin: a longer key or label still fits
    expect(attached).toBeGreaterThan(intents * 5n);
    expect(attached).toBeGreaterThan(near * 5n);
    expect(attached).toBeLessThanOrEqual(10n ** 23n); // and the owner is never asked for more than 0.1 NEAR
  });

  it("create_vault passes the caller's deposit through untouched (factory min_deposit rule)", () => {
    const a = createVaultTx("vaults.probarion.near", {
      name: "acme",
      approvers: ["cfo.near"],
      dailyBackstop: "1",
      heldTtlNs: "1",
      deposit: "123456789012345678901234567",
    }).actions[0];
    expect(a?.params.deposit).toBe("123456789012345678901234567");
  });
});

describe("builders refuse malformed numbers and ids before the wallet sees them", () => {
  it("rejects amounts that are not whole decimal digit strings", () => {
    for (const bad of ["", "1.5", "-1", "1e6", " 5", "0x10", "٣", "01"]) {
      expect(() => withdrawTx(V, bad), JSON.stringify(bad)).toThrow(RangeError);
    }
    expect(() => withdrawTx(V, "0")).toThrow(RangeError); // the contract refuses zero as well
    expect(() => withdrawIntentsTx(V, BASE, "0")).toThrow(RangeError);
    expect(() => fundVaultUsdcTx(USDC, V, "0")).toThrow(RangeError);
    expect(() => intentsDepositTx(USDC, "ab".repeat(32), "0", null)).toThrow(RangeError);
  });

  it("rejects an amount above U128", () => {
    const max = (2n ** 128n - 1n).toString();
    expect(withdrawTx(V, max).actions[0]?.params.args).toEqual({ amount: max });
    expect(() => withdrawTx(V, (2n ** 128n).toString())).toThrow(RangeError);
  });

  it("rejects spend and mandate ids that are not positive safe integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => approveTx(V, bad), String(bad)).toThrow(RangeError);
      expect(() => rejectTx(V, bad), String(bad)).toThrow(RangeError);
      expect(() => revokeMandateTx(V, bad), String(bad)).toThrow(RangeError);
    }
  });

  it("rejects a malformed create_vault deposit, backstop or hold time", () => {
    const ok = {
      name: "acme",
      approvers: ["cfo.near"],
      dailyBackstop: "500000000",
      heldTtlNs: "259200000000000",
      deposit: "1000000000000000000000000",
    };
    expect(() => createVaultTx("vaults.probarion.near", { ...ok, deposit: "1 NEAR" })).toThrow(
      RangeError,
    );
    expect(() => createVaultTx("vaults.probarion.near", { ...ok, deposit: "0" })).toThrow(
      RangeError,
    );
    expect(() => createVaultTx("vaults.probarion.near", { ...ok, dailyBackstop: "5.0" })).toThrow(
      RangeError,
    );
    expect(() => createVaultTx("vaults.probarion.near", { ...ok, heldTtlNs: "-1" })).toThrow(
      RangeError,
    );
  });

  it("rejects a malformed allowance, or mandate amounts and expiry", () => {
    expect(() => addAgentTx(V, PK, "1 NEAR", "l")).toThrow(RangeError);
    expect(() => setLedgerKeyTx(V, PK, "x")).toThrow(RangeError);
    expect(() => createMandateTx(V, { ...MANDATE, max_total: "1.5" })).toThrow(RangeError);
    expect(() => createMandateTx(V, { ...MANDATE, expires_at_ns: "tomorrow" })).toThrow(RangeError);
    expect(() => createMandateTx(V, { ...MANDATE, max_uses: 0 })).toThrow(RangeError);
    expect(() => createMandateTx(V, { ...MANDATE, max_uses: 1.5 })).toThrow(RangeError);
  });

  it("passes only the contract's MandateInput fields, so form state never reaches the chain", () => {
    const dirty = { ...MANDATE, extra: "x", payee: { ...MANDATE.payee, note: "y" } };
    const tx = createMandateTx(V, dirty as unknown as MandateInputJson);
    expect(tx.actions[0]?.params.args).toEqual({ input: MANDATE });
  });

  it("builds a NEAR payee exactly", () => {
    const input: MandateInputJson = { ...MANDATE, payee: { type: "near", account_id: "bob.near" } };
    expect(createMandateTx(V, input).actions[0]?.params.args).toEqual({ input });
    expect(createMandateTx(V, input).summary).toContain("bob.near");
  });
});
