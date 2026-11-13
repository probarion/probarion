// Where the mainnet payouts on the landing page come from. docs/mainnet-proof.json names every mainnet spend with a
// Base transfer; the evidence folder whose outcomes list that spend gives the mandate, the ledger entries, the anchors,
// the bridge's release and the verifier's run; contracts/deployments/mainnet.json gives the vault's constants, its code
// and the owner's own wallets; contracts/code-hashes.json gives the commit of that code's reproducible build.
// scripts/record-mainnet-payout.ts and the tests read these files; the page reads nothing but the recorded file.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  base58,
  type LedgerLink,
  type MandateLimits,
  nsToIso,
  type PayoutDraft,
  type Seal,
  type SetupKind,
  type SetupStep,
  type TrailEntry,
  type TrailVerdict,
  utcDate,
  type VerifySummary,
} from "./mainnet-payout";

export interface ProofTx {
  amount_usdc: string | null;
  base_tx: string | null;
  hash: string;
  kind: string;
  network: string;
  receiver_id: string;
  recorded_at: string;
  signer_id: string;
  spend_id: number | null;
}

/** docs/mainnet-proof.json, the fields read here. */
export interface Proof {
  txs: Record<string, ProofTx>;
}

/** contracts/deployments/mainnet.json, the fields read here. */
export interface Deployment {
  constants: { intents: string; allowed_assets: string[] };
  vault_v0: { account_id: string; code_hash: string };
  /**
   * The owner's own wallets, by chain. The section says a payout was a test to the owner's own wallet, so a payout to
   * any other address stops the build until its words are written.
   */
  owner_wallets: Record<string, string[]>;
}

/** contracts/code-hashes.json, the fields read here. */
export interface CodeHashes {
  entries: { crate: string; commit: string; code_hash: string }[];
}

/** One line of a ledger file. */
export interface LedgerLine {
  body: LedgerBody;
  body_hash: string;
  sig: string;
  link: string;
}

/** One outcome-*.json of a run: what the kit recorded for one cycle. */
export interface Outcome {
  at: string;
  status: string;
  spend_id: number | null;
  spend_tx: string | null;
  anchor_tx: string | null;
  ledger_seq: number;
  ledger_entries: number;
}

export interface LedgerBody {
  vault: string;
  seq: number;
  prev_link: string;
  kind: string;
  at: string;
  invoice_hash: string;
  proposal: { action?: unknown; payee_hint?: { near_account?: unknown } } | null;
  evidence: { provider?: unknown; model?: unknown; signature?: unknown; report?: unknown } | null;
  rules: { id: string; outcome: string }[];
  verdict: string | null;
  decided_by: string | null;
  contract: { tx_hash: string | null; spend_id: number | null; status: string | null } | null;
}

interface Destination {
  type: string;
  chain?: string;
  address?: string;
  asset?: string;
}

/** The run's snapshot (`probarion snapshot`), the chain part read here. */
export interface RunSnapshot {
  chain: {
    code_hash: string;
    spends: {
      id: number;
      mandate_id: number;
      amount: string;
      invoice_hash: string;
      decision_hash: string;
      agent_pk: string;
      destination: Destination;
    }[];
    mandates: {
      id: number;
      payee: Destination;
      max_per_payment: string;
      max_total: string;
      max_uses: number;
      expires_at_ns: string;
    }[];
    anchors: { seq: number; root: string; count: number; at_ns: string }[];
  };
}

/** The verifier's JSON output (`probarion verify --json`). */
export interface VerifyJson {
  ok: boolean;
  entries: number;
  anchors: number;
  generated_at: string;
  checks: { id: string; status: string; detail: string }[];
}

/** The POA bridge's withdrawal status. */
export interface PoaStatus {
  withdrawals: {
    status: string;
    data: {
      tx_hash: string;
      transfer_tx_hash: string;
      amount: number | string;
      withdrawal_fee: string;
      withdraw_amount: string;
    };
  }[];
}

