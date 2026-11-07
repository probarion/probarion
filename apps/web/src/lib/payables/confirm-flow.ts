import type { ActionDenied } from "@/lib/console/action-auth";
import type { ConfirmOptions } from "@/lib/console/confirm-dialog";
import { decodeNonce, normalizeSignature, type SignedMessage } from "@/lib/near/signin";
import type { ConfirmResult, PrepareResult } from "./confirm";
import type { RowSnapshot } from "./store";

// What the owner's Confirm and Reject do and say, as plain functions the panel calls (ruling W-T14-R2 items 3, m4 and
// m8). The wording follows the phase: before the signature goes to the server, nothing can have been sent; after that,
// the payment may have gone out, so a failure says so and sends the owner to the page's own status. Only the server
// knows what happened, so the page is reloaded whenever it may have changed.

export type ConfirmPhase = "prepare" | "sign" | "pay";

export type ShownTone = "good" | "warn" | "bad";
export interface Shown {
  tone: ShownTone;
  text: string;
}
export interface FlowResult {
  shown: Shown;
  /** The server may have changed the row: reload the page's data. */
  refresh: boolean;
  /** The outcome is unknown: Confirm stays off until the page has been loaded again. */
  blocked?: boolean;
}

/** After the signature went to the server and no answer came back. */
export const PAYMENT_MAY_HAVE_GONE_OUT =
  "The server did not answer; the payment may have gone out. Reload: if the invoice shows 'Outcome unknown: do not resend', do not confirm again or pay by hand.";

/**
 * What the owner is asked before Reject. It cannot be taken back, so it is the red dialog. Reject asks the server and
 * the wallet nothing, so unlike a wallet button's dialog it has no "your wallet asks you to sign" footnote.
 */
export const REJECT_INVOICE_CONFIRM: ConfirmOptions = {
  title: "Reject invoice",
  actionLabel: "Reject invoice",
  tone: "danger",
  body: "Reject this invoice? Nothing is paid. The same text uploaded again stays a duplicate; a corrected invoice is a new one.",
};

const denied = (v: unknown): v is ActionDenied =>
  typeof v === "object" && v !== null && "status" in v && "error" in v;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The tone follows what happened to the money: paid is good, a hold or a pending answer amber, a refusal red. */
export function confirmResultShown(r: ConfirmResult): Shown {
  if (!r.ok) return { tone: "bad", text: r.text };
  if (r.invoiceStatus === "awaiting_owner") return { tone: "warn", text: r.text };
  switch (r.outcome.status) {
    case "paid":
    case "settled":
    case "burned":
      return { tone: "good", text: r.text };
    case "failed":
    case "refused_by_code":
    case "refused_by_contract":
      return { tone: "bad", text: r.text };
    default:
      // Held for the approvers, a pending confirmation, or a status this code does not know.
      return { tone: "warn", text: r.text };
  }
}

export interface ConfirmFlow {
  /** The vault's owner: a wallet signed in as anyone else is stopped here. */
  owner: string;
  prepare(): Promise<PrepareResult | ActionDenied>;
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<SignedMessage>;
  confirm(nonce: string, signed: unknown): Promise<ConfirmResult | ActionDenied>;
  /** Called as each phase starts, for the button's wording and to show the message being signed. */
  onPhase?(phase: ConfirmPhase, message?: string): void;
}

const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** The wallet's answer when it is complete, its signature in the form the server reads; null otherwise. */
function completeAnswer(
  answer: unknown,
): { accountId: string; publicKey: string; signature: string } | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { accountId, publicKey, signature } = answer as Record<string, unknown>;
  if (typeof accountId !== "string" || accountId === "") return null;
  if (typeof publicKey !== "string" || publicKey === "") return null;
  if (typeof signature !== "string") return null;
  const normal = normalizeSignature(signature);
  return SIGNATURE_BASE64.test(normal) ? { accountId, publicKey, signature: normal } : null;
}

