// Snapshot gathering for verify (interfaces §10, plan 03 Task 14): every chain fact the pure checks a-i need, read
// from the vault, intents and the factory, plus the burn pairs of burned spends found in their transactions.
import {
  type Hex32,
  KNOWN_VAULT_CODE_HASHES,
  type LedgerEntry,
  NETWORKS,
  type Snapshot,
  type SpendView,
  type VaultConfig,
  type VersionView,
  WITHDRAW_MEMO_PREFIX,
} from "@probarion/core";
import { envValue } from "./env.js";
import { type BurnTxHint, type BurnTxHints, isPreLedgerVault } from "./evidence.js";
import { FactoryClient } from "./factory-client.js";
import { isRecord, messageOf } from "./guards.js";
import { IntentsClient } from "./intents-client.js";
import {
  codeIdentity,
  type ExecutionOutcomeView,
  type RpcClient,
  type TxStatusResult,
} from "./rpc.js";
import { VaultClient } from "./vault-client.js";

type Network = "mainnet" | "testnet";

/** Regular RPC nodes keep transactions for roughly 2.5 days (5 epochs); older lookups need an archival node. */
export const ARCHIVAL_AFTER_NS = 216_000_000_000_000n;
export const DEFAULT_ARCHIVAL_RPC_URLS: Readonly<Record<Network, readonly string[]>> = {
  mainnet: ["https://archival-rpc.mainnet.fastnear.com"],
  testnet: ["https://archival-rpc.testnet.fastnear.com"],
};

/** `NEAR_ARCHIVAL_RPC_URLS` (comma-separated; an empty value is unset, R12), else FastNEAR's archival node. */
export function resolveArchivalRpcUrls(
  network: Network,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const fromEnv = (envValue(env, "NEAR_ARCHIVAL_RPC_URLS") ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_ARCHIVAL_RPC_URLS[network]];
}

export interface BurnPair {
  memo: string;
  intents_owner: string;
  amount: string;
}

/** The items of every NEP-297 event `name` of `standard` logged in one receipt. */
function eventItems(
  receipt: ExecutionOutcomeView,
  standard: string,
  name: string,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const log of receipt.outcome.logs) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(log.slice("EVENT_JSON:".length));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.standard !== standard || parsed.event !== name) continue;
    const data = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    for (const item of data) if (isRecord(item)) items.push(item);
  }
  return items;
}

/**
 * Interfaces §10 h (R5): in ONE transaction, the POA token's NEP-141 `ft_burn` with `owner_id` = intents and a
 * `WITHDRAW_TO:` memo, and intents' NEP-245 `mt_burn` of `nep141:<asset>`, whose owner and amount it reports as
 * they are (check h judges them). Every receipt is scanned.
 *
 * Who may log the `ft_burn`: the asset contract itself (the mainnet shape, where intents.near and the POA token
 * log in separate receipts), and on the testnet network only, also the intents account (the intents-stub logs
 * both events in one receipt). The stub shape is never accepted on mainnet. Logs of any other account, the
 * vault's own included, never count, and neither does a receipt that did not succeed (its status must be
 * `SuccessValue` or `SuccessReceiptId`).
 */
export function findBurnPair(
  tx: TxStatusResult,
  asset: string,
  intentsId: string,
  network: Network,
): BurnPair | null {
  let memo: string | null = null;
  let mtBurn: { owner: string; amount: string } | null = null;
  const tokenId = `nep141:${asset}`;
  for (const receipt of tx.receipts_outcome) {
    // A failed receipt keeps the logs it wrote before it failed: only a successful one counts (T14-R1).
    if (!succeeded(receipt.outcome.status)) continue;
    const executor = receipt.outcome.executor_id;
    const ftBurnFrom = executor === asset || (network === "testnet" && executor === intentsId);
    if (ftBurnFrom && memo === null) {
      for (const item of eventItems(receipt, "nep141", "ft_burn")) {
        if (
          item.owner_id === intentsId &&
          typeof item.memo === "string" &&
          item.memo.startsWith(WITHDRAW_MEMO_PREFIX)
        ) {
          memo = item.memo;
          break;
        }
      }
    }
    if (executor === intentsId && mtBurn === null) {
      for (const item of eventItems(receipt, "nep245", "mt_burn")) {
        const tokenIds = Array.isArray(item.token_ids) ? item.token_ids : [];
        const amounts = Array.isArray(item.amounts) ? item.amounts : [];
        const index = tokenIds.indexOf(tokenId);
        const amount: unknown = index === -1 ? undefined : amounts[index];
        if (
          typeof item.owner_id === "string" &&
          (typeof amount === "string" || typeof amount === "number")
        ) {
          mtBurn = { owner: item.owner_id, amount: String(amount) };
          break;
        }
      }
    }
  }
  return memo !== null && mtBurn !== null
    ? { memo, intents_owner: mtBurn.owner, amount: mtBurn.amount }
    : null;
}

