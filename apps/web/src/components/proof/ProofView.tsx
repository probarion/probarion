import type { ReactNode } from "react";
import { RouteLink } from "@/components/RouteLink";
import { Badge, Notice, type Tone } from "@/components/ui";
import type { Network } from "@/lib/config";
import type { TenantKind } from "@/lib/db/tenants";
import { safeText } from "@/lib/proof/sanitize";
import type { ProofOk } from "@/lib/proof/service";
import { snapshotFileName } from "@/lib/proof/snapshot-file";
import {
  type BurnRow,
  burnRows,
  HEADLINE_TEXT,
  type Headline,
  headline,
  headlineNote,
  type ProofLink,
  type ProofRow,
  type ProofStatus,
  proofRows,
  type UnprovenRow,
  unprovenRows,
} from "@/lib/proof/view";

// The public proof page, as a server component with no data access of its own: page.tsx loads the result and
// hands it here. The result comes first, then the checks, the burns and the steps to verify it yourself.

const KIND_LABEL: Readonly<Record<TenantKind, string>> = {
  team: "Team vault",
  external: "External owner",
  canary: "Canary challenge",
};

/** Status colours carry meaning: green passed, amber not proven, red failed. Nothing else uses them here. */
const PANEL: Readonly<Record<Headline | "error", { box: string; dot: string }>> = {
  ok: { box: "border-emerald-200 bg-emerald-50 text-emerald-950", dot: "bg-emerald-600" },
  unproven: { box: "border-amber-200 bg-amber-50 text-amber-950", dot: "bg-amber-500" },
  failed: { box: "border-rose-200 bg-rose-50 text-rose-950", dot: "bg-rose-600" },
  error: { box: "border-amber-200 bg-amber-50 text-amber-950", dot: "bg-amber-500" },
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

const pill =
  "inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition-colors";
const inkPill = `${pill} bg-ink text-paper hover:bg-ink/85`;
const linePill = `${pill} border border-ink/15 text-ink hover:bg-ink/5`;
const link = "text-ink underline decoration-ink/30 hover:decoration-ink";
const section = "mb-6 rounded-3xl border border-ink/10 bg-white p-5 sm:p-7";
const sectionTitle = "text-lg font-light tracking-tight text-ink sm:text-xl";
const muted = "text-ink/60";
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
            <a
              className={link}
              href={l.href}
              {...(l.href.startsWith("/") ? {} : { target: "_blank", rel: "noreferrer" })}
            >
              {l.label}
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

function Unproven({ rows }: { rows: readonly UnprovenRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="mt-3 space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      {rows.map((u) => (
        <li key={`${u.spendId}-${u.reason}`}>
          <p>
            <span className="font-medium">Spend #{u.spendId}</span> ({u.reason}): {u.why}
          </p>
          <p className="mt-1 text-xs">To prove it, supply what is missing:</p>
          <code className={codeBlock}>{u.hint}</code>
        </li>
      ))}
    </ul>
  );
}