const prepareFailed = (e: unknown): FlowResult => ({
  shown: {
    tone: "bad",
    text: `The server could not prepare the confirmation (${messageOf(e)}), so this attempt sent nothing. Reload to see the invoice's state, then try again.`,
  },
  refresh: false,
});

// A page callback failed before the signature reached the server: not the server's failure, and nothing went out.
const pageFailed = (e: unknown): FlowResult => ({
  shown: {
    tone: "bad",
    text: `This page could not run the confirmation (${messageOf(e)}), so this attempt sent nothing. Reload to see the invoice's state, then try again.`,
  },
  refresh: false,
});

const mayHaveGoneOut: FlowResult = {
  shown: { tone: "warn", text: PAYMENT_MAY_HAVE_GONE_OUT },
  refresh: true,
  blocked: true,
};

async function steps(
  d: ConfirmFlow,
  enter: (phase: ConfirmPhase, message?: string) => void,
): Promise<FlowResult> {
  enter("prepare");
  let prepared: Extract<PrepareResult, { ok: true }>;
  let nonce: Uint8Array;
  try {
    const p = await d.prepare();
    if (denied(p)) return { shown: { tone: "bad", text: p.error }, refresh: false };
    if (!p.ok) return { shown: { tone: "bad", text: p.text }, refresh: true };
    prepared = p;
    nonce = decodeNonce(p.nonce);
  } catch (e) {
    return prepareFailed(e);
  }

  // prepare() answered, so the row waited a moment ago: at the wallet, nothing can have been sent.
  enter("sign", prepared.message);
  let answer: unknown;
  try {
    answer = await d.signMessage({
      message: prepared.message,
      recipient: prepared.recipient,
      nonce,
    });
  } catch (e) {
    return {
      shown: { tone: "bad", text: `The wallet did not sign (${messageOf(e)}). Nothing was sent.` },
      refresh: false,
    };
  }
  const signed = completeAnswer(answer);
  if (signed === null) {
    return {
      shown: {
        tone: "bad",
        text: "The wallet did not return a complete signature. Nothing was sent.",
      },
      refresh: false,
    };
  }
  if (signed.accountId !== d.owner) {
    return {
      shown: {
        tone: "bad",
        text: `Your wallet signed as ${signed.accountId}. Sign as the vault's owner, ${d.owner}. Nothing was sent.`,
      },
      refresh: false,
    };
  }

  // From here the signature is with the server: a failure may come after the payment.
  enter("pay");
  try {
    const r = await d.confirm(prepared.nonce, signed);
    if (denied(r)) return { shown: { tone: "bad", text: r.error }, refresh: true };
    return {
      shown: confirmResultShown(r),
      refresh: true,
      ...(!r.ok && r.reason === "failed_unknown" ? { blocked: true } : {}),
    };
  } catch {
    return mayHaveGoneOut;
  }
}

/** Runs one Confirm. It answers every failure itself and does not throw, whatever a callback does. */
export async function runConfirm(d: ConfirmFlow): Promise<FlowResult> {
  const at: { phase: ConfirmPhase } = { phase: "prepare" };
  try {
    return await steps(d, (phase, message) => {
      at.phase = phase;
      d.onPhase?.(phase, message);
    });
  } catch (e) {
    return at.phase === "pay" ? mayHaveGoneOut : pageFailed(e);
  }
}

export async function runReject(d: {
  seen: RowSnapshot;
  reject(seen: RowSnapshot): Promise<{ ok: boolean; text: string } | ActionDenied>;
}): Promise<FlowResult> {
  try {
    const r = await d.reject(d.seen);
    if (denied(r)) return { shown: { tone: "bad", text: r.error }, refresh: true };
    return { shown: { tone: r.ok ? "good" : "bad", text: r.text }, refresh: true };
  } catch {
    return {
      shown: {
        tone: "bad",
        text: "The server could not finish the rejection. Reload the page to see whether the invoice still waits.",
      },
      refresh: true,
    };
  }
}