/** A receipt status of success: `SuccessValue` or `SuccessReceiptId` (a `Failure` keeps its earlier logs). */
function succeeded(status: unknown): boolean {
  return isRecord(status) && ("SuccessValue" in status || "SuccessReceiptId" in status);
}

/** One transaction an account index lists for the vault. */
export interface TxIndexEntry {
  hash: string;
  /** True when the vault signed it (a `spend`); false for one it received (an approver's `approve`). */
  isSigner: boolean;
}

/** A transactions-by-account index (R7 source 3), used only when the caller allows the network (online). */
export interface TxIndex {
  accountTxs(accountId: string, network: Network): Promise<TxIndexEntry[]>;
}

const FASTNEAR_TX_API: Readonly<Record<Network, string>> = {
  mainnet: "https://tx.main.fastnear.com/v0/account",
  testnet: "https://tx.test.fastnear.com/v0/account",
};

/**
 * FastNEAR's transactions API (`POST /v0/account`, R7): the successful transactions of an account, oldest first,
 * 200 per page, following `resume_token` for at most `maxPages` pages. Online only: never called in tests.
 */
export function fastnearTxIndex(opts: { fetch?: typeof fetch; maxPages?: number } = {}): TxIndex {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxPages = opts.maxPages ?? 5;
  return {
    async accountTxs(accountId, network) {
      const out: TxIndexEntry[] = [];
      let resume: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const response = await doFetch(FASTNEAR_TX_API[network], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account_id: accountId,
            is_success: true,
            limit: 200,
            desc: false,
            ...(resume === undefined ? {} : { resume_token: resume }),
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`the FastNEAR tx API answered HTTP ${response.status}`);
        const body: unknown = await response.json();
        const txs = isRecord(body) && Array.isArray(body.account_txs) ? body.account_txs : null;
        if (txs === null) throw new Error("the FastNEAR tx API answered without account_txs");
        for (const tx of txs) {
          if (isRecord(tx) && typeof tx.transaction_hash === "string") {
            out.push({ hash: tx.transaction_hash, isSigner: tx.is_signer === true });
          }
        }
        resume =
          isRecord(body) && typeof body.resume_token === "string" ? body.resume_token : undefined;
        if (resume === undefined) break;
      }
      return out;
    },
  };
}

/** At most this many transactions of the index are fetched per snapshot. */
const TX_INDEX_LOOKUPS = 200;

/** The tx hashes a ledger records for a spend: its payment entries, by decision hash or by spend id. */
function ledgerTxHashes(ledger: readonly LedgerEntry[], spend: SpendView): string[] {
  const hashes: string[] = [];
  for (const entry of ledger) {
    const body = entry?.body;
    if (!isRecord(body) || body.kind !== "payment") continue;
    const refs: Record<string, unknown> = isRecord(body.refs) ? body.refs : {};
    const contract: Record<string, unknown> = isRecord(body.contract) ? body.contract : {};
    if (refs.decision_body_hash !== spend.decision_hash && contract.spend_id !== spend.id) continue;
    const settlement: Record<string, unknown> = isRecord(body.settlement) ? body.settlement : {};
    for (const hash of [settlement.burn_tx_hash, contract.tx_hash]) {
      if (typeof hash === "string" && hash.length > 0 && !hashes.includes(hash)) hashes.push(hash);
    }
  }
  return hashes;
}

