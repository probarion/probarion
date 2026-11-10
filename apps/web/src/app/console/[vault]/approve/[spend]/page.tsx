import type { MandateView, Payee, SpendView } from "@probarion/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { VaultTxButton } from "@/components/console/VaultTxButton";
import { AccountLink, Card, type Tone } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import {
  type ApproveState,
  approveState,
  type InvoiceMatch,
  mandateIdOf,
  matchInvoice,
  parseSpendId,
} from "@/lib/console/approve";
import {
  holdEndText,
  holdLeftText,
  mandateStatusView,
  payeeText,
  spendAmount,
  spendStatusView,
  whyUnavailable,
} from "@/lib/console/display";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { type Read, read } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { log } from "@/lib/log";
import { chainConsts, getReader } from "@/lib/near/server";
import { approveTx, rejectTx } from "@/lib/near/tx";
import { type InvoiceRow, listInvoices } from "@/lib/payables/store";
import { safeText } from "@/lib/proof/sanitize";

export const metadata: Metadata = { title: "Approve a spend" };
/** Approve and Reject confirm through confirmTx, which waits for the transaction to be FINAL. */
export const maxDuration = 60;

// The page is read on a phone, at arm's length, often in a hurry: it is held to WCAG AAA. Every text colour reads at
// 7:1 or more where it sits (ink; ink/75 for what is secondary, 9.1:1 on the card and 8.7:1 on the page; gold-ink
// on the hold's amber, 7.9:1), text is 14px or more with a line height of 1.5 or more, and every control is 44px tall.
/** Secondary text: ink at 75%, 9.1:1 on the white card and 8.7:1 on the paper page. */
const second = "text-ink/75";
/** A paragraph: 14px with a 24px line. */
const para = "text-sm leading-6";
const textLink =
  "inline-flex min-h-11 items-center text-sm text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";
/** The invoices the page looks through for this spend's, the most `invoice_list` gives: a held spend is recent. */
const RECENT_INVOICES = 200;

/** Callouts in AAA colours: the console's Notice tones read at 5.4:1 (amber) and 5.9:1 (red). */
const CALLOUT = {
  info: "border border-line bg-paper text-ink",
  warn: "border border-gold-deep/30 bg-wait-bg text-gold-ink",
  bad: "border border-bad/30 bg-bad-bg text-ink",
} as const;

function Callout({ tone, children }: { tone: keyof typeof CALLOUT; children: ReactNode }) {
  return <div className={`mb-4 rounded-2xl px-4 py-3 ${para} ${CALLOUT[tone]}`}>{children}</div>;
}

/** The status dot: colour only beside the words, never instead of them. */
const DOT: Readonly<Record<Tone, string>> = {
  good: "bg-ok",
  warn: "bg-gold-small",
  bad: "bg-bad",
  neutral: "bg-plan",
  info: "bg-plan",
};

