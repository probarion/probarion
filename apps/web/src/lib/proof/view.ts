import {
  type CheckId,
  firstBrokenSeq,
  isNearAccountId,
  isNearTxHash,
  type Snapshot,
  type VerifyReport,
} from "@probarion/core";
import { isPreLedgerVault } from "@probarion/sdk";
import { explorerAccountUrl, explorerTxUrl, type Network } from "@/lib/config";
import { formatUsdc } from "@/lib/near/units";
import { cli, PRE_LEDGER_FLAGS } from "./cli";
import { ledgerFileName } from "./ledger-file";
import { safeText } from "./sanitize";

// What /proof shows, as plain data. Every string that came from the ledger or the chain goes through `safeText`, and
// only a well-formed tx hash or account id becomes an explorer link (plan 03 Task 16 carry).

/** A check's status as the page shows it. Anything core does not define today is "unknown", never a pass. */
export type ProofStatus = "pass" | "fail" | "skip" | "unproven" | "unknown";

/** Evidence for a check. `href` is null when the value cannot be linked; the label then says why. */
export interface ProofLink {
  label: string;
  href: string | null;
}

export interface ProofRow {
  id: CheckId;
  name: string;
  status: ProofStatus;
  detail: string;
  firstBrokenSeq?: number;
  links: ProofLink[];
}

const STATUSES: readonly string[] = ["pass", "fail", "skip", "unproven"];
const DIGITS = /^(0|[1-9][0-9]*)$/;
const ATTESTATION_DOCS = "https://docs.near.ai/cloud/verification";
/** A check detail is core's own sentence with values in it, so it gets more room than one value. */
const DETAIL_MAX = 1000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A value a record names as its tx: anything but null, undefined or "". */
const named = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

function txLink(network: Network, hash: unknown, label: string): ProofLink {
  return isNearTxHash(hash)
    ? { label, href: explorerTxUrl(network, hash) }
    : { label: `${label}: malformed tx hash`, href: null };
}

function accountLink(network: Network, account: unknown, label?: string): ProofLink {
  return isNearAccountId(account)
    ? { label: label ?? account, href: explorerAccountUrl(network, account) }
    : { label: `${safeText(account)}: not an account id`, href: null };
}

/** The last `n` ledger entries of `kind` that name a contract tx, labelled by kind and seq ("payment tx, seq 3"). */
function lastTxs(s: Snapshot, kind: string, network: Network, n = 3): ProofLink[] {
  return listOf(s.ledger)
    .filter(
      (e): e is { body: { seq: unknown; contract: { tx_hash: unknown } } } =>
        isObject(e) &&
        isObject(e.body) &&
        e.body.kind === kind &&
        isObject(e.body.contract) &&
        named(e.body.contract.tx_hash),
    )
    .slice(-n)
    .map((e) =>
      txLink(network, e.body.contract.tx_hash, `${kind} tx, seq ${safeText(e.body.seq)}`),
    );
}

function burnsOf(s: Snapshot): Record<string, unknown>[] {
  return listOf(isObject(s.chain) ? s.chain.burns : undefined).filter(isObject);
}

/** What a reader clicks to check each claim on the explorer. Check c always has at least the vault's anchor calls. */
export function proofRows(report: VerifyReport, s: Snapshot, network: Network): ProofRow[] {
  const config: Record<string, unknown> =
    isObject(s.chain) && isObject(s.chain.config) ? s.chain.config : {};
  const vault = accountLink(network, s.vault, "Vault account and keys");
  const links: Record<CheckId, ProofLink[]> = {
    a: [vault],
    b: [
      {
        label: "snapshot.json",
        href: isNearAccountId(s.vault) ? `/proof/${s.vault}/snapshot.json` : null,
      },
    ],
    // The SDK anchors by a transaction that no ledger entry records, so anchor entries are rare: the vault's own
    // explorer page, where its `anchor` calls are, is always there (R20).
    c: [
      ...lastTxs(s, "anchor", network),
      accountLink(network, s.vault, "Anchor calls on the vault"),
    ],
    d: lastTxs(s, "payment", network),
    // Each decision, with A1 to A7 on its own, is in the page's Decisions section (G7).
    e: [
      { label: "Each decision, below", href: "#decisions" },
      { label: "How NEAR AI Cloud attestation works", href: ATTESTATION_DOCS },
    ],
    f: [vault],
    g: [accountLink(network, config.intents)],
    h: burnsOf(s)
      .filter((b) => named(b.tx_hash))
      .slice(-3)
      .map((b) => txLink(network, b.tx_hash, `burn tx for spend #${safeText(b.spend_id)}`)),
    i:
      config.factory === null || config.factory === undefined
        ? []
        : [accountLink(network, config.factory)],
  };
  return listOf(report.checks)
    .filter(isObject)
    .map((c) => {
      // Core's ids are a to i; any other id gets no evidence (and never an inherited property of `links`).
      const id = c.id as CheckId;
      const status =
        typeof c.status === "string" && STATUSES.includes(c.status) ? c.status : "unknown";
      return {
        id,
        name: safeText(c.name),
        status: status as ProofStatus,
        detail: safeText(c.detail, DETAIL_MAX),
        ...(typeof c.firstBrokenSeq === "number" ? { firstBrokenSeq: c.firstBrokenSeq } : {}),
        links: Object.hasOwn(links, id) ? links[id] : [],
      };
    });
}

