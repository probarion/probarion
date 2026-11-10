import type { MandateView, Payee, SpendView } from "@probarion/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { VaultTxButton } from "@/components/console/VaultTxButton";
import { AccountLink, Badge, Card, Notice } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import {
  type ApproveState,
  approveState,
  mandateIdOf,
  matchInvoice,
  parseSpendId,
} from "@/lib/console/approve";
import {
  holdEndText,
  mandateStatusView,
  payeeText,
  spendStatusView,
  tokenAmount,
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

const muted = "text-mute";
const textLink =
  "inline-flex min-h-11 items-center text-sm text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";
/** The invoices the page looks through for this spend's: a held spend is recent, and its hold lasts days at most. */
const RECENT_INVOICES = 50;

function PayeeLink({ network, payee }: { network: Network; payee: Payee }) {
  return payee.type === "near" ? (
    <AccountLink network={network} account={payee.account_id} />
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
  if (!read.ok) {
    return (
      <span>
        <Badge tone="warn">unavailable</Badge>{" "}
        <span className={`text-xs ${muted}`}>{whyUnavailable(read.kind)}</span>
      </span>
    );
  }
  const m = read.value;
  if (m === null) return <span>The vault has no such mandate.</span>;
  const status = mandateStatusView(m.status);
  return (
    <span>
      {m.label ? <span className="wrap-anywhere">{safeText(m.label, 80)} </span> : null}
      <Badge tone={status.tone}>{status.label}</Badge>
      <span className={`block text-xs ${muted}`}>
        up to {amount(m.max_per_payment)} a payment, {amount(m.max_total)} in all; an approver signs
        above {amount(m.approval_above)}
      </span>
    </span>
  );
}

function InvoiceLine({
  vault,
  spend,
  invoice,
}: {
  vault: string;
  spend: SpendView;
  /** The console's invoice for the spend, null when none matches, undefined when the list could not be read. */
  invoice: InvoiceRow | null | undefined;
}) {
  const number = invoice?.facts?.invoice_number ?? null;
  return (
    <span>
      {invoice === undefined ? (
        <span className={`block ${muted}`}>The console&apos;s invoices could not be read.</span>
      ) : invoice === null ? (
        <span className={`block ${muted}`}>
          No invoice in the console matches this spend: an agent may have sent it with the SDK.
        </span>
      ) : (
        <Link
          className={textLink}
          href={`/console/${encodeURIComponent(vault)}/payables/${encodeURIComponent(invoice.id)}`}
        >
          {number ? safeText(number, 60) : "The invoice"}
          {invoice.filename ? ` (${safeText(invoice.filename, 80)})` : ""}
        </Link>
      )}
      <span className={`block text-xs ${muted}`}>
        ref <span className="mono break-all">{safeText(spend.ref, 80)}</span>
      </span>
      <span className={`block text-xs ${muted}`}>
        hash on chain <span className="mono break-all">{safeText(spend.invoice_hash, 80)}</span>
      </span>
    </span>
  );
}

function SpendCard({
  state,
  vault,
  network,
  amount,
  invoice,
}: {
  state: Extract<ApproveState, { kind: "held" | "not_held" }>;
  vault: string;
  network: Network;
  amount: (units: string) => string;
  invoice: InvoiceRow | null | undefined;
}) {
  const s = state.spend;
  const status = spendStatusView(s.status);
  return (
    <Card title={state.kind === "held" ? "What you approve" : "The spend"}>
      <p className="text-3xl font-light tracking-tight">{amount(s.amount)}</p>
      <p className="mb-4 text-sm">
        to <PayeeLink network={network} payee={s.destination} />
      </p>
      <dl className="grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
        <dt className={muted}>Status on chain</dt>
        <dd>
          <Badge tone={status.tone}>{status.label}</Badge>
        </dd>
        {state.kind === "held" ? (
          <>
            <dt className={muted}>Why it is held</dt>
            <dd>
              {state.aboveThreshold === null
                ? "The vault held it for an approver."
                : `${amount(s.amount)} is above the mandate's approval threshold of ${amount(state.aboveThreshold)}.`}
            </dd>
            <dt className={muted}>Hold ends</dt>
            <dd>{holdEndText(s.held_until_ns)}</dd>
          </>
        ) : null}
        <dt className={muted}>Mandate #{s.mandate_id}</dt>
        <dd>
          <MandateLine read={state.mandate} amount={amount} />
        </dd>
        <dt className={muted}>Invoice</dt>
        <dd>
          <InvoiceLine vault={vault} spend={s} invoice={invoice} />
        </dd>
      </dl>
    </Card>
  );
}

/** Approve and Reject, each a transaction for the approver's own wallet: only what `approveState` offers. */
function DecisionCard({
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
  return (
    <Card title="Your decision">
      {state.note ? <Notice tone="warn">{state.note}</Notice> : null}
      {state.canApprove ? (
        <VaultTxButton
          label={`Approve ${amount(state.spend.amount)}`}
          network={network}
          expectedSigner={signer}
          tx={approveTx(vault, id)}
          confirm={`Approve paying ${amount(state.spend.amount)} to ${payeeText(state.spend.destination)} (spend #${id})? The vault pays it right away.`}
          outOfNearCodes={OUT_OF_NEAR.codes}
          vaultNearLow={false}
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
        />
      ) : null}
      {state.approver ? (
        <p className={`mt-2 text-xs ${muted}`}>
          Your own wallet signs as {signer}, with 1 yoctoNEAR attached. Probarion signs nothing for
          you, and the vault checks again when the transaction runs.
        </p>
      ) : null}
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
  const state = approveState({
    account: session.accountId,
    spendId,
    config,
    spend,
    mandate,
    nowMs: Date.now(),
  });

  // The console's copy of the invoice, for its number and its page: matched by what the chain recorded, and only
  // shown beside the chain's own facts.
  let invoice: InvoiceRow | null | undefined;
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
      <p className={`text-sm ${muted}`}>
        <Link className={textLink} href={overview}>
          <span aria-hidden="true">←&nbsp;</span>
          <span className="mono wrap-anywhere">{vault}</span>
        </Link>
      </p>
      <h1 className="mt-1 mb-4 text-2xl font-semibold">Spend #{spendId}</h1>

      {state.kind === "unreadable" ? (
        <Notice tone="bad">
          {state.what === "config" ? "The vault's config" : `Spend #${spendId}`} could not be read (
          {state.why}), so nothing is offered. Reload to try again. The vault itself is not
          affected.
        </Notice>
      ) : state.kind === "missing" ? (
        <Notice tone="warn">
          This vault has no spend #{spendId}. Check the link, or open the vault&apos;s overview.
        </Notice>
      ) : (
        <Decided
          state={state}
          vault={vault}
          network={network}
          signer={session.accountId}
          amount={tokenAmount(state.config.usdc, consts.usdc)}
          invoice={invoice}
        />
      )}
    </div>
  );
}

/** The spend as the chain reads it, and, while it is held, the decision. */
function Decided({
  state,
  vault,
  network,
  signer,
  amount,
  invoice,
}: {
  state: Extract<ApproveState, { kind: "held" | "not_held" }>;
  vault: string;
  network: Network;
  signer: string;
  amount: (units: string) => string;
  invoice: InvoiceRow | null | undefined;
}) {
  const spendId = state.spend.id;
  return (
    <>
      {state.kind === "not_held" ? (
        <Notice>
          Nothing to approve: the chain reads spend #{spendId} as{" "}
          {spendStatusView(state.spend.status).label}.
        </Notice>
      ) : null}
      <SpendCard state={state} vault={vault} network={network} amount={amount} invoice={invoice} />
      {state.kind === "held" ? (
        <DecisionCard
          state={state}
          vault={vault}
          network={network}
          signer={signer}
          amount={amount}
        />
      ) : null}
    </>
  );
}
