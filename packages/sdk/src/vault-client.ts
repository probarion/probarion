import type {
  AgentView,
  AnchorView,
  CheckSpendVerdict,
  MandateView,
  SpendRequest,
  SpendResult,
  SpendView,
  VaultConfig,
} from "@probarion/core";
import {
  ConfigError,
  ContractError,
  isVaultErrorCode,
  normalizeVaultCode,
  ViewError,
} from "./errors.js";
import { assertU64, clampLimit, MAX_PAGE_LIMIT, PAGE_SIZE, pageAll } from "./paging.js";
import type { RpcClient } from "./rpc.js";
import { firstReceiptSucceeded, type TxOutcome, type TxSender } from "./tx.js";

export { MAX_PAGE_LIMIT, PAGE_SIZE, pageAll };

const TGAS = 1_000_000_000_000n;

// Gas and deposits follow docs/runbooks/testnet.md section 5 (R18).
/**
 * 200 Tgas, proven by the testnet smoke: a spend to an Intents payee cascades into `ft_withdraw`
 * (100 Tgas) and a callback. A function-call key attaches no deposit (I4), so the deposit is 0.
 */
export const SPEND_GAS = 200n * TGAS;
/** 30 Tgas, the same as the owner's plain calls. `anchor` only writes one record and emits one event. */
export const ANCHOR_GAS = 30n * TGAS;

const SPEND_STATUSES: ReadonlySet<string> = new Set([
  "held",
  "pending",
  "paid",
  "burned",
  "failed",
  "rejected",
  "expired",
]);

const HEX64 = /^[0-9a-f]{64}$/;

export function isSpendResult(value: unknown): value is SpendResult {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.spend_id === "number" && SPEND_STATUSES.has(String(rec.status));
}

/** A spend whose payout is settled or waiting for an approver: the only statuses that count as success. */
const SPEND_OK_STATUSES: ReadonlySet<string> = new Set(["paid", "burned", "held"]);

export type SpendUnconfirmedKind = "unreadable_value" | "callback_failed" | "pending";

/**
 * A spend that may have paid although the answer cannot say so. The caller must look the spend up
 * by its `ref` in `list_spends` (`get_spend` takes a spend id) and must never record it as failed or send it again.
 */
export interface SpendUnconfirmed {
  kind: SpendUnconfirmedKind;
  reason: string;
}

/**
 * What `spend` learned. Read `ok` first:
 *
 * - `ok: true`: `result.status` is `paid`, `burned` or `held`.
 * - `ok: false` and `unconfirmed: null`: the spend did not pay. Either the contract refused it
 *   (`tx.code`), or the payout failed and the vault released the reservation
 *   (`result.status` is `failed`, `rejected` or `expired`; `tx.ok` is still true then,
 *   because the callback that records the failure succeeds).
 * - `ok: false` and `unconfirmed` set: it may have paid. Look it up by `ref`; never call it failed.
 */
export interface SpendTxResult {
  tx: TxOutcome;
  result: SpendResult | null;
  ok: boolean;
  unconfirmed: SpendUnconfirmed | null;
}

/**
 * Read a finished `spend` transaction as a verdict. `VaultClient.spend` applies it to what the
 * sender returns; `VaultClient.resolveSpend` applies it to an outcome recovered with `lookup`, so a
 * recovered `failed` payout is `ok: false` and a recovered callback failure is `unconfirmed`, never
 * a bare `tx.ok`. Any code that holds a `TxOutcome` of a spend should come through here.
 */
