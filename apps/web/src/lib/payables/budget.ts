// The time of one console upload (apps/web/src/app/api/console/[vault]/invoices/route.ts), the Canary's way
// (lib/canary/limits.ts): one deadline, counted from the route's start, that every phase before the first transaction
// shares. A slow or hanging private model must not let the platform stop the function in the middle of a cycle: the
// invoice row would stay `processing`, which blocks a new upload of the same invoice (no reconcile job is built), and the
// watcher kick that sends the owner's alert would get no time either. So the model calls stop early enough for the
// decision to be written and checked, the chain reads before the first transaction stop at `sendByMs`, and what comes
// from the first transaction on runs with the SDK's own timing, unchanged: a send that may have landed is never cut off
// by this code. budget.test.ts adds the parts up.
//
// Caps and plans: `modelBudgetMs`, the model's end `afterModelMs` before `sendByMs`, and `sendByMs` are enforced
// (payablesBudget, read by the SDK's clients). `beforeModelMs`, `sendAndCloseMs`, `afterResponseMs` and `kickWatchMs`
// are planning figures that nothing enforces. What keeps the watcher kick inside `routeMs` is the function's end, which
// the route passes it (lib/watcher/server.ts, KickOptions.hardLimit): after a late answer it claims fewer alerts.

/** The parts of the route's time, in milliseconds from its start. */
export const PAYABLES_TIME = {
  /** The route's `maxDuration` (90 s), after which the platform stops the function. route.test.ts holds it to the route. */
  routeMs: 90_000,
  /**
   * Before the first model call: the session, the form, the PDF, the keys, the mandates, the lease, the row, and the
   * SDK's own chain and ledger reads. About 10 s in production for the Canary's similar steps (2026-11-10). Not a cap: a
   * longer start leaves the model less, never the steps after it.
   */
  beforeModelMs: 10_000,
  /**
   * ALL the model calls of one cycle (the catalog, the probe, the attestation report, the chat, the signature reads)
   * share this, counted from the first call. A slow private model used 30 s on the chat alone in production (2026-11-10).
   * A model that runs out of it decides rules-only (`model.unavailable`), which holds the invoice for the owner.
   */
  modelBudgetMs: 40_000,
  /**
   * After the model and before the first transaction: the decision's write, the POA balance for an Intents payee, the
   * contract's dry run, and for a hold or a refusal the anchor's reads. The model stops this long before `sendByMs`.
   */
  afterModelMs: 10_000,
  /**
   * From the route's start: no chain read starts after this until a transaction is under way (the RPC client refuses
   * it, so nothing is sent; lib/payables/probarion.ts says how each refused read ends the cycle). The sum of the three
   * parts above.
   */
  sendByMs: 60_000,
  /**
   * From the first transaction on, at the SDK's own timing: the spend, its ledger entry, the anchor transaction, the
   * invoice row and the response. A few seconds each on NEAR. A plan, not a cap: a send that hangs longer is not cut short
   * (it may land), and a function stopped then leaves the row `processing` (docs/RUNBOOK.md, "Invoice stuck in
   * processing").
   */
  sendAndCloseMs: 10_000,
  /**
   * What the function has left once it has answered on time, for the watcher kick (lib/watcher/server.ts): one tenant's
   * watch, then the alerts it claims for KICK_ALERTS_MS and the grace after that deadline (lib/alerts/dispatch.ts). A
   * plan, which server.test.ts adds up: when the answer is later, the kick's hard limit (the route's start plus
   * `routeMs`) shortens its claims instead.
   */
  afterResponseMs: 20_000,
  /** One tenant's watch inside the kick: a handful of chain and database reads. A plan: the watch has no cap. */
  kickWatchMs: 5_000,
} as const;

/**
 * How long each NEAR AI call may take by itself (the SDK's own limits, chat 90 s and 10 s, 15 s and 15 s for the rest,
 * would let one cycle outlive the route). Every call also gets no more than what the model budget has left, so the chat
 * may use all of it.
 */
export const PAYABLES_NEARAI_TIMEOUTS_MS = {
  catalog: 6000,
  report: 6000,
  chat: PAYABLES_TIME.modelBudgetMs,
  signature: 6000,
} as const;

/** The time one cycle has left, read by the SDK's clients before each call they make. */
export interface PayablesBudget {
  /**
   * Milliseconds ALL the model calls have left (NearAiProposer's `remainingMs`): what is left of `modelBudgetMs` since the
   * first call, and never past `afterModelMs` before `sendByMs`.
   */
  modelMs(): number;
  /**
   * Milliseconds a chain read has left (RpcClient's `remainingMs`): until `sendByMs`, and no limit at all once a
   * transaction is under way, so every read from then on runs as the SDK's own client would run it.
   */
  chainMs(): number;
  /** Said by the senders as a transaction starts (lib/payables/probarion.ts): from then on `chainMs` sets no limit. */
  sending(): void;
}

/** The budget of a cycle whose route started at `startedAt` (epoch ms), by the clock `now` (default: the system's). */
export function payablesBudget(startedAt: number, now: () => number = Date.now): PayablesBudget {
  const sendBy = startedAt + PAYABLES_TIME.sendByMs;
  let modelFrom: number | null = null;
  let underWay = false;
  return {
    modelMs: () => {
      const t = now();
      modelFrom ??= t;
      return Math.min(
        PAYABLES_TIME.modelBudgetMs - (t - modelFrom),
        sendBy - PAYABLES_TIME.afterModelMs - t,
      );
    },
    chainMs: () => (underWay ? Number.POSITIVE_INFINITY : sendBy - now()),
    sending: () => {
      underWay = true;
    },
  };
}