/** One evidence folder of a run that paid out to another chain (it has a poa-status.json). */
export interface RunSource {
  /** From the repository root, with forward slashes. */
  dir: string;
  /** txs.log, in order. */
  txs: { utc: string; label: string; hash: string }[];
  /** outcome-*.json, by `at`. */
  outcomes: Outcome[];
  ledger: LedgerLine[];
  /** The run's files, from the repository root. */
  files: { ledger: string; verify: string; poa: string };
  snapshot: RunSnapshot;
  verify: VerifyJson;
  poa: PoaStatus;
}

export interface Sources {
  proof: Proof;
  deployment: Deployment;
  codeHashes: CodeHashes;
  runs: RunSource[];
}

const EVIDENCE = "docs/evidence";
const SETUP_KINDS: readonly SetupKind[] = ["intents_topup", "ledger_key_set", "mandate_created"];

function parseTxsLog(text: string): RunSource["txs"] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = (head ?? "").split("\t");
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`txs.log has no ${name} column`);
    return i;
  };
  const [u, l, h] = [at("utc"), at("label"), at("hash")];
  return rows.map((r) => {
    const c = r.split("\t");
    return { utc: c[u] ?? "", label: c[l] ?? "", hash: c[h] ?? "" };
  });
}

/** Every file the payouts are built from, under `root` (the repository). */
export function readSources(root: string): Sources {
  const text = (p: string) => readFileSync(join(root, p), "utf8");
  const json = (p: string): unknown => JSON.parse(text(p));
  const runs: RunSource[] = [];
  for (const group of readdirSync(join(root, EVIDENCE), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const d of readdirSync(join(root, EVIDENCE, group.name), { withFileTypes: true })) {
      const dir = `${EVIDENCE}/${group.name}/${d.name}`;
      if (!d.isDirectory() || !existsSync(join(root, dir, "poa-status.json"))) continue;
      const files = readdirSync(join(root, dir)).sort();
      const one = (re: RegExp) => {
        const hits = files.filter((f) => re.test(f));
        if (hits.length !== 1) throw new Error(`${dir}: ${hits.length} files match ${re}`);
        return `${dir}/${hits[0]}`;
      };
      const ledgerFile = one(/^ledger-.*\.jsonl$/);
      const verifyFile = one(/^verify-.*\.json$/);
      runs.push({
        dir,
        txs: parseTxsLog(text(`${dir}/txs.log`)),
        outcomes: files
          .filter((f) => /^outcome-.*\.json$/.test(f))
          .map((f) => json(`${dir}/${f}`) as Outcome)
          .sort((a, b) => a.at.localeCompare(b.at)),
        ledger: text(ledgerFile)
          .split(/\r?\n/)
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as LedgerLine),
        files: {
          ledger: ledgerFile,
          // The text output beside the JSON one, which the page links.
          verify: verifyFile.replace(/\.json$/, ".txt"),
          poa: `${dir}/poa-status.json`,
        },
        snapshot: json(one(/^snapshot-.*\.json$/)) as RunSnapshot,
        verify: json(verifyFile) as VerifyJson,
        poa: json(`${dir}/poa-status.json`) as PoaStatus,
      });
    }
  }
  return {
    proof: json("docs/mainnet-proof.json") as Proof,
    deployment: json("contracts/deployments/mainnet.json") as Deployment,
    codeHashes: json("contracts/code-hashes.json") as CodeHashes,
    runs,
  };
}

function must<T>(v: T | undefined | null | false, what: string): T {
  if (v === undefined || v === null || v === false) throw new Error(`mainnet payout: ${what}`);
  return v;
}