export function interpretSpend(tx: TxOutcome): SpendTxResult {
  const unconfirmed = (kind: SpendUnconfirmedKind, reason: string, result: SpendResult | null) => ({
    tx,
    result,
    ok: false,
    unconfirmed: { kind, reason },
  });
  if (tx.ok) {
    if (!isSpendResult(tx.value)) {
      return unconfirmed(
        "unreadable_value",
        `the transaction succeeded but its return value is not a spend result: ${String(JSON.stringify(tx.value)).slice(0, 120)}`,
        null,
      );
    }
    const result = tx.value;
    if (SPEND_OK_STATUSES.has(result.status)) {
      return { tx, result, ok: true, unconfirmed: null };
    }
    if (result.status === "pending") {
      return unconfirmed("pending", "the payout is still pending", result);
    }
    return { tx, result, ok: false, unconfirmed: null };
  }
  // The transaction failed. Only two cases are a definite failure (nothing changed, nothing paid):
  //  - `raw` is null: the node refused the transaction before it ran, so there is no result at all;
  //  - `raw` is a result whose FIRST receipt (the spend call itself) failed.
  // Everything else is `callback_failed`, the safe direction: the spend receipt ran and a later
  // receipt (the payout callback) failed, so the payout may have gone out; or `raw` is a result
  // whose receipts do not say which one failed (no receipts, an unreadable status). That includes a
  // non-null `raw` with no receipts: it is not proof that nothing ran.
  if (typeof tx.raw === "object" && tx.raw !== null) {
    const first = firstReceiptSucceeded(tx.raw);
    if (first !== false) {
      const why =
        first === true
          ? "the spend receipt ran but the transaction failed afterwards"
          : "the result does not show which receipt failed";
      return unconfirmed(
        "callback_failed",
        `${why} (${tx.failure ?? "no detail"}); the payout may have gone out`,
        null,
      );
    }
  }
  return { tx, result: null, ok: false, unconfirmed: null };
}

export interface VaultSenders {
  /** The agent's function-call key on the vault: it signs `spend`. */
  agent?: TxSender | undefined;
  /** The ledger's function-call key on the vault: it signs `anchor`. */
  ledger?: TxSender | undefined;
}

export class VaultClient {
  readonly vaultId: string;
  private readonly rpc: RpcClient;
  private readonly senders: VaultSenders;

  constructor(vaultId: string, rpc: RpcClient, senders: VaultSenders = {}) {
    this.vaultId = vaultId;
    this.rpc = rpc;
    this.senders = senders;
  }

  get canSpend(): boolean {
    return this.senders.agent !== undefined;
  }

  get canAnchor(): boolean {
    return this.senders.ledger !== undefined;
  }

  getConfig(): Promise<VaultConfig> {
    return this.rpc.viewFunction<VaultConfig>(this.vaultId, "get_config");
  }

  async getMandate(mandateId: number): Promise<MandateView | null> {
    assertU64("mandate id", mandateId);
    return this.rpc.viewFunction<MandateView | null>(this.vaultId, "get_mandate", {
      mandate_id: mandateId,
    });
  }

  async listMandates(fromIndex: number, limit: number): Promise<MandateView[]> {
    return this.rpc.viewFunction<MandateView[]>(
      this.vaultId,
      "list_mandates",
      this.page(fromIndex, limit),
    );
  }

  listAllMandates(): Promise<MandateView[]> {
    return pageAll((from, limit) => this.listMandates(from, limit), PAGE_SIZE, {
      contractId: this.vaultId,
      methodName: "list_mandates",
    });
  }

  async getSpend(spendId: number): Promise<SpendView | null> {
    assertU64("spend id", spendId);
    return this.rpc.viewFunction<SpendView | null>(this.vaultId, "get_spend", {
      spend_id: spendId,
    });
  }

  async listSpends(fromIndex: number, limit: number): Promise<SpendView[]> {
    return this.rpc.viewFunction<SpendView[]>(
      this.vaultId,
      "list_spends",
      this.page(fromIndex, limit),
    );
  }

  listAllSpends(): Promise<SpendView[]> {
    return pageAll((from, limit) => this.listSpends(from, limit), PAGE_SIZE, {
      contractId: this.vaultId,
      methodName: "list_spends",
    });
  }

  async listAnchors(fromIndex: number, limit: number): Promise<AnchorView[]> {
    return this.rpc.viewFunction<AnchorView[]>(
      this.vaultId,
      "list_anchors",
      this.page(fromIndex, limit),
    );
  }

  listAllAnchors(): Promise<AnchorView[]> {
    return pageAll((from, limit) => this.listAnchors(from, limit), PAGE_SIZE, {
      contractId: this.vaultId,
      methodName: "list_anchors",
    });
  }

  listAgents(): Promise<AgentView[]> {
    return this.rpc.viewFunction<AgentView[]>(this.vaultId, "list_agents");
  }

