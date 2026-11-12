import type { ReactNode } from "react";
import { RouteLink } from "@/components/RouteLink";
import { NextStep } from "@/components/site/NextStep";
import {
  Badge,
  brandCardClass,
  ExternalLink,
  inkPillClass,
  linePillClass,
  Notice,
  PANEL_TONES,
  type PanelTone,
  type Tone,
} from "@/components/ui";
import type { Network } from "@/lib/config";
import type { TenantKind } from "@/lib/db/tenants";
import {
  CLI_NOTE,
  CLI_ON_NPM,
  CLI_SETUP_LINES,
  cli,
  EVIDENCE_CLONE,
  needsEvidenceClone,
} from "@/lib/proof/cli";
import type { DecisionRow } from "@/lib/proof/decisions";
import { ledgerFileName } from "@/lib/proof/ledger-file";
import { safeText } from "@/lib/proof/sanitize";
import type { ProofErrorReason, ProofOk } from "@/lib/proof/service";
import { snapshotFileName } from "@/lib/proof/snapshot-file";
import {
  type BurnRow,
  burnRows,
  chainCommand,
  HEADLINE_TEXT,
  type Headline,
  headline,
  headlineNote,
  modelDecisionCount,
  type ProofLink,
  type ProofRow,
  type ProofStatus,
  proofRows,
  type UnprovenRow,
  unprovenRows,
} from "@/lib/proof/view";
import { NEXT_STEP } from "@/lib/site/next-step";
import { OpenLinkedDecision } from "./DecisionLinks";
import { DecisionLine, DecisionPanel } from "./DecisionPanel";

// The public proof page, as a server component with no data access of its own: page.tsx loads the result and
// hands it here, with the snapshot's decision rows. The result comes first, then the checks, each decision, the burns
// and the steps to verify it yourself.

const KIND_LABEL: Readonly<Record<TenantKind, string>> = {
  team: "Team vault",
  external: "External owner",
  canary: "Canary challenge",
};

/** Status colours carry meaning: green passed, amber not proven (or no result), red failed. */
const PANEL: Readonly<Record<Headline | "error", PanelTone>> = {
  ok: "good",
  unproven: "warn",
  failed: "bad",
  error: "warn",
};

const STATUS: Readonly<Record<ProofStatus, { tone: Tone; label: string }>> = {
  pass: { tone: "good", label: "pass" },
  fail: { tone: "bad", label: "fail" },
  skip: { tone: "neutral", label: "skipped" },
  unproven: { tone: "warn", label: "not proven" },
  unknown: { tone: "neutral", label: "unknown" },
};

const BURN_STATUS: Readonly<Record<BurnRow["status"], { tone: Tone; label: string }>> = {
  ok: { tone: "good", label: "pair found" },
  missing: { tone: "bad", label: "no pair" },
  unavailable: { tone: "warn", label: "not read" },
  unknown: { tone: "neutral", label: "unknown" },
};

// The underline is the only cue (link and text are both dark), so it reads at 5:1 on white.
const link = "text-ink underline decoration-ink/60 hover:decoration-ink";
const section = brandCardClass;
// Under 24px, so the regular weight, not the light one the large headings use.
const sectionTitle = "text-lg font-normal tracking-tight text-ink sm:text-xl";
/** The site's grey for small text: 7:1 or more on paper and on a white card (globals.css). */
const muted = "text-mute";
const codeBlock =
  "mt-1 block rounded-2xl bg-ink px-3 py-2 font-mono text-xs text-paper wrap-anywhere";

