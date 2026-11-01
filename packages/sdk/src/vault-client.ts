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
import type { TxOutcome, TxSender } from "./tx.js";

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

export interface SpendTxResult {
  tx: TxOutcome;
  result: SpendResult | null;
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
    return pageAll((from, limit) => this.listMandates(from, limit));
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
    return pageAll((from, limit) => this.listSpends(from, limit));
  }

  async listAnchors(fromIndex: number, limit: number): Promise<AnchorView[]> {
    return this.rpc.viewFunction<AnchorView[]>(
      this.vaultId,
      "list_anchors",
      this.page(fromIndex, limit),
    );
  }

  listAllAnchors(): Promise<AnchorView[]> {
    return pageAll((from, limit) => this.listAnchors(from, limit));
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
   * Sends `spend` signed by the agent's key. A refusal (a contract panic) is not thrown: it comes
   * back as `tx` with `ok: false` and its `code`, and `result` is null.
   */
  async spend(request: SpendRequest): Promise<SpendTxResult> {
    const agent = this.senders.agent;
    if (agent === undefined)
      throw new ConfigError("spend needs an agent key (PROBARION_AGENT_KEY)");
    const tx = await agent.functionCall({
      receiverId: this.vaultId,
      methodName: "spend",
      args: { request },
      gas: SPEND_GAS,
      deposit: 0n,
    });
    return { tx, result: tx.ok && isSpendResult(tx.value) ? tx.value : null };
  }

  /** Sends `anchor(seq, root, count)` signed by the ledger key. A failure throws a `ContractError`. */
  async anchor(seq: number, root: string, count: number): Promise<TxOutcome> {
    const ledger = this.senders.ledger;
    if (ledger === undefined) {
      throw new ConfigError("anchor needs a ledger key (PROBARION_LEDGER_KEY)");
    }
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

  private page(fromIndex: number, limit: number): Record<string, unknown> {
    assertU64("from_index", fromIndex);
    return { from_index: fromIndex, limit: clampLimit(limit) };
  }
}