export interface BurnRow {
  spendId: string;
  /** The burn tx on the explorer, or null when the record names none or a malformed one (`txNote` says which). */
  txUrl: string | null;
  txNote: string | null;
  memo: string;
  amount: string;
  intentsOwner: string;
  intentsOwnerUrl: string | null;
  status: "ok" | "missing" | "unavailable" | "unknown";
}

const BURN_STATUSES: readonly string[] = ["ok", "missing", "unavailable"];

/** An amount in USDC base units (6 decimals), or the raw text, marked, when it is not a whole number. */
function usdcText(amount: unknown): string {
  return typeof amount === "string" && DIGITS.test(amount)
    ? `${formatUsdc(amount)} USDC`
    : `${safeText(amount)} (not a USDC amount)`;
}

/** The burn pairs check h read (D9): memo, amount and the intents owner, each with its tx. */
export function burnRows(s: Snapshot, network: Network): BurnRow[] {
  return burnsOf(s).map((b) => {
    const tx = isNearTxHash(b.tx_hash);
    return {
      spendId: safeText(b.spend_id),
      txUrl: tx ? explorerTxUrl(network, b.tx_hash as string) : null,
      txNote: tx ? null : named(b.tx_hash) ? "malformed tx hash" : "no tx recorded",
      memo: safeText(b.memo),
      amount: usdcText(b.amount),
      intentsOwner: safeText(b.intents_owner),
      intentsOwnerUrl: isNearAccountId(b.intents_owner)
        ? explorerAccountUrl(network, b.intents_owner)
        : null,
      status:
        typeof b.status === "string" && BURN_STATUSES.includes(b.status)
          ? (b.status as BurnRow["status"])
          : "unknown",
    };
  });
}

export interface UnprovenRow {
  spendId: string;
  reason: string;
  /** The reason in plain words. */
  why: string;
  /** The CLI command that can prove it, with the CLI's own flag syntax. */
  hint: string;
}

const WHY: ReadonlyMap<string, string> = new Map([
  [
    "tx_unavailable",
    "Its burn transaction could not be read right now (a node outage, or a transaction old enough to need an archival RPC).",
  ],
  [
    "approver_tx",
    "An approver paid this held spend out. Its burn is in the approver's transaction, which was not read.",
  ],
  ["not_recorded", "No payment entry in the ledger names the transaction that burned it."],
  [
    "pre_ledger_no_tx",
    "It predates the signed ledger, and nobody has supplied the transaction that burned it.",
  ],
]);

/**
 * The command that re-reads the vault's chain with its signed ledger: the error views offer it, and every unproven
 * hint is built on it. Without `--ledger` the CLI would check the chain against an empty ledger, and any vault with an
 * anchor would fail. The one vault whose check d needs the documented Day-4 decisions (mainnet v0, the SDK's
 * `isPreLedgerVault`) also gets the evidence flags, as does a hint for a pre-ledger spend (`preLedger`).
 */
export function chainCommand(
  network: Network,
  vault: string,
  preLedger: boolean = isPreLedgerVault(network, vault),
): string {
  const evidence = preLedger ? ` ${PRE_LEDGER_FLAGS}` : "";
  return cli(
    `verify --network ${network} --vault ${vault} --ledger ${ledgerFileName(vault)}${evidence}`,
  );
}