/** "2026-11-09 10:00 UTC" for an ISO time; anything else is shown as text. */
function when(iso: unknown): string {
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return safeText(iso);
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function Evidence({ links }: { links: readonly ProofLink[] }) {
  if (links.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {links.map((l) =>
        l.href === null ? (
          <li key={l.label} className={muted}>
            {l.label}
          </li>
        ) : (
          <li key={l.href}>
            {l.href.startsWith("/") || l.href.startsWith("#") ? (
              <a className={link} href={l.href}>
                {l.label}
              </a>
            ) : (
              <ExternalLink className={link} href={l.href}>
                {l.label}
              </ExternalLink>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

/** The vault's ledger file the commands pass as `--ledger`: a download, so it works in every shell. */
function LedgerLink({ vault }: { vault: string }) {
  const file = ledgerFileName(vault);
  return (
    <a className={link} href={`/proof/${vault}/ledger.jsonl`} download={file}>
      {file}
    </a>
  );
}

const INTO_REPO = CLI_ON_NPM ? "" : "into the repository folder ";
/** The ledger is live: fetch it right before the command, and again once the vault has acted. */
const JUST_BEFORE =
  "just before you run the command (replace any earlier copy; again if the vault has acted since), then run:";

/** With npx, a pre-ledger command reads the repository's evidence files from a clone in the same folder. */
function EvidenceClone({ command }: { command: string }) {
  if (!needsEvidenceClone(command)) return null;
  return (
    <p className="mt-1 text-xs">
      It also reads the repository&apos;s evidence files: in the same folder, first run{" "}
      <code>{EVIDENCE_CLONE}</code>.
    </p>
  );
}

function Unproven({ vault, rows }: { vault: string; rows: readonly UnprovenRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="mt-3 space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      {rows.map((u) => (
        <li key={`${u.spendId}-${u.reason}`}>
          <p>
            <span className="font-medium">Spend #{u.spendId}</span> ({u.reason}): {u.why}
          </p>
          <p className="mt-1 text-xs">
            Download <LedgerLink vault={vault} />{" "}
            {CLI_ON_NPM ? "" : "into the repository folder (set up below) "}
            {JUST_BEFORE}
          </p>
          <code className={codeBlock}>{u.hint}</code>
          <EvidenceClone command={u.hint} />
          {u.hint.includes("<tx hash>") ? (
            <p className="mt-1 text-xs">
              Find the tx hash on the vault&apos;s explorer page: the transaction that paid the
              spend, or the approver&apos;s approve transaction.
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CheckItem({
  vault,
  row,
  unproven,
}: {
  vault: string;
  row: ProofRow;
  unproven: readonly UnprovenRow[];
}) {
  const status = STATUS[row.status] ?? STATUS.unknown;
  return (
    <li className="py-4" data-check={row.id} data-status={row.status} id={`check-${row.id}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm text-ink">
          <span className={`font-mono ${muted}`}>({row.id})</span>{" "}
          <span className="font-mono">{row.name}</span>
        </h3>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className={`mt-1 text-sm ${muted} wrap-anywhere`}>{row.detail}</p>
      {row.firstBrokenSeq !== undefined ? (
        <p className="mt-1 text-xs font-medium text-rose-800">
          First broken ledger entry: seq {row.firstBrokenSeq}
        </p>
      ) : null}
      <Evidence links={row.links} />
      {row.id === "h" ? <Unproven vault={vault} rows={unproven} /> : null}
    </li>
  );
}

function Burns({ burns }: { burns: readonly BurnRow[] }) {
  if (burns.length === 0) return null;
  return (
    <section className={section} aria-labelledby="burns">
      <h2 id="burns" className={sectionTitle}>
        Cross-chain withdrawals
      </h2>
      <p className={`mt-1 text-sm ${muted}`}>
        The burn pairs check (h) read: the POA token&apos;s burn memo names the payee&apos;s
        address, and the vault&apos;s intents burn is for the spend amount.
      </p>
      <ul className="mt-2 divide-y divide-ink/10">
        {burns.map((b) => {
          const status = BURN_STATUS[b.status];
          return (
            <li
              key={`${b.spendId}|${b.txUrl ?? b.txNote}|${b.memo}|${b.amount}`}
              className="py-4 text-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium text-ink">
                  {b.txUrl === null ? (
                    <>
                      Spend #{b.spendId}{" "}
                      <span className={`font-normal ${muted}`}>({b.txNote})</span>
                    </>
                  ) : (
                    <ExternalLink className={link} href={b.txUrl}>
                      Spend #{b.spendId} burn tx
                    </ExternalLink>
                  )}
                </p>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className={muted}>Memo</dt>
                <dd className="font-mono wrap-anywhere">{b.memo}</dd>
                <dt className={muted}>Amount</dt>
                <dd>{b.amount}</dd>
                <dt className={muted}>Intents owner</dt>
                <dd className="font-mono wrap-anywhere">
                  {b.intentsOwnerUrl === null ? (
                    b.intentsOwner
                  ) : (
                    <ExternalLink className={link} href={b.intentsOwnerUrl}>
                      {b.intentsOwner}
                    </ExternalLink>
                  )}
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Header({
  vault,
  eyebrow,
  children,
}: {
  vault: string;
  eyebrow: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-gold-ink">
        {eyebrow}
      </p>
      <h1 className="font-mono text-2xl tracking-tight text-ink break-all sm:text-3xl">{vault}</h1>
      {children}
    </header>
  );
}

function Panel({
  state,
  title,
  children,
}: {
  state: Headline | "error";
  title: string;
  children: ReactNode;
}) {
  const p = PANEL_TONES[PANEL[state]];
  return (
    <section
      className={`mb-6 rounded-3xl border p-5 sm:p-7 ${p.box}`}
      data-headline={state}
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-full ${p.dot}`} />
        <h2 className="text-2xl font-light tracking-tight sm:text-3xl">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function VerifyYourself({
  vault,
  network,
  takenAt,
}: {
  vault: string;
  network: Network;
  takenAt: string;
}) {
  const file = snapshotFileName(vault);
  return (
    <section className={section} id="verify" aria-labelledby="verify-title">
      <h2 id="verify-title" className={sectionTitle}>
        Verify it yourself, offline
      </h2>
      <CliSetup />
      <ol className="mt-3 list-decimal space-y-4 pl-5 text-sm text-ink/80">
        <li>
          <a className={link} href={`/proof/${vault}/snapshot.json`} download={file}>
            Download {file}
          </a>
          : a snapshot of this vault (its ledger and chain data), taken when you click or shortly
          before. The verifier prints when it was taken. If it prints <code>{takenAt}</code>, it is
          the very snapshot these checks used, and a verifier built from the current repository
          gives the same result; otherwise it is another snapshot of this vault, and its result can
          differ from this page.
        </li>
        <li>
          {CLI_ON_NPM
            ? "In the folder that holds the file, run"
            : "From the repository folder, with the file in it, run"}{" "}
          the open-source verifier. It needs no network and no keys, and prints the result per check
          for that snapshot:
          <code className={codeBlock}>{cli(`verify --offline ${file}`)}</code>
        </li>
        <li>
          To read the chain half again instead of trusting the file, download{" "}
          <LedgerLink vault={vault} /> {INTO_REPO}
          {JUST_BEFORE}
          <code className={codeBlock}>{chainCommand(network, vault)}</code>
          <EvidenceClone command={chainCommand(network, vault)} />
        </li>
      </ol>
      <p className={`mt-5 border-t border-ink/10 pt-4 text-xs ${muted}`}>
        What this cannot prove: that the TEE hardware is honest, that the POA bridge operator
        releases funds on Base, or how the Intents Verifier DAO uses its roles. See{" "}
        <RouteLink route="/security" className={link}>
          Security
        </RouteLink>
        .
        {network === "testnet"
          ? " On testnet, NEAR Intents is a stub contract (Intents has no testnet), so a burn here shows the flow, not a real withdrawal."
          : null}
      </p>
    </section>
  );
}

/**
 * The line before the commands: on npm, what npx needs; while the CLI is not on npm, one line saying so and the
 * one-time set-up of the repository command.
 */
function CliSetup() {
  if (CLI_ON_NPM) return <p className="mt-3 text-sm text-ink/80">{CLI_NOTE}</p>;
  return (
    <p className="mt-3 text-sm text-ink/80">
      {CLI_NOTE} Set up once, one command per line:
      {/* Real newlines between the commands (whitespace-pre-wrap keeps them on screen), and one before the first and
          one after the last. A browser collapses those two, since the <code> is a block: they matter only in extracted
          text, where they keep the commands apart from the prose around them. */}
      {"\n"}
      <code className={`${codeBlock} whitespace-pre-wrap`}>{CLI_SETUP_LINES.join("\n")}</code>
      {"\n"}
    </p>
  );
}

/**
 * The fixed line under the checks (R19), true to what check e did on this snapshot. With no decision made with model
 * output (every one rules-only, even one that carries evidence), check e has none to prove. Otherwise it is said per
 * attested decision, and a decision that used the model without an attestation shows as a failed check e above.
 */
function AttestationLine({ modelDecisions }: { modelDecisions: number }) {
  const limits = (
    <>
      it does not verify the TDX quote (needs <code>--online</code>, and even then the measurement
      is not pinned) or the request (needs the invoice, A8).
    </>
  );
  return (
    <p className={`mt-2 border-t border-ink/10 pt-4 text-xs ${muted}`}>
      {modelDecisions === 0 ? (
        <>
          No decision in this snapshot was decided with model output, so check (e) has none to prove
          here. For a decision that is, it proves the signatures, the response and the ledger
          position agree; {limits}
        </>
      ) : (
        <>
          For each attested decision, check (e) here proves the signatures, the response and the
          ledger position agree; {limits}
        </>
      )}
    </p>
  );
}

/** How many decisions show before "Show N older decisions": the 402 vault already holds 21. */
export const DECISIONS_SHOWN = 20;

/**
 * On a screen 1100 px or wider the Decisions card leaves the page's 768 px column for 1040 px, so that each of its
 * three columns gets about 300 px (the approved mockup). Below that it keeps the column; below 768 px they stack.
 */
const WIDE = "min-[1100px]:ml-[calc((100%_-_1040px)/2)] min-[1100px]:w-[1040px]";

/**
 * Every decision of the ledger, newest first (G7), each with its audit anchors (G4). The newest DECISIONS_SHOWN are
 * full cards (<details>), and only the newest decision made with model output starts open. The older ones wait in a
 * second <details> as their summary lines, anchors included, so every audit link still lands while the page stays
 * small; `fullSeq` (from ?seq=N) renders that one older decision's full card, open, with its group open. A small
 * client part opens the card a link points at.
 */
export function Decisions({
  vault,
  network,
  rows,
  fullSeq = null,
}: {
  vault: string;
  network: Network;
  rows: readonly DecisionRow[] | null;
  fullSeq?: number | null;
}) {
  const open = rows?.find((r) => r.decidedBy === "model+rules" && r.signed !== null)?.seq;
  const card = (r: DecisionRow) => (
    <DecisionPanel
      key={r.id}
      row={r}
      vault={vault}
      network={network}
      open={r.seq === open || r.seq === fullSeq}
    />
  );
  const shown = rows?.slice(0, DECISIONS_SHOWN) ?? [];
  const older = rows?.slice(DECISIONS_SHOWN) ?? [];
  const olderOpen = older.some((r) => r.seq === fullSeq);
  const withModel = rows?.filter((r) => r.decidedBy === "model+rules").length ?? 0;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  // The 1040 px breakout is for the cards' three columns: a single sentence keeps the page's column.
  const wide = rows !== null && rows.length > 0 ? ` ${WIDE}` : "";
  return (
    <section className={`${section}${wide}`} id="decisions" aria-labelledby="decisions-title">
      <h2 id="decisions-title" className={sectionTitle}>
        Decisions
      </h2>
      <p className={`mt-1 text-sm ${muted}`}>
        Every decision in this vault&apos;s ledger, newest first. For a decision made with model
        output: what the ledger records the TEE saw and signed, and what the code and the contract
        checked. Its checks A1 to A7 ran on this snapshot, with the code of{" "}
        <code>probarion verify --offline</code>.
      </p>
      {rows === null ? (
        <p className="mt-3 text-sm text-ink/80">
          The decisions could not be listed from this snapshot. The checks above still ran on it.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink/80">No decision is in this vault&apos;s ledger yet.</p>
      ) : (
        <>
          <p className={`mt-3 text-xs ${muted}`} data-decisions={rows.length}>
            {plural(rows.length, "decision", "decisions")}, {withModel} made with model output
            {older.length > 0 ? `, showing the ${shown.length} newest` : null}
          </p>
          <ol className="mt-3 grid gap-3">{shown.map(card)}</ol>
          {older.length > 0 ? (
            <details className="group/older mt-4" data-older={older.length} open={olderOpen}>
              <summary
                className={`flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 text-xs ${muted} [&::-webkit-details-marker]:hidden`}
              >
                <span className={linePillClass}>
                  <span className="group-open/older:hidden">
                    Show {plural(older.length, "older decision", "older decisions")}
                  </span>
                  <span className="hidden group-open/older:inline">
                    Hide the {plural(older.length, "older decision", "older decisions")}
                  </span>
                </span>
                <span>
                  seq {older[0]?.seq} to seq {older[older.length - 1]?.seq}
                </span>
              </summary>
              <p className={`mt-3 text-xs ${muted}`}>
                An older decision shows its summary line here. &quot;Open the full card&quot; loads
                this page again with its columns and, for a decision made with model output, checks
                A1 to A7.
              </p>
              <ol className="mt-3 grid gap-3">
                {older.map((r) =>
                  r.seq === fullSeq ? card(r) : <DecisionLine key={r.id} row={r} />,
                )}
              </ol>
            </details>
          ) : null}
        </>
      )}
      <OpenLinkedDecision />
    </section>
  );
}

/**
 * A vault's live checks a-i, with explorer links, each decision of its ledger, its burns, the offline steps and the
 * next step (the console). `decisions` is `decisionRows` of the same snapshot, or null when they could not be built;
 * `fullSeq` is the older decision whose full card the address asks for (?seq=N), if any.
 */
export function ProofView({
  result,
  decisions,
  fullSeq = null,
}: {
  result: ProofOk;
  decisions: readonly DecisionRow[] | null;
  fullSeq?: number | null;
}) {
  const { vault, network, report, snapshot } = result;
  const rows = proofRows(report, snapshot, network);
  const burns = burnRows(snapshot, network);
  const unproven = unprovenRows(report, network, vault);
  const state = headline(report);
  // In full, exactly as the verifier prints it ("snapshot taken <taken_at>"), so the two can be compared.
  const takenAt = safeText(snapshot.taken_at);
  return (
    <div className="mx-auto max-w-3xl [&_p]:max-w-measure">
      <Header
        vault={vault}
        eyebrow={result.audience === "public" ? "Public proof" : "Proof, visible to members only"}
      >
        <p className={`mt-2 text-sm ${muted}`}>
          {KIND_LABEL[result.kind] ?? "Vault"} · {network} · {report.entries} ledger{" "}
          {report.entries === 1 ? "entry" : "entries"} · {report.anchors}{" "}
          {report.anchors === 1 ? "anchor" : "anchors"}
        </p>
      </Header>

      <Panel state={state} title={HEADLINE_TEXT[state]}>
        <p className="mt-3 text-sm">{headlineNote(report)}</p>
        <p className="mt-2 text-xs">
          Checked {when(report.generated_at)} · snapshot taken {takenAt}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            className={inkPillClass}
            href={`/proof/${vault}/snapshot.json`}
            download={snapshotFileName(vault)}
          >
            Download snapshot.json
          </a>
          {/* No file name here: the route names the file after the capture time of its own snapshot. */}
          <a className={linePillClass} href={`/proof/${vault}/payments.csv`} download>
            Download payments (CSV)
          </a>
          <a className={linePillClass} href="#verify">
            Verify it yourself
          </a>
        </div>
      </Panel>

      <section className={section} aria-labelledby="checks">
        <h2 id="checks" className={sectionTitle}>
          Checks
        </h2>
        <p className={`mt-1 text-sm ${muted}`}>
          These are the checks <code>probarion verify --offline</code> runs on this snapshot.
        </p>
        <ol className="mt-2 divide-y divide-ink/10">
          {rows.map((row) => (
            <CheckItem key={row.id} vault={vault} row={row} unproven={unproven} />
          ))}
        </ol>
        <AttestationLine modelDecisions={modelDecisionCount(snapshot)} />
      </section>

      <Decisions vault={vault} network={network} rows={decisions} fullSeq={fullSeq} />
      <Burns burns={burns} />
      <VerifyYourself vault={vault} network={network} takenAt={takenAt} />
      <NextStep step={NEXT_STEP.proof} className="mt-6 text-sm text-ink/80" linkClassName={link} />
    </div>
  );
}

/** One sentence per reason. No default branch: a new reason without its own copy fails typecheck. */
function unavailableText(reason: ProofErrorReason, vault: string): string {
  switch (reason) {
    case "evidence":
      return "This deployment's evidence file (content/proof-evidence.json) is malformed, so the checks were not run. Nothing on this page is a pass.";
    case "ledger":
      return "This vault's signed ledger could not be read from Probarion's database right now, so the checks were not run. Nothing on this page is a pass. Try again in a minute.";
    case "database":
      return `Probarion's database could not be reached right now, so this page cannot say whether ${vault} has a proof page. Nothing on this page is a pass. Try again in a minute.`;
    case "chain":
      return "The vault's chain data could not be read right now, so the checks were not run. Nothing on this page is a pass. Try again in a minute.";
  }
}

/**
 * The ledger download reads the same database: when the database is what failed (`ledger`, `database`), neither the
 * download nor the command that needs it can be followed, so they are not offered.
 */
const OFFERS_CHAIN_COMMAND: Readonly<Record<ProofErrorReason, boolean>> = {
  evidence: true,
  chain: true,
  ledger: false,
  database: false,
};

/** The checks did not run. Never shown as a pass, and never as a failed check either. */
export function ProofUnavailable({
  vault,
  network,
  reason,
}: {
  vault: string;
  network: Network;
  reason: ProofErrorReason;
}) {
  return (
    <div className="mx-auto max-w-3xl [&_p]:max-w-measure">
      <Header vault={vault} eyebrow="Proof" />
      <Panel state="error" title="No result: the checks did not run">
        <p className="mt-3 text-sm">{unavailableText(reason, vault)}</p>
        {OFFERS_CHAIN_COMMAND[reason] ? <ChainCommand vault={vault} network={network} /> : null}
      </Panel>
    </div>
  );
}

function ChainCommand({ vault, network }: { vault: string; network: Network }) {
  return (
    <>
      <CliSetup />
      <p className="mt-3 text-sm">
        {CLI_ON_NPM ? "You" : "From the repository folder, you"} can check this vault yourself,
        reading its chain again: download <LedgerLink vault={vault} /> {INTO_REPO}
        {JUST_BEFORE}
      </p>
      <code className={codeBlock}>{chainCommand(network, vault)}</code>
      <EvidenceClone command={chainCommand(network, vault)} />
    </>
  );
}

/** The visitor's address made too many proof requests: nothing was read. */
export function ProofLimited({ vault, network }: { vault: string; network: Network }) {
  return (
    <div className="mx-auto max-w-3xl [&_p]:max-w-measure">
      <Header vault={vault} eyebrow="Proof" />
      <Notice tone="warn">
        Too many proof requests from your address. Wait a minute and reload this page.
      </Notice>
      <ChainCommand vault={vault} network={network} />
    </div>
  );
}
