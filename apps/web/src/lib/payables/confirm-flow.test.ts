import type { SpendOutcome } from "@probarion/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  type ConfirmFlow,
  confirmResultShown,
  PAYMENT_MAY_HAVE_GONE_OUT,
  REJECT_INVOICE_CONFIRM,
  runConfirm,
  runReject,
} from "./confirm-flow";

// What the owner's Confirm and Reject buttons do and say, phase by phase (ruling W-T14-R2 items 3, m4 and m8). Only a
// failure at the wallet, or before it, may say nothing was sent; once the signature went to the server, the payment
// may have gone out.

const OWNER = "owner.testnet";
const NONCE = Buffer.alloc(32, 7).toString("base64");
const SIG = Buffer.alloc(64, 3).toString("base64");
const prepared = {
  ok: true as const,
  message: "Probarion confirm v1 | pay …",
  recipient: "probarion.xyz/payables/confirm",
  nonce: NONCE,
  expiresAt: "2026-11-05T12:05:00Z",
};
const paid = (status: string): SpendOutcome =>
  ({
    status,
    spendId: 1,
    code: null,
    txHash: null,
    ledgerSeq: 1,
    decisionHash: "d",
    anchorTxHash: null,
  }) as unknown as SpendOutcome;
const confirmed = {
  ok: true as const,
  invoiceStatus: "decided" as const,
  outcome: paid("paid"),
  recorded: true,
  text: "Paid on NEAR (20.000000 USDC, mandate 1)",
};

function flow(over: Partial<ConfirmFlow> = {}) {
  const phases: string[] = [];
  const d: ConfirmFlow = {
    owner: OWNER,
    prepare: async () => prepared,
    signMessage: async () => ({ accountId: OWNER, publicKey: "ed25519:pk", signature: SIG }),
    confirm: async () => confirmed,
    onPhase: (p) => phases.push(p),
    ...over,
  };
  return { d, phases };
}