function CheckItem({ row, unproven }: { row: ProofRow; unproven: readonly UnprovenRow[] }) {
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
      <p className="mt-1 text-sm text-ink/70 wrap-anywhere">{row.detail}</p>
      {row.firstBrokenSeq !== undefined ? (
        <p className="mt-1 text-xs font-medium text-rose-800">
          First broken ledger entry: seq {row.firstBrokenSeq}
        </p>
      ) : null}
      <Evidence links={row.links} />
      {row.id === "h" ? <Unproven rows={unproven} /> : null}
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
                    <a className={link} href={b.txUrl} target="_blank" rel="noreferrer">
                      Spend #{b.spendId}
                    </a>
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
                    <a className={link} href={b.intentsOwnerUrl} target="_blank" rel="noreferrer">
                      {b.intentsOwner}
                    </a>
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
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-gold-deep">
        {eyebrow}
      </p>
      <h1 className="font-mono text-2xl font-light tracking-tight text-ink break-all sm:text-3xl">
        {vault}
      </h1>
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
  const p = PANEL[state];
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
      <ol className="mt-3 list-decimal space-y-4 pl-5 text-sm text-ink/80">
        <li>
          <a className={link} href={`/proof/${vault}/snapshot.json`} download={file}>
            Download {file}
          </a>
          : the ledger plus the chain data these checks used, taken {takenAt}.
        </li>
        <li>
          Run it through the open-source verifier. It needs no network and no keys, and prints the
          same result per check as this page:
          <code className={codeBlock}>npx probarion verify --offline {file}</code>
        </li>
        <li>
          To read the chain half again instead of trusting the file, save the snapshot&apos;s{" "}
          <code>ledger</code> as JSONL (one entry per line) and run:
          <code className={codeBlock}>
            npx probarion verify --network {network} --vault {vault} --ledger ledger.jsonl
          </code>
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

/** A vault's live checks a-i, with explorer links, its burns and the offline steps. */
export function ProofView({ result }: { result: ProofOk }) {
  const { vault, network, report, snapshot } = result;
  const rows = proofRows(report, snapshot, network);
  const burns = burnRows(snapshot, network);
  const unproven = unprovenRows(report, network, vault);
  const state = headline(report);
  const takenAt = when(snapshot.taken_at);
  return (
    <div className="mx-auto max-w-3xl">
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
        <p className="mt-2 text-xs opacity-75">
          Checked {when(report.generated_at)} · snapshot taken {takenAt}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            className={inkPill}
            href={`/proof/${vault}/snapshot.json`}
            download={snapshotFileName(vault)}
          >
            Download snapshot.json
          </a>
          <a className={linePill} href="#verify">
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
            <CheckItem key={row.id} row={row} unproven={unproven} />
          ))}
        </ol>
        <p className={`mt-2 border-t border-ink/10 pt-4 text-xs ${muted}`}>
          Check (e) here proves the signatures, the response and the ledger position agree; it does
          not verify the TDX quote (needs <code>--online</code>, and even then the measurement is
          not pinned) or the request (needs the invoice, A8).
        </p>
      </section>

      <Burns burns={burns} />
      <VerifyYourself vault={vault} network={network} takenAt={takenAt} />
    </div>
  );
}

const UNAVAILABLE: Readonly<Record<"evidence" | "chain", string>> = {
  evidence:
    "This deployment's evidence file (content/proof-evidence.json) is malformed, so the checks were not run. Nothing on this page is a pass.",
  chain:
    "The vault's chain data could not be read right now, so the checks were not run. Nothing on this page is a pass. Try again in a minute.",
};

/** The checks did not run. Never shown as a pass, and never as a failed check either. */
export function ProofUnavailable({
  vault,
  network,
  reason,
}: {
  vault: string;
  network: Network;
  reason: "evidence" | "chain";
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <Header vault={vault} eyebrow="Proof" />
      <Panel state="error" title="No result: the checks did not run">
        <p className="mt-3 text-sm">{UNAVAILABLE[reason]}</p>
        <ChainCommand vault={vault} network={network} />
      </Panel>
    </div>
  );
}

function ChainCommand({ vault, network }: { vault: string; network: Network }) {
  return (
    <>
      <p className="mt-3 text-sm">
        You can check the vault&apos;s chain data yourself (without its ledger file, the ledger
        checks see an empty ledger):
      </p>
      <code className={codeBlock}>
        npx probarion verify --network {network} --vault {vault}
      </code>
    </>
  );
}

/** The visitor's address made too many proof requests: nothing was read. */
export function ProofLimited({ vault, network }: { vault: string; network: Network }) {
  return (
    <div className="mx-auto max-w-3xl">
      <Header vault={vault} eyebrow="Proof" />
      <Notice tone="warn">
        Too many proof requests from your address. Wait a minute and reload this page.
      </Notice>
      <ChainCommand vault={vault} network={network} />
    </div>
  );
}
