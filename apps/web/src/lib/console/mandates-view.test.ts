import type { MandateView } from "@probarion/core";
import { NETWORKS } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  EXPIRED_REVOKE_NOTE,
  expiryText,
  mandateState,
  payeeView,
  purposeShort,
  purposeTitle,
  remainingUnits,
  safeChainText,
  usdcText,
} from "./mandates-view";

const BASE_ASSET = NETWORKS.mainnet.allowedAssets.base;
const SOL_ASSET = NETWORKS.mainnet.allowedAssets.solana;
const endOfDayNs = (y: number, m: number, d: number) =>
  String(BigInt(Date.UTC(y, m - 1, d, 23, 59, 59)) * 1_000_000n);

describe("honest mandate status", () => {
  const NOW_MS = Date.parse("2026-11-08T12:00:00Z");
  const ns = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);
  const st = (status: string, expires: string, reserved = "0") =>
    mandateState(
      { status: status as MandateView["status"], expires_at_ns: expires, reserved },
      NOW_MS,
    );

  it("an active mandate in date can be revoked", () => {
    expect(st("active", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "active",
      label: "active",
      canRevoke: true,
    });
  });

  it("an expired mandate with nothing reserved says expired and has no Revoke, though the chain still says active", () => {
    const s = st("active", ns("2026-11-01T23:59:59Z"));
    expect(s).toMatchObject({ key: "expired", canRevoke: false, revokeNote: null });
    expect(s.label).toMatch(/expired/);
  });

  // W-T9-R1. held.rs `approve` checks the hold, the freeze and that the mandate is not revoked, and never
  // its expiry, so a spend held before the expiry can still be paid after it. Revoke is what stops that.
  it("an expired mandate with funds still reserved offers Revoke, and says what it stops", () => {
    for (const status of ["active", "exhausted"]) {
      const s = st(status, ns("2026-11-01T23:59:59Z"), "1");
      expect(s, status).toMatchObject({ key: "expired", canRevoke: true });
      expect(s.revokeNote, status).toBe(EXPIRED_REVOKE_NOTE);
    }
    expect(EXPIRED_REVOKE_NOTE).toContain("stops its held payments from being approved");
  });

  it("an expired mandate offers Revoke for any positive reserved figure, and none for zero or an unreadable one", () => {
    const expired = ns("2026-11-01T23:59:59Z");
    expect(st("active", expired, "340282366920938463463374607431768211455").canRevoke).toBe(true);
    expect(st("active", expired, "0").canRevoke).toBe(false);
    for (const bad of ["", "x", "-1", "1.5", "01"]) {
      expect(st("active", expired, bad), bad).toMatchObject({ canRevoke: false, revokeNote: null });
    }
    expect(
      mandateState({ status: "active", expires_at_ns: expired } as never, NOW_MS),
    ).toMatchObject({
      canRevoke: false,
    });
  });

  it("a mandate in date never carries the expired note, whatever is reserved", () => {
    expect(st("active", ns("2026-12-31T23:59:59Z"), "5").revokeNote).toBeNull();
    expect(st("exhausted", ns("2026-12-31T23:59:59Z"), "5").revokeNote).toBeNull();
  });

  it("revoked wins over expired: a revoked mandate has no Revoke even with funds reserved", () => {
    expect(st("revoked", ns("2026-11-01T23:59:59Z"), "5")).toMatchObject({
      key: "revoked",
      canRevoke: false,
      revokeNote: null,
    });
  });

  it("expires exactly when the contract stops spending: now >= expires_at_ns", () => {
    expect(st("active", String(BigInt(NOW_MS) * 1_000_000n + 1n)).key).toBe("active");
    expect(st("active", String(BigInt(NOW_MS) * 1_000_000n)).key).toBe("expired");
    expect(st("active", String(BigInt(NOW_MS) * 1_000_000n - 1n)).key).toBe("expired");
  });

  it("a revoked mandate says revoked and has no Revoke, also when it is past its date", () => {
    expect(st("revoked", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "revoked",
      canRevoke: false,
    });
    expect(st("revoked", ns("2026-01-01T00:00:00Z"))).toMatchObject({
      key: "revoked",
      canRevoke: false,
    });
  });

  it("an exhausted mandate in date can still be revoked (a released spend gives its use back)", () => {
    expect(st("exhausted", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "exhausted",
      canRevoke: true,
    });
    expect(st("exhausted", ns("2026-01-01T00:00:00Z"))).toMatchObject({
      key: "expired",
      canRevoke: false, // nothing reserved
    });
  });

  it("offers no Revoke for a status or a time it cannot read", () => {
    expect(st("frozen", ns("2026-12-31T23:59:59Z"))).toMatchObject({
      key: "unknown",
      canRevoke: false,
    });
    expect(st("active", "tomorrow")).toMatchObject({ key: "unknown", canRevoke: false });
    expect(st("active", "-1")).toMatchObject({ key: "unknown", canRevoke: false });
    expect(st("active", "")).toMatchObject({ key: "unknown", canRevoke: false });
    expect(st("<b>x</b>".repeat(20), ns("2026-12-31T23:59:59Z")).label.length).toBeLessThanOrEqual(
      40,
    );
  });
});

describe("remaining", () => {
  it("is max_total - spent - reserved, from the chain's own figures", () => {
    expect(remainingUnits({ max_total: "1000", spent: "300", reserved: "200" })).toBe("500");
    expect(remainingUnits({ max_total: "1000", spent: "1000", reserved: "0" })).toBe("0");
  });
  it("never goes below zero and is null when a figure is not a decimal", () => {
    expect(remainingUnits({ max_total: "10", spent: "8", reserved: "8" })).toBe("0");
    expect(remainingUnits({ max_total: "10", spent: "x", reserved: "0" })).toBeNull();
    expect(remainingUnits({ max_total: "", spent: "0", reserved: "0" })).toBeNull();
  });
});