  /** The contract's free dry run of `spend` for `signerPk`. The code comes back bare, whatever the contract sent. */
  async checkSpend(request: SpendRequest, signerPk: string): Promise<CheckSpendVerdict> {
    const verdict = await this.rpc.viewFunction<CheckSpendVerdict | null>(
      this.vaultId,
      "check_spend",
      { request, signer_pk: signerPk },
    );
    if (typeof verdict !== "object" || verdict === null) {
      throw new ViewError(this.vaultId, "check_spend", "the answer is not a verdict");
    }
    return {
      ok: verdict.ok === true,
      code: typeof verdict.code === "string" ? normalizeVaultCode(verdict.code) : null,
      would_hold: verdict.would_hold === true,
    };
  }

  /**
   * Sends `spend` signed by the agent's key.
   *
   * A refusal (a contract panic) is not thrown: it comes back with `ok: false` and `tx.code`, and
   * so does a vault that is out of NEAR (`isOutOfNearCode(tx.code)`). See `SpendTxResult` for how
   * to read the rest. A `TxRejectedError` is thrown when the node refuses the signed transaction
   * before it runs (for example `NotEnoughAllowance`): nothing changed, nothing was paid. A
   * `TxSendFailed` means nothing was sent. A `TxOutcomeUnknownError` is thrown when the
   * transaction was sent but its outcome is not known: record its `txHash` and never send the
   * spend again (not even with a fresh `ref`); resolve it with `sender.lookup(txHash)` or by
   * looking the spend up by `ref`.
   */
  async spend(request: SpendRequest): Promise<SpendTxResult> {
    const agent = this.sender("agent", "spend needs an agent key (PROBARION_AGENT_KEY)");
    const tx = await agent.functionCall({
      receiverId: this.vaultId,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    return interpretSpend(tx);
  }

  /**
   * Recover a spend whose outcome was unknown (`TxOutcomeUnknownError.txHash`): read the final
   * outcome of that transaction through the agent sender's `lookup` and give it the same verdict
   * `spend` gives (`ok`, `unconfirmed`). A recovered `failed` payout is `ok: false`; a recovered
   * callback failure is `unconfirmed`. If the node still cannot say, `TxOutcomeUnknownError` is
   * thrown again with the same hash: keep the hash and ask again later; never send the spend again.
   */
  async resolveSpend(txHash: string): Promise<SpendTxResult> {
    const agent = this.sender("agent", "resolveSpend needs the agent key that signed the spend");
    if (agent.lookup === undefined) {
      throw new ConfigError("the agent sender cannot look up a transaction (it has no lookup)");
    }
    return interpretSpend(await agent.lookup(txHash));
  }

  /** Sends `anchor(seq, root, count)` signed by the ledger key. A failure throws a `ContractError`. */
  async anchor(seq: number, root: string, count: number): Promise<TxOutcome> {
    const ledger = this.sender("ledger", "anchor needs a ledger key (PROBARION_LEDGER_KEY)");
    // The same checks the contract makes first: seq and count start at 1, root is lowercase sha256 hex.
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new ConfigError("anchor seq must be an integer >= 1");
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new ConfigError("anchor count must be an integer >= 1");
    }
    if (!HEX64.test(root)) throw new ConfigError("anchor root must be 64 lowercase hex characters");
    const tx = await ledger.functionCall({
      receiverId: this.vaultId,
      methodName: "anchor",
      args: { seq, root, count },
      gas: ANCHOR_GAS,
      deposit: 0n,
    });
    if (!tx.ok) {
      // A chain-level refusal such as LackBalanceForState has no vault code: its readable
      // detail goes into the message.
      throw new ContractError(
        isVaultErrorCode(tx.code) ? tx.code : null,
        tx.txHash,
        tx.failure ?? "anchor failed",
      );
    }
    return tx;
  }

  /** The sender for a role, which must sign as this vault: function-call keys live on the vault account itself. */
  private sender(role: "agent" | "ledger", missing: string): TxSender {
    const sender = this.senders[role];
    if (sender === undefined) throw new ConfigError(missing);
    if (sender.accountId !== this.vaultId) {
      throw new ConfigError(
        `the ${role} key signs as ${sender.accountId}, but this vault is ${this.vaultId}: function-call keys live on the vault account itself`,
      );
    }
    return sender;
  }

  private page(fromIndex: number, limit: number): Record<string, unknown> {
    assertU64("from_index", fromIndex);
    return { from_index: fromIndex, limit: clampLimit(limit) };
  }
}