/** A decimal USDC amount ("1.00") as base units ("1000000"). */
function units(amount: string): string {
  const m = must(/^(\d+)(?:\.(\d{1,6}))?$/.exec(amount), `amount ${amount}`);
  return (BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

/** link = sha256(prev_link || body_hash || raw signature), with node:crypto: the builder's own check of the file. */
function nodeLink(l: LedgerLine): string {
  const sig = base58(l.sig.replace(/^ed25519:/, ""));
  if (sig === null || sig.length !== 64) throw new Error(`mainnet payout: entry ${l.body.seq} sig`);
  return createHash("sha256")
    .update(Buffer.from(l.body.prev_link, "hex"))
    .update(Buffer.from(l.body_hash, "hex"))
    .update(sig)
    .digest("hex");
}

function trailEntry(l: LedgerLine, asset: string): TrailEntry {
  const b = l.body;
  if (b.kind !== "decision" && b.kind !== "payment") {
    throw new Error(`mainnet payout: entry ${b.seq} kind ${b.kind}`);
  }
  const kind: TrailEntry["kind"] = b.kind;
  const verdict = b.verdict === null ? null : (b.verdict as TrailVerdict);
  if (verdict !== null && !["allow", "hold", "refuse"].includes(verdict)) {
    throw new Error(`mainnet payout: entry ${b.seq} verdict ${verdict}`);
  }
  const decidedBy = b.decided_by === null ? null : (b.decided_by as TrailEntry["decidedBy"]);
  if (decidedBy !== null && decidedBy !== "model+rules" && decidedBy !== "rules-only") {
    throw new Error(`mainnet payout: entry ${b.seq} decided_by ${decidedBy}`);
  }
  const ev = b.evidence;
  const model = ev !== null && typeof ev.model === "string" ? ev.model : null;
  const action =
    b.proposal !== null && typeof b.proposal.action === "string" ? b.proposal.action : null;
  const c = b.contract;
  return {
    seq: b.seq,
    kind,
    at: b.at,
    verdict,
    decidedBy,
    model,
    attested:
      ev !== null && ev.provider === "near-ai-cloud" && ev.signature != null && ev.report != null,
    action,
    refusedBy: b.rules.filter((r) => r.outcome === "refuse").map((r) => r.id),
    rulesPassed: b.rules.filter((r) => r.outcome === "pass").length,
    rulesTotal: b.rules.length,
    hintIsAsset: b.proposal?.payee_hint?.near_account === asset,
    spend:
      kind === "payment" && c !== null && c.spend_id !== null && c.tx_hash !== null
        ? { id: c.spend_id, status: c.status ?? "", tx: c.tx_hash }
        : null,
    bodyHash: l.body_hash,
  };
}

function verifySummary(v: VerifyJson): VerifySummary {
  const n = (status: string) => v.checks.filter((c) => c.status === status).length;
  const e = v.checks.find((c) => c.id === "e");
  return {
    ok: v.ok,
    passed: n("pass"),
    failed: n("fail"),
    unproven: n("unproven"),
    skipped: n("skip"),
    entries: v.entries,
    anchors: v.anchors,
    at: v.generated_at,
    quoteOnline: e !== undefined && !e.detail.includes("quote not verified offline"),
  };
}

function draft(t: ProofTx, src: Sources, byHash: ReadonlyMap<string, ProofTx>): PayoutDraft {
  const vault = t.receiver_id;
  must(t.signer_id === vault, `spend ${t.hash} was not sent by the vault`);
  const spendId = must(t.spend_id, `spend ${t.hash} has no spend_id`);
  const amount = units(must(t.amount_usdc, `spend ${t.hash} has no amount`));
  const baseTx = must(t.base_tx, `spend ${t.hash} has no base_tx`);
  const run = must(
    src.runs.find((r) => r.outcomes.some((o) => o.spend_tx === t.hash)),
    `no evidence folder has an outcome for spend ${t.hash}`,
  );
  const outcome = must(
    run.outcomes.find((o) => o.spend_tx === t.hash),
    "outcome",
  );
  const chain = run.snapshot.chain;
  const spend = must(
    chain.spends.find((s) => s.id === spendId),
    `${run.dir}: the snapshot has no spend ${spendId}`,
  );
  must(spend.amount === amount, `spend ${spendId} is ${spend.amount}, the proof says ${amount}`);
  const dest = spend.destination;
  const mandate = must(
    chain.mandates.find((m) => m.id === spend.mandate_id),
    `${run.dir}: the snapshot has no mandate ${spend.mandate_id}`,
  );
  must(
    dest.type === "intents" &&
      typeof dest.chain === "string" &&
      typeof dest.address === "string" &&
      typeof dest.asset === "string" &&
      JSON.stringify(mandate.payee) === JSON.stringify(dest),
    `spend ${spendId} does not pay its mandate's intents payee`,
  );
  const asset = dest.asset as string;
  must(src.deployment.constants.allowed_assets.includes(asset), `${asset} is not an allowed asset`);
  const payee = dest.address as string;
  const own = src.deployment.owner_wallets[dest.chain as string] ?? [];
  must(
    own.some((w) => w.toLowerCase() === payee.toLowerCase()),
    `spend ${spendId} pays ${payee}, which owner_wallets in contracts/deployments/mainnet.json does not list: the section's words are for a test to the owner's own wallet`,
  );
  const v0 = src.deployment.vault_v0;
  must(v0.account_id === vault, `${vault} is not vault_v0 in contracts/deployments/mainnet.json`);
  must(chain.code_hash === v0.code_hash, `${run.dir}: the snapshot's code is not ${v0.code_hash}`);
  const build = must(
    src.codeHashes.entries.find(
      (e) => e.crate === "probarion-vault" && e.code_hash === v0.code_hash,
    ),
    `${v0.code_hash} is no recorded vault build in contracts/code-hashes.json`,
  );
  const baseToken = must(
    /^base-(0x[0-9a-f]{40})\.omft\.near$/.exec(asset),
    `${asset} is no Base token`,
  )[1];
  const release = must(
    run.poa.withdrawals.find((w) => w.data.tx_hash === t.hash && w.status === "COMPLETED"),
    `${run.dir}: no completed POA withdrawal for ${t.hash}`,
  ).data;
  must(release.transfer_tx_hash === baseTx, `the POA transfer is not ${baseTx}`);
  must(String(release.amount) === amount, `the POA withdrawal is ${release.amount}`);
  must(
    BigInt(release.withdraw_amount) + BigInt(release.withdrawal_fee) === BigInt(amount),
    "the release and the fee do not add up to the burn",
  );
  const sealOf = (o: Outcome): Seal => {
    const a = must(
      chain.anchors.find((x) => x.count === o.ledger_entries),
      `${run.dir}: no anchor of ${o.ledger_entries} entries`,
    );
    const anchorTx = must(o.anchor_tx, "anchor_tx");
    must(byHash.get(anchorTx)?.kind === "anchor", `${anchorTx} is no anchor in the proof`);
    return { seq: a.seq, count: a.count, root: a.root, tx: anchorTx, at: nsToIso(a.at_ns) };
  };
  const anchor = sealOf(outcome);
  const anchorProof = must(byHash.get(anchor.tx), "anchor proof");
  const runTxs = run.txs.flatMap((x) => {
    const p = byHash.get(x.hash);
    return p === undefined ? [] : [{ ...p, logged: x.utc }];
  });
  const mandateTxs = runTxs.filter((x) => x.kind === "mandate_created" && x.receiver_id === vault);
  must(mandateTxs.length === 1, `${run.dir}: ${mandateTxs.length} mandate transactions in txs.log`);
  const mandateTx = mandateTxs[0] as ProofTx;
  const setup: SetupStep[] = runTxs
    .filter((x) => (SETUP_KINDS as readonly string[]).includes(x.kind))
    .map((x) => ({
      kind: x.kind as SetupKind,
      tx: x.hash,
      amount: x.kind === "intents_topup" ? units(must(x.amount_usdc, "top-up amount")) : null,
      at: new Date(x.logged).toISOString(),
    }));
  const ledger = run.ledger
    .filter((l) => l.body.vault === vault)
    .sort((a, b) => a.body.seq - b.body.seq);
  ledger.forEach((l, i) => {
    must(l.body.seq === i, `${run.dir}: the ledger's entry ${i} has seq ${l.body.seq}`);
    must(nodeLink(l) === l.link, `${run.dir}: entry ${i}'s link does not recompute`);
    must(i === 0 || l.body.prev_link === ledger[i - 1]?.link, `${run.dir}: entry ${i}'s prev_link`);
  });
  const entries = ledger.filter((l) => l.body.invoice_hash === spend.invoice_hash);
  const payment = must(
    entries.find((l) => l.body.kind === "payment" && l.body.contract?.tx_hash === t.hash),
    `${run.dir}: no payment entry for ${t.hash}`,
  ).body;
  must(anchor.count > payment.seq, `anchor ${anchor.seq} does not cover the payment entry`);
  must(
    ledger[anchor.count - 1]?.link === anchor.root,
    `anchor ${anchor.seq}'s root is not the ledger's`,
  );
  const decision = must(
    entries
      .filter(
        (l) => l.body.kind === "decision" && l.body.verdict === "allow" && l.body.seq < payment.seq,
      )
      .at(-1),
    `${run.dir}: no allow before the payment entry`,
  );
  must(
    decision.body_hash === spend.decision_hash,
    `spend ${spendId}'s decision_hash is not entry ${decision.body.seq}'s body hash`,
  );
  const links: LedgerLink[] = ledger.slice(decision.body.seq, anchor.count).map((l) => ({
    seq: l.body.seq,
    prevLink: l.body.prev_link,
    bodyHash: l.body_hash,
    sig: l.sig,
  }));
  const limits: MandateLimits = {
    id: mandate.id,
    maxPerPayment: mandate.max_per_payment,
    maxTotal: mandate.max_total,
    maxUses: mandate.max_uses,
    expiresAtNs: mandate.expires_at_ns,
  };
  return {
    id: `spend-${spendId}`,
    date: utcDate(payment.at),
    vault,
    intents: src.deployment.constants.intents,
    chain: dest.chain as string,
    asset,
    baseToken: must(baseToken, "base token"),
    payee,
    mandate: limits,
    agentKey: spend.agent_pk,
    spendId,
    invoiceHash: spend.invoice_hash,
    amount,
    received: release.withdraw_amount,
    fee: release.withdrawal_fee,
    anchor: { seq: anchor.seq, count: anchor.count, root: anchor.root },
    decision: { seq: decision.body.seq, bodyHash: decision.body_hash },
    links,
    build: { codeHash: v0.code_hash, commit: build.commit },
    tx: {
      mandate: { hash: mandateTx.hash, sender: mandateTx.signer_id },
      spend: { hash: t.hash, sender: t.signer_id },
      anchor: { hash: anchor.tx, sender: anchorProof.signer_id },
      base: baseTx,
    },
    setup,
    trail: entries.filter((l) => l.body.seq <= payment.seq).map((l) => trailEntry(l, asset)),
    seals: run.outcomes.filter((o) => o.anchor_tx !== null).map(sealOf),
    verify: verifySummary(run.verify),
    source: run.dir,
    files: run.files,
  };
}

/** The payouts the data names, from the oldest: one per mainnet spend in the proof file with a Base transfer. */
export function draftPayouts(src: Sources): PayoutDraft[] {
  const mainnet = Object.values(src.proof.txs).filter((t) => t.network === "mainnet");
  const byHash = new Map(mainnet.map((t) => [t.hash, t]));
  return mainnet
    .filter((t) => typeof t.base_tx === "string")
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
    .map((t) => draft(t, src, byHash));
}