export interface CollectBurnsArgs {
  rpc: RpcClient;
  /** null (or absent) disables archival lookups. */
  archivalRpc?: RpcClient | null;
  now?: Date;
  vaultId: string;
  network: Network;
  config: VaultConfig;
  spends: readonly SpendView[];
  ledger: readonly LedgerEntry[];
  /** R7 source 1, tried first: spend id to tx hashes (for example from docs/mainnet-proof.json). */
  burnTxHints?: BurnTxHints;
  /** R7 source 3, tried last, only when given (online). */
  txIndex?: TxIndex | null;
  /** Receives one line per burned spend whose burn was not found, saying where it was looked for. */
  notes?: string[];
}

type Burn = Snapshot["chain"]["burns"][number];

/**
 * The burn pair of every burned spend (R5, R7). Its transaction is looked for, in this order, among the hinted
 * hashes (`burnTxHints`), the hashes the ledger's payment entries record for the spend, and (only with
 * `txIndex`, online) the vault's transactions in the index. Each is fetched with `tx` as the vault, then as each
 * approver, on the regular RPC and the archival one (archival first for a spend older than ~2.5 days). A
 * transaction counts only when `findBurnPair` finds the pair in it, and one transaction burns for one spend.
 *
 * A spend whose burn is not found gets `status: "missing"`, with the hash of a transaction that was read and holds
 * no pair (or "" when none could be read), and a note says what was tried.
 */
export async function collectBurns(args: CollectBurnsArgs): Promise<Snapshot["chain"]["burns"]> {
  const nowNs = BigInt((args.now ?? new Date()).getTime()) * 1_000_000n;
  const archival = args.archivalRpc ?? null;
  const senders = [...new Set([args.vaultId, ...args.config.approvers])];
  // T14-R1 (I1): only the network's own intents contract and POA assets prove a burn, whatever the vault names.
  const intentsId = NETWORKS[args.network].intents;
  const assets: readonly string[] = Object.values(NETWORKS[args.network].allowedAssets);
  const used = new Set<string>();
  const burns: Burn[] = [];
  const pending: { spend: SpendView; index: number; old: boolean; read: string | null }[] = [];
  const burned = args.spends.filter((s) => s.status === "burned").sort((a, b) => a.id - b.id);

  const fetchTx = async (
    clients: readonly RpcClient[],
    hash: string,
    from: readonly string[],
  ): Promise<TxStatusResult | null> => {
    for (const client of clients) {
      for (const sender of from) {
        try {
          return await client.txStatus(hash, sender);
        } catch {
          // not under this sender, or not on this node
        }
      }
    }
    return null;
  };

  for (const spend of burned) {
    const created = /^[0-9]+$/.test(String(spend.created_at_ns)) ? BigInt(spend.created_at_ns) : 0n;
    const old = nowNs - created > ARCHIVAL_AFTER_NS;
    const clients =
      archival === null ? [args.rpc] : old ? [archival, args.rpc] : [args.rpc, archival];
    const index = burns.length;
    if (spend.destination.type !== "intents") {
      burns.push(missing(spend.id, ""));
      continue;
    }
    if (!assets.includes(spend.destination.asset)) {
      burns.push(missing(spend.id, ""));
      args.notes?.push(
        `spend ${spend.id}: asset ${spend.destination.asset} is not a POA asset of ${args.network}: not looked up`,
      );
      continue;
    }
    // A hint may name its signer (docs/mainnet-proof.json): try it first.
    const hinted = (args.burnTxHints?.get(spend.id) ?? []).map(toHint);
    const signerOf = new Map(hinted.map((h) => [h.hash, h.signer]));
    const fromLedger = ledgerTxHashes(args.ledger, spend);
    const hashes = [...new Set([...hinted.map((h) => h.hash), ...fromLedger])].filter(
      (h) => !used.has(h),
    );
    let found: Burn | null = null;
    let read: string | null = null;
    for (const hash of hashes) {
      const signer = signerOf.get(hash);
      const from = signer === undefined ? senders : [...new Set([signer, ...senders])];
      const tx = await fetchTx(clients, hash, from);
      if (tx === null) continue;
      const pair = findBurnPair(tx, spend.destination.asset, intentsId, args.network);
      if (pair === null) {
        read ??= hash;
        continue;
      }
      found = { spend_id: spend.id, tx_hash: hash, ...pair, status: "ok" };
      used.add(hash);
      break;
    }
    burns.push(found ?? missing(spend.id, read ?? ""));
    if (found === null) {
      pending.push({ spend, index, old, read });
      const where = [`${hinted.length} hinted`, `${fromLedger.length} from the ledger`].join(", ");
      const archivalNote =
        archival === null && old
          ? "; it is older than about 2.5 days and archival lookups are disabled, so the regular RPC may no longer hold its tx"
          : "";
      args.notes?.push(
        `spend ${spend.id}: no burn pair in the ${hashes.length} tx hash(es) tried (${where})${read === null ? "" : `; tx ${read} was read and holds none`}${archivalNote}`,
      );
    }
  }

  if (args.txIndex !== undefined && args.txIndex !== null && pending.length > 0) {
    let listed: TxIndexEntry[];
    try {
      listed = await args.txIndex.accountTxs(args.vaultId, args.network);
    } catch (error) {
      args.notes?.push(`the tx index could not be read: ${messageOf(error)}`);
      listed = [];
    }
    let lookups = 0;
    for (const entry of listed) {
      if (pending.length === 0 || lookups >= TX_INDEX_LOOKUPS) break;
      if (used.has(entry.hash)) continue;
      lookups++;
      const from = entry.isSigner ? [args.vaultId] : args.config.approvers;
      const tx = await fetchTx(
        archival === null ? [args.rpc] : [archival, args.rpc],
        entry.hash,
        from,
      );
      if (tx === null) continue;
      // The index says nothing about which spend a tx paid: it is the lowest pending spend whose burn pair this
      // tx holds for its own asset, address and amount. One tx burns for one spend.
      const at = pending.findIndex(({ spend }) => {
        if (spend.destination.type !== "intents") return false;
        const pair = findBurnPair(tx, spend.destination.asset, intentsId, args.network);
        return (
          pair !== null &&
          pair.memo === `${WITHDRAW_MEMO_PREFIX}${spend.destination.address}` &&
          pair.intents_owner === args.vaultId &&
          pair.amount === spend.amount
        );
      });
      const hit = pending[at];
      if (hit === undefined || hit.spend.destination.type !== "intents") continue;
      const pair = findBurnPair(tx, hit.spend.destination.asset, intentsId, args.network);
      if (pair === null) continue;
      burns[hit.index] = { spend_id: hit.spend.id, tx_hash: entry.hash, ...pair, status: "ok" };
      used.add(entry.hash);
      pending.splice(at, 1);
      args.notes?.push(
        `spend ${hit.spend.id}: burn tx ${entry.hash} found through the tx index (online)`,
      );
    }
  }
  return burns;
}

