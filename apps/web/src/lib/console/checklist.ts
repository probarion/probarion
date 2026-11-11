import type { Network } from "@/lib/config";
import { SAMPLE_INVOICE_USDC } from "@/lib/console/samples";
import type { MandateSummary, Read, SpendSummary } from "@/lib/console/vaults";

/**
 * "Your first agent payment" (site audit P1-8): the five steps from a new vault to a payment an agent makes inside a
 * mandate, worked out from what the overview already reads. Nothing here reads or writes: the page passes its reads
 * in. A step whose read failed is "unknown": it is never ticked and never offered as undone. Once a spend is paid (on
 * NEAR, or out through Intents) the checklist is over and this returns null; it also returns null when the spends
 * cannot be read, since the vault may have paid long ago.
 */

export type StepId = "vault" | "keys" | "usdc" | "mandate" | "payment";
export type StepState = "done" | "open" | "unknown";

export type StepTab = "/keys" | "/agent" | "/topup" | "/mandates" | "/payables";

/** One of two ways to do a step, each on its own tab. */
export interface StepChoice {
  title: string;
  text: string;
  tab: StepTab;
  action: string;
}

export interface ChecklistStep {
  id: StepId;
  state: StepState;
  title: string;
  text: string;
  /** The vault tab where the step is done (a path under /console/<vault>), or null for the vault itself. */
  tab: StepTab | null;
  action: string | null;
  /** Two ways to do the step, shown in place of its one link while it is not done. */
  choices?: StepChoice[];
}

export interface Checklist {
  steps: ChecklistStep[];
  done: number;
  /** The first step still to do, or null when every step left could not be checked. */
  next: StepId | null;
}

export interface ChecklistInput {
  network: Network;
  /**
   * Whether the console holds an active agent key and an active ledger key for this vault: what Payables needs to run
   * an invoice, which a key added on chain alone does not give.
   */
  keys: Read<{ agent: boolean; ledger: boolean }>;
  /**
   * Whether the chain shows an agent key and a ledger key on the vault that the console did not make: the user's own
   * agent (MCP) holds them, and pays by itself.
   */
  selfHeld: Read<boolean>;
  /** The vault's balance of its USDC, base units. */
  usdc: Read<string>;
  /** The vault's Base USDC in Intents, base units; `not_allowed` when the vault does not allow it. */
  intentsBase: Read<string>;
  mandates: Read<MandateSummary>;
  spends: Read<SpendSummary>;
  /** The whole test USDC one faucet click adds, or null when this server has no faucet (and on mainnet). */
  faucetUsdc: string | null;
}

const DIGITS = /^(0|[1-9][0-9]*)$/;

/** A balance read as "some", "none" or unknown (a failed read, or one that is not a number). */
function balance(read: Read<string>): boolean | null {
  if (!read.ok || !DIGITS.test(read.value)) return null;
  return BigInt(read.value) > 0n;
}

/**
 * USDC is in the vault when either balance holds some. It is not when the NEAR balance is 0 and the Intents one is 0
 * too, or not allowed for this vault; anything else could not be checked.
 */
function usdcState(usdc: Read<string>, intentsBase: Read<string>): StepState {
  const near = balance(usdc);
  const intents =
    intentsBase.ok || intentsBase.kind !== "not_allowed" ? balance(intentsBase) : false;
  if (near === true || intents === true) return "done";
  return near === false && intents === false ? "open" : "unknown";
}

function state<T>(read: Read<T>, done: (v: T) => boolean | null): StepState {
  if (!read.ok) return "unknown";
  const d = done(read.value);
  return d === null ? "unknown" : d ? "done" : "open";
}

/**
 * The keys are there when the console holds both hosted keys, or when the user's own agent holds both on the vault.
 * Otherwise a failed read on either side leaves the step unchecked.
 */
function keysState(keys: ChecklistInput["keys"], selfHeld: Read<boolean>): StepState {
  if (keys.ok && keys.value.agent && keys.value.ledger) return "done";
  if (selfHeld.ok && selfHeld.value) return "done";
  return keys.ok && selfHeld.ok ? "open" : "unknown";
}

const paidCount = (counts: Record<string, number>) => (counts.paid ?? 0) + (counts.burned ?? 0);

export function firstPaymentChecklist(i: ChecklistInput): Checklist | null {
  if (!i.spends.ok || paidCount(i.spends.value.counts) > 0) return null;
  const testnet = i.network === "testnet";

  const steps: ChecklistStep[] = [
    {
      id: "vault",
      state: "done",
      title: "Vault created",
      text: "Its NEAR deposit pays for its storage and gas.",
      tab: null,
      action: null,
    },
    {
      id: "keys",
      state: keysState(i.keys, i.selfHeld),
      title: "Agent key and ledger key",
      text: "Pick who pays from this vault. A vault has one ledger, so it is one or the other.",
      tab: "/keys",
      action: "Go to Keys",
      choices: [
        {
          title: "Probarion's hosted Payables",
          text: "Upload invoices; Probarion's agent pays them. Probarion makes and holds the keys.",
          tab: "/keys",
          action: "Go to Keys",
        },
        {
          title: "Your own AI agent (MCP)",
          text: "Claude, Cursor or Codex pays through MCP. The keys stay on your machine.",
          tab: "/agent",
          action: "Connect agent",
        },
      ],
    },
    {
      id: "usdc",
      state: usdcState(i.usdc, i.intentsBase),
      title: testnet ? "Test USDC in the vault" : "USDC in the vault",
      text: !testnet
        ? "Send USDC to the vault from Top-up."
        : i.faucetUsdc !== null
          ? `Add ${i.faucetUsdc} test USDC from the faucet on Top-up. It has no value, and works once a day per vault.`
          : "Top-up says how to get test USDC for this vault.",
      tab: "/topup",
      action: "Go to Top-up",
    },
    {
      id: "mandate",
      state: state(i.mandates, (m) => (m.counts.active ?? 0) > 0),
      title: "First mandate",
      text: testnet
        ? "Sign a mandate for the agent key. On Mandates, the sample purchase order fills the form for you."
        : "Sign a mandate for the agent key, against the purchase order it pays.",
      tab: "/mandates",
      action: "Go to Mandates",
    },
    {
      id: "payment",
      state: state(i.spends, (s) => paidCount(s.counts) > 0),
      title: "First payment",
      text: testnet
        ? `On Payables, run the sample invoice: ${SAMPLE_INVOICE_USDC} test USDC to the mandate's payee. If no attested model confirms the amount, the invoice waits for you to confirm it.`
        : "On Payables, run an invoice against the mandate's purchase order.",
      tab: "/payables",
      action: "Go to Payables",
    },
  ];

  return {
    steps,
    done: steps.filter((s) => s.state === "done").length,
    next: steps.find((s) => s.state === "open")?.id ?? null,
  };
}