describe("text from the chain", () => {
  it("usdcText formats base units and says unreadable instead of throwing", () => {
    expect(usdcText("1500000")).toBe("1.5");
    expect(usdcText("0")).toBe("0");
    expect(usdcText("abc")).toBe("unreadable");
    expect(usdcText("-5")).toBe("unreadable");
    expect(usdcText("")).toBe("unreadable");
  });

  it("safeChainText strips controls and direction marks, and cuts the length", () => {
    expect(safeChainText("Acme‮ gnisid\nline")).not.toMatch(/[‮\n]/);
    expect(safeChainText("a\u0000b")).toBe("a�b");
    expect(safeChainText("x".repeat(500), 64)).toHaveLength(65); // 64 characters and an ellipsis
    expect(safeChainText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>"); // React escapes; nothing is rewritten here
    expect(safeChainText(undefined)).toBe("unreadable");
    expect(safeChainText(42)).toBe("unreadable");
    // format characters go too: a zero-width joiner or non-joiner is not shown as it came
    expect(safeChainText("a\u200Db\u200Cc")).toBe("a\uFFFDb\uFFFDc");
    expect(safeChainText("\uD800")).toBe("�");
  });
});

describe("payeeView (a payee read from the chain, before it is shown or linked)", () => {
  const ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";
  it("a NEAR payee with a valid account id can be linked", () => {
    expect(payeeView({ type: "near", account_id: "designer.near" })).toEqual({
      kind: "near",
      account: "designer.near",
    });
  });

  it("a NEAR payee that is not an account id is shown as text and never linked", () => {
    for (const bad of [
      "../../etc",
      "a b",
      "Designer.near",
      "x/y?z=1",
      "javascript:alert(1)",
      "a".repeat(80),
    ]) {
      const v = payeeView({ type: "near", account_id: bad });
      expect(v.kind, bad).toBe("unreadable");
    }
  });

  it("a Base payee needs 0x and 40 hex; a Solana payee needs 32 to 44 base58 characters", () => {
    expect(payeeView({ type: "intents", chain: "base", address: ADDR, asset: BASE_ASSET })).toEqual(
      {
        kind: "intents",
        chain: "base",
        address: ADDR,
      },
    );
    expect(
      payeeView({ type: "intents", chain: "solana", address: "7".repeat(40), asset: SOL_ASSET }),
    ).toEqual({
      kind: "intents",
      chain: "solana",
      address: "7".repeat(40),
    });
    expect(
      payeeView({ type: "intents", chain: "base", address: "0x12", asset: BASE_ASSET }).kind,
    ).toBe("unreadable");
    expect(
      payeeView({ type: "intents", chain: "solana", address: ADDR, asset: SOL_ASSET }).kind,
    ).toBe("unreadable");
    expect(
      payeeView({ type: "intents", chain: "ethereum", address: ADDR, asset: BASE_ASSET }).kind,
    ).toBe("unreadable");
  });

  it("anything else is unreadable and its text is made safe", () => {
    for (const bad of [
      null,
      undefined,
      5,
      "x",
      [],
      {},
      { type: "wire" },
      { type: "near" },
      { type: "near", account_id: 5 },
    ]) {
      expect(payeeView(bad).kind).toBe("unreadable");
    }
    const v = payeeView({ type: "near", account_id: "evil‮.near" });
    expect(v.kind === "unreadable" && v.text).not.toMatch(/‮/);
  });
});

describe("expiryText", () => {
  it("shows the UTC date and minute of an expiry in nanoseconds", () => {
    expect(expiryText(endOfDayNs(2026, 12, 31))).toBe("2026-12-31 23:59 UTC");
  });
  it("says unreadable for anything that is not a time, instead of throwing", () => {
    for (const bad of ["", "abc", "-1", "1.5", "99999999999999999999999999999999"]) {
      expect(expiryText(bad), bad).toBe("unreadable");
    }
  });
});

describe("purposeShort", () => {
  it("shortens a sha256, and says unreadable for anything else", () => {
    expect(purposeShort(`${"ab".repeat(4)}${"c".repeat(50)}${"de".repeat(3)}`)).toBe(
      `${"ab".repeat(4)}…${"de".repeat(3)}`,
    );
    for (const bad of ["", "xyz", "AB".repeat(32), "a".repeat(63)])
      expect(purposeShort(bad)).toBe("unreadable");
  });
});

describe("expiryText with seconds (the exact time an expiry carries)", () => {
  it("shows 23:59:59 for the end of a day, and only the minute without the flag", () => {
    expect(expiryText(endOfDayNs(2026, 12, 31), true)).toBe("2026-12-31 23:59:59 UTC");
    expect(expiryText(endOfDayNs(2026, 12, 31), false)).toBe("2026-12-31 23:59 UTC");
    expect(expiryText("abc", true)).toBe("unreadable");
  });
});

describe("purposeTitle (a chain string in an attribute must be a sha256)", () => {
  it("is the hash when it is 64 lowercase hex, else nothing", () => {
    const h = "ab".repeat(32);
    expect(purposeTitle(h)).toBe(h);
    for (const bad of ["", "xyz", "AB".repeat(32), "a".repeat(63), `"onmouseover=x ${h}`]) {
      expect(purposeTitle(bad), bad).toBeUndefined();
    }
  });
});
