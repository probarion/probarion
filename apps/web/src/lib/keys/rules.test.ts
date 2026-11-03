import { readFileSync } from "node:fs";
import { KNOWN_VAULT_CODE_HASHES } from "@probarion/core";
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
  keepResultText,
  nextStatus,
  scopeProblem,
  stuckText,
  VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY,
  vaultCodeOf,
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
    expect(nextStatus(row("agent", "pending"), VAULT, seen(NO_KEY, false))).toEqual({
      to: "pending",
      reason: "not_on_chain",
    });
  });

  it("calls a key the vault registers without its access key stuck, for every status but active", () => {
    for (const purpose of ["agent", "ledger"] as const) {
      for (const status of ["pending", "revoked", "removed"] as const) {
        expect(
          nextStatus(row(purpose, status), VAULT, seen(NO_KEY, true)),
          `${purpose} ${status}`,
        ).toEqual({
          to: status,
          reason: "registered_without_key",
        });
      }
    }
  });

  it("never changes a status on a read error", () => {
    for (const status of ["pending", "active", "revoked", "removed"] as const) {
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

  it("never makes a discarded key active, even on the full check: it reports it on chain instead", () => {
    const discarded = { purpose: "agent" as const, status: "removed" as const, discarded: true };
    expect(nextStatus(discarded, VAULT, seen(fc(["spend"])))).toEqual({
      to: "removed",
      reason: "discarded_on_chain",
    });
    expect(nextStatus({ ...discarded, purpose: "ledger" }, VAULT, seen(fc(["anchor"])))).toEqual({
      to: "removed",
      reason: "discarded_on_chain",
    });
    // Short of the full check it is an ordinary key out of use (or stuck).
    expect(nextStatus(discarded, VAULT, seen(fc(["spend"]), false))).toEqual({
      to: "removed",
      reason: "inactive",
    });
    expect(nextStatus(discarded, VAULT, seen(NO_KEY, true))).toEqual({
      to: "removed",
      reason: "registered_without_key",
    });
    // Not discarded: the same chain state makes it active again.
    expect(nextStatus({ ...discarded, discarded: false }, VAULT, seen(fc(["spend"])))).toEqual({
      to: "active",
      reason: "reactivated",
    });
  });

  it("makes a revoked or removed key active again only through the full activation check", () => {
    for (const status of ["revoked", "removed"] as const) {
      expect(nextStatus(row("agent", status), VAULT, seen(fc(["spend"])))).toEqual({
        to: "active",
        reason: "reactivated",
      });
      expect(nextStatus(row("ledger", status), VAULT, seen(fc(["anchor"])))).toEqual({
        to: "active",
        reason: "reactivated",
      });
      // Anything short of the full check leaves it where it is.
      for (const [view, why] of [
        [seen(fc(["spend"]), false), "not registered"],
        [seen(NO_KEY, false), "no key"],
        [seen(FULL), "full access"],
        [seen(fc(["spend"], { kind: "GasKeyFunctionCall" })), "gas key"],
        [seen(fc(["spend", "approve"])), "wrong methods"],
        [seen(fc(["spend"], { receiverId: "evil.near" })), "wrong receiver"],
        [seen(fc(["anchor"])), "the other purpose's method"],
      ] as const) {
        expect(nextStatus(row("agent", status), VAULT, view), `${status}: ${why}`).toEqual({
          to: status,
          reason: "inactive",
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

  it("explains every outcome a member can act on, and says nothing about a key out of use", () => {
    expect(describeCheck(check("activated", "active"))).toMatch(/active/);
    expect(describeCheck(check("reactivated", "active"))).toMatch(/active again/);
    expect(describeCheck(check("scope_gas_key", "pending"))).toMatch(/gas key/);
    expect(describeCheck(check("scope_full_access", "pending"))).toMatch(/full-access/);
    expect(describeCheck(check("unreadable", "pending"))).toMatch(/unchanged/);
    expect(describeCheck(check("not_on_chain", "pending"))).toMatch(/not on the vault yet/);
    expect(describeCheck(check("removed_on_chain", "removed"))).toMatch(/removed/);
    expect(describeCheck(check("inactive", "revoked"))).toBeNull();
    expect(describeCheck(check("still_active", "active"))).toBeNull();
    // A key out of use whose read failed is not worth a note.
    expect(describeCheck({ ...check("unreadable", "removed"), from: "removed" })).toBeNull();
  });

  it("words a discarded key on chain by what the page offers", () => {
    const agent = describeCheck(check("discarded_on_chain", "removed"));
    expect(agent).toMatch(/on the vault although you discarded it/);
    expect(agent).toMatch(/Remove it/);
    expect(agent).toMatch(/Keep it/);
    const ledger = describeCheck({ ...check("discarded_on_chain", "removed"), purpose: "ledger" });
    expect(ledger).toMatch(/ledger key although you discarded it/);
    expect(ledger).toMatch(/Keep it/);
  });

  it("words the stuck state by what the page can do, and never says to wait", () => {
    const agent = describeCheck(check("registered_without_key", "pending"));
    const ledger = describeCheck({
      ...check("registered_without_key", "pending"),
      purpose: "ledger",
    });
    for (const text of [agent, ledger]) {
      expect(text).toMatch(/registered in the vault but its access key was never added/);
      expect(text).toMatch(/possibly the vault ran out of NEAR/);
      expect(text).not.toMatch(/again in a minute|check again/i);
    }
    expect(agent).toMatch(/Remove it/);
    // Without the vault's code the page cannot say whether a new ledger key recovers it.
    expect(ledger).toMatch(/could not be read/);
    // A revoked key's remedy is the one the page offers for its purpose.
    expect(describeCheck({ ...check("scope_full_access", "revoked"), from: "active" })).toMatch(
      /Remove/,
    );
    expect(
      describeCheck({
        ...check("scope_full_access", "revoked"),
        from: "active",
        purpose: "ledger",
      }),
    ).toMatch(/Set a new ledger key/);
  });
});

describe("a stuck ledger key, by what the vault's code can do (W-T10-R3)", () => {
  it("knows the two builds from before the set_ledger_key fix, exactly as contracts/code-hashes.json records them", () => {
    const recorded = JSON.parse(
      readFileSync(new URL("../../../../../contracts/code-hashes.json", import.meta.url), "utf8"),
    ) as { entries: { crate: string; commit: string; code_hash: string }[] };
    const before = recorded.entries
      .filter((e) => e.crate === "probarion-vault")
      .filter((e) =>
        [
          "3bd8189612a43b1063745c80fd053527ef8e19f9",
          "ba654353fa5af4cf2b023badf7e56ddf4caff491",
        ].includes(e.commit),
      )
      .map((e) => e.code_hash);
    expect([...VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY].sort()).toEqual([...before].sort());
    for (const h of VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY)
      expect(KNOWN_VAULT_CODE_HASHES).toContain(h);
  });

  it("reads the code identity: old, current or unknown", () => {
    for (const h of VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY) expect(vaultCodeOf(h)).toBe("old");
    expect(vaultCodeOf("11111111111111111111111111111111")).toBe("current");
    expect(vaultCodeOf(null)).toBe("unknown");
    expect(vaultCodeOf(undefined)).toBe("unknown");
    expect(vaultCodeOf("")).toBe("unknown");
  });

  it("tells an old vault it needs a new vault, a current one to set a new ledger key (topped up), and never waits for a fix", () => {
    const old = stuckText("ledger", "old");
    const current = stuckText("ledger", "current");
    const unknown = stuckText("ledger", "unknown");
    expect(old).toMatch(/This vault's code cannot replace a stuck ledger key/);
    expect(old).toMatch(/needs a new vault/);
    expect(current).toMatch(/Set a new ledger key/);
    expect(current).toMatch(/no free NEAR, top it up first/);
    expect(unknown).toMatch(/could not be read/);
    for (const text of [old, current, unknown, stuckText("agent", "old")]) {
      expect(text).toMatch(/registered in the vault but its access key was never added/);
      expect(text).not.toMatch(/contract fix/i);
      expect(text).not.toMatch(/again in a minute/);
    }
    // An agent key recovers by Remove, whatever the code.
    for (const code of ["old", "current", "unknown"] as const) {
      expect(stuckText("agent", code)).toMatch(/Remove it, then generate a new agent key/);
    }
    // describeCheck words a stuck ledger key by the code it is given.
    const c = {
      id: "k",
      public_key: "ed25519:ABCDEFGHJKLMNPQRSTUVWXYZ",
      purpose: "ledger" as const,
      from: "pending" as const,
      to: "pending" as const,
      reason: "registered_without_key" as const,
    };
    expect(describeCheck(c, "old")).toMatch(/needs a new vault/);
    expect(describeCheck(c, "current")).toMatch(/Set a new ledger key/);
  });
});

describe("keepResultText", () => {
  it("always says what happened, and that nothing changed when Keep refused", () => {
    expect(keepResultText({ kept: true, reason: "reactivated" })).toEqual({
      ok: true,
      message: "Kept: the key is active again.",
    });
    for (const [reason, text] of [
      ["not_found", /not one of this vault's keys/],
      ["not_discarded", /not a discarded one/],
      ["unreadable", /could not be read/],
      ["registered_without_key", /access key is missing/],
      ["not_registered", /does not register this key/],
      ["scope_gas_key", /gas key/],
      ["scope_full_access", /full-access/],
    ] as const) {
      const r = keepResultText({ kept: false, reason });
      expect(r?.ok, reason).toBe(false);
      expect(r?.message, reason).toMatch(text);
      expect(r?.message, reason).toMatch(/^Not kept: .*Nothing changed\.$/);
    }
  });
});