/** A hint as a hash and, when the evidence file names it, the account that signed it. */
function toHint(hint: BurnTxHint): { hash: string; signer: string | undefined } {
  return typeof hint === "string"
    ? { hash: hint, signer: undefined }
    : { hash: hint.hash, signer: typeof hint.signer === "string" ? hint.signer : undefined };
}

function missing(spendId: number, txHash: string): Burn {
  return {
    spend_id: spendId,
    tx_hash: txHash,
    memo: "",
    intents_owner: "",
    amount: "",
    status: "missing",
  };
}

/**
 * The code hashes a snapshot lists in `expected_code_hashes`: exactly the set core's check f trusts (ICR-5,
 * carries A). `KNOWN_VAULT_CODE_HASHES`, plus the canonical factory's `versions()` only when the vault names the
 * network's canonical factory. Any other factory's versions prove nothing, so they are never listed.
 */
export function expectedCodeHashes(
  network: Network,
  factory: string | null,
  versions: readonly VersionView[],
): string[] {
  const canonical = factory !== null && factory === NETWORKS[network].factory;
  return [
    ...new Set([
      ...KNOWN_VAULT_CODE_HASHES,
      ...(canonical ? versions.map((v) => v.code_hash).filter((h) => typeof h === "string") : []),
    ]),
  ];
}

export interface GatherSnapshotArgs {
  rpc: RpcClient;
  archivalRpc?: RpcClient | null;
  vaultId: string;
  network: Network;
  ledger: readonly LedgerEntry[];
  /**
   * @deprecated Ignored (ICR-5, carries A): `expected_code_hashes` is the set check f trusts, derived from
   * `KNOWN_VAULT_CODE_HASHES` and the canonical factory. A hash outside it would only fail check f.
   */
  expectedCodeHashes?: readonly string[];
  /** Kept only for `v0.probarion.near` on mainnet (`isPreLedgerVault`); every other vault gets []. */
  preLedgerDecisionHashes?: readonly Hex32[];
  burnTxHints?: BurnTxHints;
  txIndex?: TxIndex | null;
  now: Date;
  /** Receives what the snapshot could not establish: burn lookups (check h) and a factory that cannot be read (check i). */
  notes?: SnapshotNotes;
}

