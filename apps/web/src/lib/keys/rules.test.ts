import { describe, expect, it } from "vitest";
import type { AccessKeyState } from "@/lib/near/reader";
import {
  type ChainView,
  cleanLabel,
  describeCheck,
  isKeyPurpose,
  KEY_METHOD,
  type KeyPurpose,
  type KeyStatus,
  nextStatus,
  scopeProblem,
} from "./rules";

const VAULT = "acme.vaults.probarion.near";

/** Exactly the key `add_agent` / `set_ledger_key` adds: a plain FunctionCall key on the vault. */
const fc = (methods: string[], over: Partial<AccessKeyState> = {}): AccessKeyState => ({
  exists: true,
  kind: "FunctionCall",
  fullAccess: false,
  allowance: "1000000000000000000000000",
  receiverId: VAULT,
  methodNames: methods,
  ...over,
});
const NO_KEY: AccessKeyState = {
  exists: false,
  kind: null,
  fullAccess: false,
  allowance: null,
  receiverId: null,
  methodNames: [],
};
const FULL: AccessKeyState = {
  exists: true,
  kind: "FullAccess",
  fullAccess: true,
  allowance: null,
  receiverId: null,
  methodNames: [],
};

const seen = (key: AccessKeyState, registered = true): ChainView => ({
  readable: true,
  registered,
  key,
});
const row = (purpose: KeyPurpose, status: KeyStatus) => ({ purpose, status });

describe("scopeProblem: the only key a vault hands out", () => {
  it("accepts exactly [spend] for an agent key and [anchor] for the ledger key", () => {
    expect(KEY_METHOD).toEqual({ agent: "spend", ledger: "anchor" });
    expect(scopeProblem("agent", VAULT, fc(["spend"]))).toBeNull();
    expect(scopeProblem("ledger", VAULT, fc(["anchor"]))).toBeNull();
  });

  it("refuses a missing key", () => {
    expect(scopeProblem("agent", VAULT, NO_KEY)).toBe("missing");
  });

  it("refuses any full-access key, plain or gas", () => {
    expect(scopeProblem("agent", VAULT, FULL)).toBe("full_access");
    expect(scopeProblem("agent", VAULT, { ...FULL, kind: "GasKeyFullAccess" })).toBe("full_access");
    // Even a state that claims FunctionCall but says full access is refused.
    expect(scopeProblem("agent", VAULT, fc(["spend"], { fullAccess: true }))).toBe("full_access");
  });

  it("refuses a gas key, even one scoped to spend() on the vault", () => {
    expect(scopeProblem("agent", VAULT, fc(["spend"], { kind: "GasKeyFunctionCall" }))).toBe(
      "gas_key",
    );
    expect(scopeProblem("ledger", VAULT, fc(["anchor"], { kind: "GasKeyFunctionCall" }))).toBe(
      "gas_key",
    );
  });

  it("refuses a state with no kind", () => {
    expect(scopeProblem("agent", VAULT, fc(["spend"], { kind: null }))).toBe("not_function_call");
  });

  it("refuses a key for another receiver", () => {
    expect(scopeProblem("agent", VAULT, fc(["spend"], { receiverId: "evil.near" }))).toBe(
      "wrong_receiver",
    );
    expect(scopeProblem("agent", VAULT, fc(["spend"], { receiverId: null }))).toBe(
      "wrong_receiver",
    );
    expect(scopeProblem("agent", VAULT, fc(["spend"], { receiverId: `x${VAULT}` }))).toBe(
      "wrong_receiver",
    );
  });

  it("refuses any other method list: extra, empty (= every method), swapped, repeated, cased", () => {
    for (const methods of [
      ["spend", "approve"],
      ["approve", "spend"],
      [],
      ["anchor"],
      ["spend", "spend"],
      ["Spend"],
      ["spend "],
    ]) {
      expect(scopeProblem("agent", VAULT, fc(methods)), JSON.stringify(methods)).toBe(
        "wrong_methods",
      );
    }
    expect(scopeProblem("ledger", VAULT, fc(["spend"]))).toBe("wrong_methods");
    expect(scopeProblem("ledger", VAULT, fc(["anchor", "spend"]))).toBe("wrong_methods");
    expect(scopeProblem("ledger", VAULT, fc([]))).toBe("wrong_methods");
  });
});