function Status({ status }: { status: { tone: Tone; label: string } }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${DOT[status.tone]}`} />
      {status.label}
    </span>
  );
}

const sentence = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);
const statusLine = (status: string) => {
  const v = spendStatusView(status);
  return { tone: v.tone, label: sentence(v.label) };
};

function PayeeLink({ network, payee }: { network: Network; payee: Payee }) {
  return payee.type === "near" ? (
    <span className="mono break-all">
      <AccountLink network={network} account={payee.account_id} />
    </span>
  ) : (
    <span className="mono break-all">{payeeText(payee)}</span>
  );
}

function MandateLine({
  read,
  amount,
}: {
  read: Read<MandateView | null>;
  amount: (units: string) => string;
}) {
  if (!read.ok) return <span>Unavailable: {whyUnavailable(read.kind)}</span>;
  const m = read.value;
  if (m === null) return <span>The vault has no such mandate.</span>;
  return (
    <span>
      {m.label ? <span className="block wrap-anywhere">{safeText(m.label, 80)}</span> : null}
      <span className={`block ${second}`}>
        {sentence(mandateStatusView(m.status).label)}. Up to {amount(m.max_per_payment)} a payment
        and {amount(m.max_total)} in all; an approver signs above {amount(m.approval_above)}.
      </span>
    </span>
  );
}

/** What the invoice itself says it is for, beside what the chain will pay. */
function InvoiceAmount({
  row,
  spend,
  amount,
}: {
  row: InvoiceRow;
  spend: SpendView;
  amount: (units: string) => string;
}) {
  const reads = row.facts?.amount;
  if (!reads || !/^(0|[1-9][0-9]*)$/.test(reads)) return null;
  // text-bad reads at 7.2:1 on the white card.
  return reads === spend.amount ? (
    <span className={`block ${second}`}>The invoice reads {amount(reads)}.</span>
  ) : (
    <span className="block font-medium text-bad">
      The invoice reads {amount(reads)}, not the spend&apos;s {amount(spend.amount)}.
    </span>
  );
}

function InvoiceLink({ vault, row }: { vault: string; row: InvoiceRow }) {
  const number = row.facts?.invoice_number ?? null;
  return (
    <Link
      className={`${textLink} wrap-anywhere`}
      href={`/console/${encodeURIComponent(vault)}/payables/${encodeURIComponent(row.id)}`}
    >
      {number ? safeText(number, 60) : "The invoice"}
      {row.filename ? ` (${safeText(row.filename, 80)})` : ""}
    </Link>
  );
}

function InvoiceLine({
  vault,
  spend,
  match,
  amount,
}: {
  vault: string;
  spend: SpendView;
  /** The console's invoice for the spend, or undefined when the list could not be read. */
  match: InvoiceMatch | undefined;
  amount: (units: string) => string;
}) {
  return (
    <span>
      {match === undefined ? (
        <span className="block">The console&apos;s invoices could not be read.</span>
      ) : match.kind === "none" ? (
        <span className="block">
          None of the console&apos;s {RECENT_INVOICES} most recent invoices matches this spend: an
          agent may have sent it with the SDK.
        </span>
      ) : match.kind === "sent" ? (
        <>
          <InvoiceLink vault={vault} row={match.row} />
          <InvoiceAmount row={match.row} spend={spend} amount={amount} />
        </>
      ) : (
        <>
          <span className="block font-medium text-gold-ink">
            An invoice in the console has this hash and ref, but the console did not send this spend
            from it: an agent may have reused its text.
          </span>
          <InvoiceLink vault={vault} row={match.row} />
          <InvoiceAmount row={match.row} spend={spend} amount={amount} />
        </>
      )}
      <span className={`block ${second}`}>
        Ref <span className="mono break-all">{safeText(spend.ref, 80)}</span>
      </span>
      <span className={`block ${second}`}>
        Hash on chain <span className="mono break-all">{safeText(spend.invoice_hash, 80)}</span>
      </span>
    </span>
  );
}

/** Approve and Reject, each a transaction for the approver's own wallet: only what `approveState` offers. */
function Decision({
  state,
  vault,
  network,
  signer,
  amount,
}: {
  state: Extract<ApproveState, { kind: "held" }>;
  vault: string;
  network: Network;
  signer: string;
  amount: (units: string) => string;
}) {
  const id = state.spend.id;
  const methods = state.canApprove ? "approve or reject" : "reject";
  return (
    <div className="mt-5 border-t border-line pt-4">
      {state.note ? (
        <Callout tone="warn">
          <span className="wrap-anywhere">{state.note}</span>
        </Callout>
      ) : null}
      {state.canApprove ? (
        <VaultTxButton
          label={`Approve ${amount(state.spend.amount)}`}
          network={network}
          expectedSigner={signer}
          tx={approveTx(vault, id)}
          confirm={`Approve paying ${amount(state.spend.amount)} to ${payeeText(state.spend.destination)} (spend #${id})? The vault pays it right away.`}
          outOfNearCodes={OUT_OF_NEAR.codes}
          vaultNearLow={false}
          wide
          hidePreview
        />
      ) : null}
      {state.canReject ? (
        <VaultTxButton
          label="Reject"
          network={network}
          expectedSigner={signer}
          tx={rejectTx(vault, id)}
          confirm={`Reject spend #${id}? Nothing is paid, and its reservation goes back to the mandate.`}
          confirmTone="danger"
          outOfNearCodes={OUT_OF_NEAR.codes}
          vaultNearLow={false}
          wide
          hidePreview
        />
      ) : null}
      {state.approver ? (
        <p className={`mt-2 ${para} ${second} wrap-anywhere`}>
          Your wallet signs as {signer}: the vault&apos;s {methods} of spend #{id} on {vault}, with
          1 yoctoNEAR attached. Probarion signs nothing.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a phone shows on its first screen: the amount, the payee, why the spend is held, when the hold ends, and,
 * while it is held, the decision.
 */
function SpendCard({
  state,
  vault,
  network,
  signer,
  amount,
  nowMs,
}: {
  state: Extract<ApproveState, { kind: "held" | "not_held" }>;
  vault: string;
  network: Network;
  signer: string;
  amount: (units: string) => string;
  nowMs: number;
}) {
  const s = state.spend;
  const deciding = state.kind === "held" && state.approver;
  const left = holdLeftText(s.held_until_ns, nowMs);
  const mandate = state.mandate.ok && state.mandate.value ? state.mandate.value : null;
  return (
    <section className="mb-6 rounded-3xl border border-line bg-surface p-5 sm:p-7">
      <h2 className={`${para} ${second}`}>{deciding ? "You approve" : "The spend"}</h2>
      <p className="text-4xl font-light tracking-tight wrap-anywhere">{amount(s.amount)}</p>
      <p className="mt-1 text-base leading-7">
        to <PayeeLink network={network} payee={s.destination} />
      </p>
      {state.kind === "held" ? (
        <>
          <dl
            className={`mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 border-t border-line pt-4 ${para}`}
          >
            <dt className={second}>Why held</dt>
            <dd>
              {state.aboveThreshold === null
                ? "The vault held it for an approver."
                : `${amount(s.amount)} is above the mandate's approval threshold of ${amount(state.aboveThreshold)}.`}
            </dd>
            <dt className={second}>Hold ends</dt>
            <dd>
              {left ? <span className="block">{sentence(left)}</span> : null}
              <span className={`block ${second}`}>{holdEndText(s.held_until_ns)}</span>
            </dd>
            <dt className={second}>Mandate</dt>
            <dd className="wrap-anywhere">
              {mandate?.label ? safeText(mandate.label, 80) : `#${s.mandate_id}`}
            </dd>
          </dl>
          <Decision state={state} vault={vault} network={network} signer={signer} amount={amount} />
        </>
      ) : null}
    </section>
  );
}

/** The rest of what the chain and the console say about the spend, below the decision. */
function DetailsCard({
  state,
  vault,
  amount,
  invoice,
}: {
  state: Extract<ApproveState, { kind: "held" | "not_held" }>;
  vault: string;
  amount: (units: string) => string;
  invoice: InvoiceMatch | undefined;
}) {
  const s = state.spend;
  return (
    <Card title="Details">
      <dl className={`grid grid-cols-1 gap-y-1 ${para} sm:grid-cols-[max-content_1fr] sm:gap-x-6`}>
        <dt className={second}>Mandate #{s.mandate_id}</dt>
        <dd className="mb-3">
          <MandateLine read={state.mandate} amount={amount} />
        </dd>
        <dt className={second}>Invoice</dt>
        <dd>
          <InvoiceLine vault={vault} spend={s} match={invoice} amount={amount} />
        </dd>
      </dl>
    </Card>
  );
}

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ vault: string; spend: string }>;
}) {
  const { vault: requested, spend: rawId } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  const spendId = parseSpendId(rawId);
  if (spendId === null) notFound();
  const vault = member.vault_id;
  // The vault's own network, which is the request's: nothing below reads the other one.
  const network = member.network;
  const consts = chainConsts(network);
  const reader = getReader(network);

  // Everything the page offers comes from these reads of the chain (final), never from the console's database.
  const [config, spend] = await Promise.all([
    read("get_config", vault, () => reader.getConfig(vault)),
    read("get_spend", vault, () => reader.getSpend(vault, spendId)),
  ]);
  const mandateId = spend.ok ? mandateIdOf(spend.value) : null;
  const mandate: Read<unknown> =
    mandateId === null
      ? { ok: false, kind: "skipped" }
      : await read("get_mandate", vault, () => reader.getMandate(vault, mandateId));
  const nowMs = Date.now();
  const state = approveState({
    account: session.accountId,
    spendId,
    config,
    spend,
    mandate,
    nowMs,
  });

  // The console's copy of the invoice, for its number and its page: matched by what the chain recorded, and only
  // shown beside the chain's own facts.
  let invoice: InvoiceMatch | undefined;
  if (state.kind === "held" || state.kind === "not_held") {
    try {
      invoice = matchInvoice(
        await listInvoices(serviceDb(), member.tenant_id, RECENT_INVOICES),
        state.spend,
      );
    } catch {
      log.warn("console.read_failed", { what: "invoice_list", tenant: member.tenant_id });
      invoice = undefined;
    }
  }

  const overview = `/console/${encodeURIComponent(vault)}`;
  return (
    <div className="mx-auto max-w-xl">
      <p className={para}>
        <Link className={textLink} href={overview}>
          <span aria-hidden="true">←&nbsp;</span>
          <span className="mono wrap-anywhere">{vault}</span>
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold">Spend #{spendId}</h1>
      {state.kind === "held" || state.kind === "not_held" ? (
        // The spend's status on chain, once, under the title.
        <p className={`mb-4 ${para}`}>
          <Status status={statusLine(state.spend.status)} />
        </p>
      ) : (
        <div className="mb-4" />
      )}

      {state.kind === "unreadable" ? (
        <Callout tone="bad">
          {state.what === "config" ? "The vault's config" : `Spend #${spendId}`} could not be read (
          {state.why}), so nothing is offered. Reload to try again. The vault itself is not
          affected.
        </Callout>
      ) : state.kind === "missing" ? (
        <Callout tone="warn">
          This vault has no spend #{spendId}. Check the link, or open the vault&apos;s overview.
        </Callout>
      ) : (
        <>
          {state.kind === "not_held" ? (
            <Callout tone="info">
              Nothing to approve: the chain no longer holds spend #{spendId} for an approver.
            </Callout>
          ) : null}
          <SpendCard
            state={state}
            vault={vault}
            network={network}
            signer={session.accountId}
            amount={spendAmount(state.spend.destination, state.config.usdc, consts)}
            nowMs={nowMs}
          />
          <DetailsCard
            state={state}
            vault={vault}
            amount={spendAmount(state.spend.destination, state.config.usdc, consts)}
            invoice={invoice}
          />
        </>
      )}
    </div>
  );
}