/** What a gathered snapshot could not establish, by the check it explains. Never part of the snapshot itself. */
export interface SnapshotNotes {
  burns: string[];
  factory: string[];
  /** Check g: the network's intents contract could not be read for a vault that names another one. */
  intents: string[];
}

/** Reads a factory the vault names. The canonical factory must answer; any other one may fail (check i fails it). */
async function readFactory(
  args: GatherSnapshotArgs,
  factoryId: string,
): Promise<{ version: number | null; versions: VersionView[] }> {
  const factory = new FactoryClient(factoryId, args.rpc);
  try {
    const [version, versions] = await Promise.all([
      factory.vaultVersion(args.vaultId),
      factory.versions(),
    ]);
    return { version, versions: Array.isArray(versions) ? versions : [] };
  } catch (error) {
    if (factoryId === NETWORKS[args.network].factory) throw error;
    args.notes?.factory.push(
      `the vault's factory ${factoryId} could not be read: ${messageOf(error)}`,
    );
    return { version: null, versions: [] };
  }
}

export async function gatherSnapshot(args: GatherSnapshotArgs): Promise<Snapshot> {
  const vault = new VaultClient(args.vaultId, args.rpc);
  const config = await vault.getConfig();
  const [accessKeys, account, anchors, spends, mandates] = await Promise.all([
    args.rpc.viewAccessKeyList(args.vaultId),
    args.rpc.viewAccount(args.vaultId),
    vault.listAllAnchors(),
    vault.listAllSpends(),
    vault.listAllMandates(),
  ]);
  // T14-R1 (I1): the vault's keys and auth flag are read in the network's own intents contract. Check g fails a
  // vault that names any other one before it looks at them, so for such a vault a failed read is only a note.
  const canonicalIntents = NETWORKS[args.network].intents;
  const intents = new IntentsClient(canonicalIntents, args.rpc);
  let intentsKeys: string[];
  let predecessorAuth: boolean;
  try {
    [intentsKeys, predecessorAuth] = await Promise.all([
      intents.publicKeysOf(args.vaultId),
      intents.isAuthByPredecessorIdEnabled(args.vaultId),
    ]);
  } catch (error) {
    if (config.intents === canonicalIntents) throw error;
    args.notes?.intents.push(
      `the vault names intents contract ${config.intents}; ${canonicalIntents} could not be read: ${messageOf(error)}`,
    );
    [intentsKeys, predecessorAuth] = [[], false];
  }
  const factory =
    config.factory === null
      ? { version: null, versions: [] as VersionView[] }
      : await readFactory(args, config.factory);
  const burns = await collectBurns({
    rpc: args.rpc,
    archivalRpc: args.archivalRpc ?? null,
    now: args.now,
    vaultId: args.vaultId,
    network: args.network,
    config,
    spends,
    ledger: args.ledger,
    ...(args.burnTxHints === undefined ? {} : { burnTxHints: args.burnTxHints }),
    ...(args.txIndex === undefined ? {} : { txIndex: args.txIndex }),
    ...(args.notes === undefined ? {} : { notes: args.notes.burns }),
  });
  return {
    v: 1,
    vault: args.vaultId,
    network: args.network,
    taken_at: args.now.toISOString(),
    ledger: [...args.ledger],
    chain: {
      access_keys: accessKeys,
      // R6: a global-mode vault has no code of its own; its identity is the global contract hash.
      code_hash: codeIdentity(account),
      config,
      anchors,
      spends,
      intents_public_keys: intentsKeys,
      intents_predecessor_auth: predecessorAuth,
      factory_version: factory.version,
      factory_versions: factory.versions,
      mandates,
      burns,
    },
    expected_code_hashes: expectedCodeHashes(args.network, config.factory, factory.versions),
    pre_ledger_decision_hashes: isPreLedgerVault(args.network, args.vaultId)
      ? [...(args.preLedgerDecisionHashes ?? [])]
      : [],
  };
}