/** Each burn check h could not prove, why, and how to prove it (T14-R2). */
export function unprovenRows(report: VerifyReport, network: Network, vault: string): UnprovenRow[] {
  // The ledger of a web vault is in the database, not on the visitor's disk: without --ledger the CLI would check
  // the chain against an empty ledger and fail. The page links the vault's ledger file for it. One source: every
  // hint starts with chainCommand, so a flag added there reaches the hints too.
  return listOf(report.unproven)
    .filter(isObject)
    .map((u) => {
      const reason = safeText(u.reason);
      const id =
        typeof u.spend_id === "number" && Number.isSafeInteger(u.spend_id) && u.spend_id >= 0
          ? String(u.spend_id)
          : "<spend_id>";
      // A pre-ledger spend (mainnet v0 only) needs the documented Day-4 decisions, in the repository's docs/evidence.
      const verify = chainCommand(
        network,
        vault,
        reason === "pre_ledger_no_tx" || isPreLedgerVault(network, vault),
      );
      return {
        spendId: safeText(u.spend_id),
        reason,
        why: WHY.get(reason) ?? `This page does not know the reason ${reason}.`,
        hint:
          reason === "tx_unavailable"
            ? `${verify} --archival-rpc <archival RPC URLs>`
            : `${verify} --burn-tx ${id}=<tx hash>`,
      };
    });
}

export type Headline = "ok" | "unproven" | "failed";

/** The three headline states. R19: never "All checks pass": the page runs the offline checks only. */
export const HEADLINE_TEXT: Readonly<Record<Headline, string>> = {
  ok: "All offline checks pass",
  unproven: "Not proven yet",
  failed: "A check failed",
};

/** Red for any failed check; green only for an ok report whose every check passed or was skipped; else amber. */
export function headline(report: VerifyReport): Headline {
  const statuses = listOf(report.checks).map((c) => (isObject(c) ? c.status : undefined));
  if (statuses.includes("fail")) return "failed";
  const clean = statuses.length > 0 && statuses.every((s) => s === "pass" || s === "skip");
  return report.ok === true && clean ? "ok" : "unproven";
}

/** One sentence under the headline: what failed and where, or what is not proven. */
export function headlineNote(report: VerifyReport): string {
  const state = headline(report);
  if (state === "ok") {
    // Only check i can skip (a vault outside the factory); say so rather than imply it ran.
    const skipped = listOf(report.checks)
      .filter((c): c is Record<string, unknown> => isObject(c) && c.status === "skip")
      .map((c) => ` Check (${safeText(c.id)}) was skipped: ${safeText(c.detail)}.`);
    return `No check failed or is unproven on this snapshot.${skipped.join("")}`;
  }
  if (state === "unproven") {
    const n = listOf(report.unproven).length;
    return n > 0
      ? `No check failed, but ${n} burned ${n === 1 ? "spend is" : "spends are"} not proven from this snapshot. Check (h) says what is missing.`
      : "No check failed, but not every check could be proven.";
  }
  const failed = listOf(report.checks)
    .filter((c) => isObject(c) && c.status === "fail")
    .map((c) => `(${safeText((c as Record<string, unknown>).id)})`);
  const seq = firstBrokenSeq(report);
  const where = seq === null ? "" : ` The first broken ledger entry is seq ${seq}.`;
  return `Failed: ${failed.length === 1 ? "check" : "checks"} ${failed.join(", ")}.${where}`;
}

/** `/proof` with no vault shows the demo vault (PROBARION_VAULT_ID), as plan 05 documents. */
export function proofIndexTarget(demoVault: string | null): string | null {
  return demoVault !== null && isNearAccountId(demoVault) ? `/proof/${demoVault}` : null;
}

/**
 * How many ledger entries check e may hold to a model's output: every decision that is not exactly rules-only (a null
 * or unknown `decided_by` included, which check e fails), and any entry decided by model and rules, whatever its
 * kind. With none, every decision is rules-only (even one that carries evidence), and the line under the checks says
 * check e has no model output to prove.
 */
export function modelDecisionCount(s: Snapshot): number {
  return listOf(s.ledger).filter(
    (e) =>
      isObject(e) &&
      isObject(e.body) &&
      ((e.body.kind === "decision" && e.body.decided_by !== "rules-only") ||
        e.body.decided_by === "model+rules"),
  ).length;
}
