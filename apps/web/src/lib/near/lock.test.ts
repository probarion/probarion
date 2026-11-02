import { describe, expect, it } from "vitest";
import {
  actionKey,
  browserStore,
  clearLock,
  type KeyValueStore,
  LOCK_PREFIX,
  lockKeyFor,
  readLock,
  writeLock,
} from "./lock";
import type { TxResult } from "./outcome";
import { sendNearTx } from "./transfer";
import { approveTx, freezeTx, fundVaultUsdcTx, withdrawTx } from "./tx";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const VAULT = "acme.vaults.probarion.near";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return { store, data };
}

const unknown = (over: Partial<TxResult> = {}): TxResult => ({
  status: "unknown",
  txHash: HASH,
  code: null,
  error: "Exceeded 60 seconds",
  ...over,
});

describe("actionKey", () => {
  it("is the same for the same action and different for any other", () => {
    expect(actionKey(approveTx(VAULT, 4))).toBe(actionKey(approveTx(VAULT, 4)));
    expect(actionKey(approveTx(VAULT, 4))).not.toBe(actionKey(approveTx(VAULT, 5)));
    expect(actionKey(approveTx(VAULT, 4))).not.toBe(actionKey(approveTx("other.near", 4)));
    expect(actionKey(withdrawTx(VAULT, "5"))).not.toBe(actionKey(withdrawTx(VAULT, "6")));
    expect(actionKey(freezeTx(VAULT))).not.toBe(actionKey(approveTx(VAULT, 4)));
    expect(actionKey(fundVaultUsdcTx("usdc.near", VAULT, "5"))).not.toBe(
      actionKey(fundVaultUsdcTx("usdc.near", VAULT, "6")),
    );
  });

  it("does not depend on key order or on the summary text", () => {
    const a = approveTx(VAULT, 4);
    const b = {
      ...a,
      summary: "something else",
      actions: a.actions.map((x) => ({
        type: x.type,
        params: {
          deposit: x.params.deposit,
          gas: x.params.gas,
          args: x.params.args,
          methodName: x.params.methodName,
        },
      })),
    };
    expect(actionKey(b)).toBe(actionKey(a));
  });

  it("tells a plain transfer from a call, and one amount from another", () => {
    const half = "500000000000000000000000";
    expect(actionKey(sendNearTx(VAULT, half))).toBe(actionKey(sendNearTx(VAULT, half)));
    expect(actionKey(sendNearTx(VAULT, half))).not.toBe(actionKey(sendNearTx(VAULT, "1")));
    expect(actionKey(sendNearTx(VAULT, half))).not.toBe(actionKey(sendNearTx("other.near", half)));
    expect(actionKey(sendNearTx(VAULT, half))).not.toBe(actionKey(freezeTx(VAULT)));
  });

  it("carries the prefix", () => {
    expect(actionKey(freezeTx(VAULT)).startsWith(LOCK_PREFIX)).toBe(true);
  });
});

describe("the lock survives a reload", () => {
  const key = actionKey(approveTx(VAULT, 4));

  it("an unconfirmed result is stored and read back", () => {
    const { store } = memory();
    writeLock(store, key, unknown({ code: "Frozen" }));
    expect(readLock(store, key)).toEqual(unknown({ code: "Frozen" }));
  });

  it("a result with no hash (not confirmed) is stored too", () => {
    const { store } = memory();
    writeLock(store, key, unknown({ txHash: null, error: "User rejected the request" }));
    expect(readLock(store, key)).toMatchObject({ status: "unknown", txHash: null });
  });

  it("ok, failed, and clearing all end the lock", () => {
    for (const status of ["ok", "failed"] as const) {
      const { store, data } = memory();
      writeLock(store, key, unknown());
      writeLock(store, key, { status, txHash: HASH, code: null, error: null });
      expect(data.has(key), status).toBe(false);
    }
    const { store, data } = memory();
    writeLock(store, key, unknown());
    clearLock(store, key);
    expect(data.has(key)).toBe(false);
    expect(readLock(store, key)).toBeNull();
  });

  it("locks one action only", () => {
    const { store } = memory();
    writeLock(store, key, unknown());
    expect(readLock(store, actionKey(approveTx(VAULT, 5)))).toBeNull();
  });

  it("refuses anything stored that is not an unconfirmed result", () => {
    const cases = [
      "not json",
      "null",
      "5",
      '"unknown"',
      JSON.stringify({ status: "ok", txHash: HASH, code: null, error: null }),
      JSON.stringify({ status: "failed", txHash: HASH, code: null, error: null }),
      JSON.stringify({ status: "unknown", txHash: "h1", code: null, error: null }),
      JSON.stringify({ status: "unknown", txHash: 5 }),
    ];
    for (const text of cases) {
      const { store } = memory({ [key]: text });
      expect(readLock(store, key), text).toBeNull();
    }
  });

  it("cleans up a stored value it cannot use into safe fields", () => {
    const { store } = memory({
      [key]: JSON.stringify({ status: "unknown", txHash: HASH, code: 5, error: "x".repeat(5000) }),
    });
    const r = readLock(store, key);
    expect(r?.code).toBeNull();
    expect(r?.error?.length).toBeLessThanOrEqual(500);
  });
});

describe("storage that is blocked, absent or full never breaks the page", () => {
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };

  it("every call swallows a storage error", () => {
    expect(() => writeLock(throwing, "k", unknown())).not.toThrow();
    expect(() => clearLock(throwing, "k")).not.toThrow();
    expect(readLock(throwing, "k")).toBeNull();
  });

  it("no store, or no key, is a no-op", () => {
    expect(() => writeLock(null, "k", unknown())).not.toThrow();
    expect(() => clearLock(null, "k")).not.toThrow();
    expect(readLock(null, "k")).toBeNull();
    const { store, data } = memory();
    writeLock(store, null, unknown());
    clearLock(store, null);
    expect(readLock(store, null)).toBeNull();
    expect(data.size).toBe(0);
  });

  it("browserStore is null outside a browser", () => {
    expect(browserStore()).toBeNull();
  });
});

describe("lockKeyFor: a name for an action whose transaction is only known after prepare()", () => {
  it("is stable, prefixed, and different per action", () => {
    const a = lockKeyFor("create-vault:acme.vaults.probarion.near");
    expect(a).toBe(`${LOCK_PREFIX}create-vault:acme.vaults.probarion.near`);
    expect(lockKeyFor("create-vault:acme.vaults.probarion.near")).toBe(a);
    expect(lockKeyFor("create-vault:other.vaults.probarion.near")).not.toBe(a);
  });

  it("round-trips a lock like any other key", () => {
    const { store } = memory();
    const key = lockKeyFor("create-vault:acme.vaults.probarion.near");
    writeLock(store, key, unknown());
    expect(readLock(store, key)).toEqual(unknown());
    clearLock(store, key);
    expect(readLock(store, key)).toBeNull();
  });
});