describe("runConfirm", () => {
  it("goes through prepare, the wallet and paying, and sends back the nonce and the normalised signature", async () => {
    const confirm = vi.fn(async () => confirmed);
    const signMessage = vi.fn(async () => ({
      accountId: OWNER,
      publicKey: "ed25519:pk",
      signature: Buffer.alloc(64, 3).toString("hex"),
    }));
    const { d, phases } = flow({ confirm, signMessage });
    const r = await runConfirm(d);
    expect(phases).toEqual(["prepare", "sign", "pay"]);
    expect(signMessage.mock.calls[0]?.[0 as never]).toMatchObject({
      message: prepared.message,
      recipient: prepared.recipient,
    });
    expect(confirm).toHaveBeenCalledWith(NONCE, {
      accountId: OWNER,
      publicKey: "ed25519:pk",
      signature: SIG,
    });
    expect(r).toEqual({ shown: { tone: "good", text: confirmed.text }, refresh: true });
  });

  it("a prepare that fails has its own wording, and nothing reaches the wallet", async () => {
    const signMessage = vi.fn();
    const thrown = await runConfirm(
      flow({
        signMessage,
        prepare: async () => {
          throw new Error("offline");
        },
      }).d,
    );
    expect(thrown.shown.tone).toBe("bad");
    expect(thrown.shown.text).toMatch(/could not prepare the confirmation/);
    // A later attempt may follow one whose outcome is unknown: it speaks only for itself.
    expect(thrown.shown.text).toMatch(/this attempt sent nothing/);
    expect(thrown.shown.text).not.toMatch(/Nothing was sent/);
    expect(thrown.refresh).toBe(false);
    const refused = await runConfirm(
      flow({
        signMessage,
        prepare: async () => ({ ok: false, reason: "not_awaiting", text: "It no longer waits." }),
      }).d,
    );
    expect(refused).toEqual({ shown: { tone: "bad", text: "It no longer waits." }, refresh: true });
    const denied = await runConfirm(
      flow({ signMessage, prepare: async () => ({ error: "Sign in again.", status: 401 }) }).d,
    );
    expect(denied.shown).toEqual({ tone: "bad", text: "Sign in again." });
    const malformed = await runConfirm(
      flow({ signMessage, prepare: async () => ({ ...prepared, nonce: "x" }) }).d,
    );
    expect(malformed.shown.text).toMatch(/could not prepare the confirmation/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("a wallet that does not sign says nothing was sent, and the server is not called", async () => {
    const confirm = vi.fn();
    const { d, phases } = flow({
      confirm,
      signMessage: async () => {
        throw new Error("user closed the window");
      },
    });
    const r = await runConfirm(d);
    expect(phases).toEqual(["prepare", "sign"]);
    expect(r.shown).toEqual({
      tone: "bad",
      text: "The wallet did not sign (user closed the window). Nothing was sent.",
    });
    expect(r.refresh).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a wallet that signs as another account says so, and the server is not called", async () => {
    const confirm = vi.fn();
    const r = await runConfirm(
      flow({
        confirm,
        signMessage: async () => ({ accountId: "else.testnet", publicKey: "k", signature: SIG }),
      }).d,
    );
    expect(r.shown.text).toMatch(/signed as else.testnet/);
    expect(r.shown.text).toMatch(/Nothing was sent/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["no account", { publicKey: "ed25519:pk", signature: SIG }],
    ["no key", { accountId: OWNER, signature: SIG }],
    ["no signature", { accountId: OWNER, publicKey: "ed25519:pk" }],
    ["a signature that is not text", { accountId: OWNER, publicKey: "ed25519:pk", signature: 7 }],
    ["an unreadable signature", { accountId: OWNER, publicKey: "ed25519:pk", signature: "nope" }],
  ])(
    "a wallet answer with %s is a wallet failure, and the server is not called",
    async (_why, answer) => {
      const confirm = vi.fn();
      const { d, phases } = flow({
        confirm,
        signMessage: async () => answer as never,
      });
      const r = await runConfirm(d);
      expect(phases).toEqual(["prepare", "sign"]);
      expect(r.shown).toEqual({
        tone: "bad",
        text: "The wallet did not return a complete signature. Nothing was sent.",
      });
      expect(r.refresh).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("does not throw out of the flow, whatever a callback does", async () => {
    const early = await runConfirm(
      flow({
        onPhase: () => {
          throw new Error("render failed");
        },
      }).d,
    );
    expect(early.shown.tone).toBe("bad");
    let n = 0;
    const late = await runConfirm(
      flow({
        onPhase: (p) => {
          n += 1;
          if (p === "pay") throw new Error("render failed");
        },
      }).d,
    );
    expect(n).toBe(3);
    // From the pay phase on, the outcome is not known.
    expect(late).toEqual({
      shown: { tone: "warn", text: PAYMENT_MAY_HAVE_GONE_OUT },
      refresh: true,
      blocked: true,
    });
  });

  it("once the signature went to the server, a failure never says nothing was sent, and the page reloads", async () => {
    const r = await runConfirm(
      flow({
        confirm: async () => {
          throw new Error("An unexpected response was received from the server.");
        },
      }).d,
    );
    expect(r.shown.text).toBe(PAYMENT_MAY_HAVE_GONE_OUT);
    expect(PAYMENT_MAY_HAVE_GONE_OUT).toContain(
      "The server did not answer; the payment may have gone out.",
    );
    expect(PAYMENT_MAY_HAVE_GONE_OUT).toContain("Outcome unknown: do not resend");
    expect(r.shown.text).not.toMatch(/Nothing was sent/);
    expect(r.refresh).toBe(true);
    // Confirm stays off until the page has reloaded: the owner must not try again blind.
    expect(r.blocked).toBe(true);
  });

  it("shows the server's refusal and reloads", async () => {
    const refused = await runConfirm(
      flow({ confirm: async () => ({ ok: false, reason: "expired", text: "Expired." }) }).d,
    );
    expect(refused).toEqual({ shown: { tone: "bad", text: "Expired." }, refresh: true });
    const denied = await runConfirm(
      flow({ confirm: async () => ({ error: "Sign in again.", status: 401 }) }).d,
    );
    expect(denied).toEqual({ shown: { tone: "bad", text: "Sign in again." }, refresh: true });
  });
});

describe("confirmResultShown", () => {
  it.each([
    ["paid", "good"],
    ["settled", "good"],
    ["burned", "good"],
    ["held", "warn"],
    ["unconfirmed", "warn"],
    ["failed", "bad"],
    ["refused_by_code", "bad"],
    ["refused_by_contract", "bad"],
    ["teleported", "warn"],
  ])("%s has the tone %s", (status, tone) => {
    expect(
      confirmResultShown({
        ok: true,
        invoiceStatus: "decided",
        outcome: paid(status),
        recorded: true,
        text: "t",
      }),
    ).toEqual({ tone, text: "t" });
  });

  it("a row that waits again is amber whatever the outcome, and a refusal is red", () => {
    expect(
      confirmResultShown({
        ok: true,
        invoiceStatus: "awaiting_owner",
        outcome: paid("held"),
        recorded: true,
        text: "t",
      }).tone,
    ).toBe("warn");
    expect(confirmResultShown({ ok: false, reason: "busy", text: "t" }).tone).toBe("bad");
  });
});

describe("runReject", () => {
  const seen = { suggestedAmount: "5", invoiceHash: "a".repeat(64), mandateId: null };

  it("sends back the snapshot and says what happened", async () => {
    const reject = vi.fn(async () => ({ ok: true, text: "Rejected." }));
    expect(await runReject({ seen, reject })).toEqual({
      shown: { tone: "good", text: "Rejected." },
      refresh: true,
    });
    expect(reject).toHaveBeenCalledWith(seen);
    expect(
      await runReject({ seen, reject: async () => ({ ok: false, text: "It changed." }) }),
    ).toEqual({ shown: { tone: "bad", text: "It changed." }, refresh: true });
    expect(
      await runReject({ seen, reject: async () => ({ error: "Sign in again.", status: 401 }) }),
    ).toEqual({ shown: { tone: "bad", text: "Sign in again." }, refresh: true });
  });

  it("says plainly when the server did not answer", async () => {
    const r = await runReject({
      seen,
      reject: async () => {
        throw new Error("offline");
      },
    });
    expect(r.shown.tone).toBe("bad");
    expect(r.shown.text).toMatch(/could not finish/);
    expect(r.refresh).toBe(true);
  });
});

describe("REJECT_INVOICE_CONFIRM", () => {
  it("is the red dialog titled and labelled 'Reject invoice', with the sentence the owner has always been asked", () => {
    expect(REJECT_INVOICE_CONFIRM).toEqual({
      title: "Reject invoice",
      actionLabel: "Reject invoice",
      tone: "danger",
      body: "Reject this invoice? Nothing is paid. The same text uploaded again stays a duplicate; a corrected invoice is a new one.",
    });
  });

  it("has no wallet footnote: Reject asks the server, and the wallet nothing", () => {
    expect(REJECT_INVOICE_CONFIRM).not.toHaveProperty("footnote");
  });
});