describe("nextStatus", () => {
  it("activates a pending key only when the right key is on chain and registered", () => {
    expect(nextStatus(row("agent", "pending"), VAULT, seen(fc(["spend"])))).toEqual({
      to: "active",
      reason: "activated",
    });
    expect(nextStatus(row("ledger", "pending"), VAULT, seen(fc(["anchor"])))).toEqual({
      to: "active",
      reason: "activated",
    });
  });

  it("keeps a pending key pending when it is not registered (list_agents / get_config.ledger_key)", () => {
    expect(nextStatus(row("agent", "pending"), VAULT, seen(fc(["spend"]), false))).toEqual({
      to: "pending",
      reason: "not_registered",
    });
    expect(nextStatus(row("ledger", "pending"), VAULT, seen(fc(["anchor"]), false))).toEqual({
      to: "pending",
      reason: "not_registered",
    });
  });

  it("keeps a pending key pending, with the reason, when the chain shows the wrong key", () => {
    const cases: [AccessKeyState, string][] = [
      [fc(["spend"], { kind: "GasKeyFunctionCall" }), "scope_gas_key"],
      [FULL, "scope_full_access"],
      [{ ...FULL, kind: "GasKeyFullAccess" }, "scope_full_access"],
      [fc(["spend", "approve"]), "scope_wrong_methods"],
      [fc(["spend"], { receiverId: "evil.near" }), "scope_wrong_receiver"],
    ];
    for (const [key, reason] of cases) {
      expect(nextStatus(row("agent", "pending"), VAULT, seen(key)), reason).toEqual({
        to: "pending",
        reason,
      });
    }
  });

  it("keeps a pending key pending while its access key is not on chain yet", () => {
    expect(nextStatus(row("agent", "pending"), VAULT, seen(NO_KEY))).toEqual({
      to: "pending",
      reason: "not_on_chain",
    });
    expect(nextStatus(row("agent", "pending"), VAULT, seen(NO_KEY, false))).toEqual({
      to: "pending",
      reason: "not_on_chain",
    });
  });

  it("never changes a status on a read error", () => {
    for (const status of ["pending", "active"] as const) {
      expect(nextStatus(row("agent", status), VAULT, { readable: false })).toEqual({
        to: status,
        reason: "unreadable",
      });
      expect(nextStatus(row("ledger", status), VAULT, { readable: false })).toEqual({
        to: status,
        reason: "unreadable",
      });
    }
  });

  it("marks an active key removed on a definite NO_KEY, registered or not", () => {
    expect(nextStatus(row("agent", "active"), VAULT, seen(NO_KEY))).toEqual({
      to: "removed",
      reason: "removed_on_chain",
    });
    expect(nextStatus(row("agent", "active"), VAULT, seen(NO_KEY, false))).toEqual({
      to: "removed",
      reason: "removed_on_chain",
    });
    expect(nextStatus(row("ledger", "active"), VAULT, seen(NO_KEY, false))).toEqual({
      to: "removed",
      reason: "removed_on_chain",
    });
  });

  it("revokes an active key the vault no longer registers, or whose permission changed", () => {
    expect(nextStatus(row("agent", "active"), VAULT, seen(fc(["spend"]), false))).toEqual({
      to: "revoked",
      reason: "unregistered",
    });
    expect(nextStatus(row("ledger", "active"), VAULT, seen(fc(["anchor"]), false))).toEqual({
      to: "revoked",
      reason: "unregistered",
    });
    expect(nextStatus(row("agent", "active"), VAULT, seen(FULL))).toEqual({
      to: "revoked",
      reason: "scope_full_access",
    });
    expect(
      nextStatus(
        row("agent", "active"),
        VAULT,
        seen(fc(["spend"], { kind: "GasKeyFunctionCall" })),
      ),
    ).toEqual({ to: "revoked", reason: "scope_gas_key" });
  });

  it("keeps a healthy active key active", () => {
    expect(nextStatus(row("agent", "active"), VAULT, seen(fc(["spend"])))).toEqual({
      to: "active",
      reason: "still_active",
    });
  });

  it("never moves a revoked or removed key, whatever the chain says", () => {
    for (const status of ["revoked", "removed"] as const) {
      for (const view of [seen(fc(["spend"])), seen(NO_KEY), { readable: false } as const]) {
        expect(nextStatus(row("agent", status), VAULT, view)).toEqual({
          to: status,
          reason: "final",
        });
      }
    }
  });
});

describe("cleanLabel", () => {
  it("trims, and falls back to the purpose's default label", () => {
    expect(cleanLabel("  payroll  ", "agent")).toEqual({ ok: true, value: "payroll" });
    expect(cleanLabel("", "agent")).toEqual({ ok: true, value: "payables" });
    expect(cleanLabel("   ", "ledger")).toEqual({ ok: true, value: "ledger" });
  });

  it("allows 64 bytes and refuses 65 (the contract counts bytes, not characters)", () => {
    expect(cleanLabel("a".repeat(64), "agent")).toEqual({ ok: true, value: "a".repeat(64) });
    expect(cleanLabel("a".repeat(65), "agent").ok).toBe(false);
    // 22 three-byte characters are 66 bytes, though only 22 characters.
    expect(cleanLabel("€".repeat(22), "agent").ok).toBe(false);
    expect(cleanLabel("€".repeat(21), "agent")).toEqual({ ok: true, value: "€".repeat(21) });
  });

  it("refuses control characters and anything that is not text", () => {
    expect(cleanLabel("pay\u0000roll", "agent").ok).toBe(false);
    expect(cleanLabel("pay\nroll", "agent").ok).toBe(false);
    expect(cleanLabel(42, "agent").ok).toBe(false);
    expect(cleanLabel(null, "agent").ok).toBe(false);
  });
});

describe("isKeyPurpose", () => {
  it("is exactly agent or ledger", () => {
    expect(isKeyPurpose("agent")).toBe(true);
    expect(isKeyPurpose("ledger")).toBe(true);
    for (const v of ["Agent", "", "full", null, undefined, 1, {}])
      expect(isKeyPurpose(v)).toBe(false);
  });
});

describe("describeCheck", () => {
  const check = (reason: Parameters<typeof describeCheck>[0]["reason"], to: KeyStatus) => ({
    id: "k",
    public_key: "ed25519:ABCDEFGHJKLMNPQRSTUVWXYZ",
    purpose: "agent" as const,
    from: "pending" as KeyStatus,
    to,
    reason,
  });

  it("explains every outcome a member can act on, and says nothing about a final key", () => {
    expect(describeCheck(check("activated", "active"))).toMatch(/active/);
    expect(describeCheck(check("scope_gas_key", "pending"))).toMatch(/gas key/);
    expect(describeCheck(check("scope_full_access", "pending"))).toMatch(/full-access/);
    expect(describeCheck(check("unreadable", "pending"))).toMatch(/unchanged/);
    expect(describeCheck(check("not_on_chain", "pending"))).toMatch(/not on the vault yet/);
    expect(describeCheck(check("removed_on_chain", "removed"))).toMatch(/removed/);
    expect(describeCheck(check("final", "revoked"))).toBeNull();
    expect(describeCheck(check("still_active", "active"))).toBeNull();
  });
});
