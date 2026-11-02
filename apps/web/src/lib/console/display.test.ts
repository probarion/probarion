import { isOutOfNearCode, OUT_OF_NEAR_DETAIL } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import { parseTopup } from "@/components/console/SendNearPanel";
import { heldActions, shown, spendStatusView, UNAVAILABLE, whyUnavailable } from "./display";
import { OUT_OF_NEAR, outOfNearDetail } from "./out-of-near";

describe("shown", () => {
  it("formats a value that was read and says unavailable for one that was not", () => {
    expect(shown({ ok: true, value: "0" }, (v) => `${v} USDC`)).toBe("0 USDC");
    let called = false;
    const fmt = (v: string) => {
      called = true;
      return v;
    };
    expect(shown({ ok: false, kind: "contract" }, fmt)).toBe(UNAVAILABLE);
    expect(called).toBe(false);
  });

  it("a contract error is worded as a wrong id, never as a zero", () => {
    expect(whyUnavailable("contract")).toMatch(/not a zero/);
    expect(whyUnavailable("something new")).toBe("the read failed");
  });
});

describe("spendStatusView", () => {
  it("never shows an unconfirmed spend as failed", () => {
    expect(spendStatusView("unconfirmed")).toEqual({
      tone: "warn",
      label: "sent: confirmation pending",
    });
  });

  it("has a default arm for a status it does not know", () => {
    expect(spendStatusView("settling")).toEqual({ tone: "neutral", label: "settling" });
    expect(spendStatusView("")).toEqual({ tone: "neutral", label: "unknown" });
    expect(spendStatusView("x".repeat(100)).label).toHaveLength(40);
  });

  it("colours a failure red and a payment green", () => {
    expect(spendStatusView("failed").tone).toBe("bad");
    expect(spendStatusView("paid").tone).toBe("good");
    expect(spendStatusView("burned").tone).toBe("good");
    expect(spendStatusView("held").tone).toBe("warn");
  });
});

describe("heldActions", () => {
  const now = Date.UTC(2026, 10, 8);
  const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

  it("approve is offered only while the hold runs and the vault is not frozen", () => {
    expect(heldActions(ns(now + 60_000), false, now)).toEqual({ canApprove: true, note: null });
    expect(heldActions(ns(now - 1), false, now).canApprove).toBe(false);
    expect(heldActions(null, false, now).canApprove).toBe(false);
    expect(heldActions(ns(now + 60_000), true, now)).toMatchObject({
      canApprove: false,
      note: expect.stringMatching(/frozen/),
    });
  });
});

describe("out of NEAR (R3)", () => {
  it("uses the SDK's codes and its own text", () => {
    expect(OUT_OF_NEAR.codes).toEqual(["LackBalanceForState", "NotEnoughBalance"]);
    expect(OUT_OF_NEAR.codes.every(isOutOfNearCode)).toBe(true);
    expect(OUT_OF_NEAR.detail).toBe(OUT_OF_NEAR_DETAIL);
    expect(outOfNearDetail("LackBalanceForState")).toBe(OUT_OF_NEAR_DETAIL);
    expect(outOfNearDetail("NotEnoughBalance")).toBe(OUT_OF_NEAR_DETAIL);
    expect(outOfNearDetail("Frozen")).toBeNull();
    expect(outOfNearDetail(null)).toBeNull();
  });
});

describe("parseTopup", () => {
  it("takes 0.5 NEAR, and refuses zero, junk and more than 5 NEAR", () => {
    expect(parseTopup("0.5")).toEqual({ yocto: "500000000000000000000000" });
    expect(parseTopup("5")).toEqual({ yocto: "5000000000000000000000000" });
    for (const bad of ["0", "", "abc", "5.000000000000000000000001", "-1"]) {
      expect("problem" in parseTopup(bad), bad).toBe(true);
    }
  });
});
