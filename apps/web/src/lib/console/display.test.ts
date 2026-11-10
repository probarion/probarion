import { NETWORKS } from "@probarion/core";
import { isOutOfNearCode, OUT_OF_NEAR_DETAIL } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import { parseTopup } from "@/components/console/SendNearPanel";
import {
  consoleOutOfNear,
  heldActions,
  holdLeftText,
  rewordOutOfNear,
  SIGNER_OUT_OF_NEAR,
  shown,
  spendAmount,
  spendStatusView,
  UNAVAILABLE,
  VAULT_LOW_SUGGESTION,
  whyUnavailable,
} from "./display";
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

  it("colours a payout still on its way gold, the brand's colour for in progress", () => {
    expect(spendStatusView("pending")).toEqual({ tone: "warn", label: "pending" });
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

describe("heldActions: a hold end that cannot be read", () => {
  it("offers no Approve and says why, without throwing", () => {
    for (const bad of ["", "abc", "1e9", "-1", "12.5"]) {
      const r = heldActions(bad, false, Date.UTC(2026, 10, 8));
      expect(r.canApprove, bad).toBe(false);
      expect(r.note, bad).toMatch(/could not be read/);
    }
  });
});

describe("consoleOutOfNear (W-T8-R1 item 2)", () => {
  const codes = ["LackBalanceForState", "NotEnoughBalance"];

  it("for a console-signed call, names the signer first and the vault second", () => {
    for (const code of codes) {
      const v = consoleOutOfNear(code, codes, false);
      expect(v?.text).toBe(SIGNER_OUT_OF_NEAR);
      expect(v?.suggestTopUp).toBe(false);
    }
    expect(SIGNER_OUT_OF_NEAR).toMatch(
      /your account \(the signer\) or the vault is short of NEAR: check your wallet first/i,
    );
    expect(SIGNER_OUT_OF_NEAR).not.toBe(OUT_OF_NEAR_DETAIL);
  });

  it("suggests sending NEAR to the vault only when its NEAR reads low", () => {
    const low = consoleOutOfNear("LackBalanceForState", codes, true);
    expect(low).toEqual({
      text: `${SIGNER_OUT_OF_NEAR} ${VAULT_LOW_SUGGESTION}`,
      suggestTopUp: true,
    });
    expect(VAULT_LOW_SUGGESTION).toMatch(/Send NEAR to this vault/);
  });

  it("is null for any other code, or none", () => {
    expect(consoleOutOfNear("Frozen", codes, true)).toBeNull();
    expect(consoleOutOfNear(null, codes, true)).toBeNull();
  });

  it("rewords the result in place, by code only", () => {
    const r = {
      status: "failed" as const,
      txHash: "h",
      code: "LackBalanceForState",
      error: OUT_OF_NEAR_DETAIL,
    };
    rewordOutOfNear(r, codes, false);
    expect(r.error).toBe(SIGNER_OUT_OF_NEAR);
    const other = { status: "failed" as const, txHash: "h", code: "Frozen", error: "frozen" };
    rewordOutOfNear(other, codes, true);
    expect(other.error).toBe("frozen");
  });
});

describe("spendAmount", () => {
  const net = NETWORKS.mainnet;
  const base = { type: "intents", chain: "base", address: `0x${"a".repeat(40)}` } as const;

  it("reads a spend to a NEAR account in the vault's own token", () => {
    expect(spendAmount({ type: "near", account_id: "payee.near" }, net.usdc, net)("4000000")).toBe(
      "4 USDC",
    );
    expect(spendAmount({ type: "near", account_id: "payee.near" }, "x.near", net)("4000000")).toBe(
      "4000000 base units of x.near (decimals unknown)",
    );
  });

  it("reads a spend to an Intents payee in the payee's asset: USDC only for that chain's USDC asset", () => {
    expect(spendAmount({ ...base, asset: net.allowedAssets.base }, net.usdc, net)("4000000")).toBe(
      "4 USDC",
    );
    // The Solana USDC asset is not the Base one: a Base payee holding it is shown in base units.
    expect(
      spendAmount({ ...base, asset: net.allowedAssets.solana }, net.usdc, net)("4000000"),
    ).toBe(`4000000 base units of ${net.allowedAssets.solana} (decimals unknown)`);
    expect(spendAmount({ ...base, asset: "wbtc.omft.near" }, net.usdc, net)("4000000")).toBe(
      "4000000 base units of wbtc.omft.near (decimals unknown)",
    );
  });
});

describe("holdLeftText", () => {
  const NOW = Date.UTC(2026, 10, 10, 12, 0);
  const at = (ms: number) => String(BigInt(NOW + ms) * 1_000_000n);

  it("says how long a hold has left, to the minute", () => {
    expect(holdLeftText(at(30_000), NOW)).toBe("less than a minute left");
    expect(holdLeftText(at(59 * 60_000 + 59_000), NOW)).toBe("59 min left");
    expect(holdLeftText(at(3_600_000), NOW)).toBe("1 h 0 min left");
    expect(holdLeftText(at(23 * 3_600_000 + 59 * 60_000), NOW)).toBe("23 h 59 min left");
    expect(holdLeftText(at(50 * 3_600_000), NOW)).toBe("2 d 2 h left");
  });

  it("says the hold ended once its end has passed, and is still open at its exact end, as the vault reads it", () => {
    expect(holdLeftText(at(0), NOW)).toBe("less than a minute left");
    expect(holdLeftText(at(-1), NOW)).toBe("ended");
  });

  it("is null for no hold or a value that is not a time", () => {
    expect(holdLeftText(null, NOW)).toBeNull();
    expect(holdLeftText("1.5", NOW)).toBeNull();
  });
});
