import type { ReactNode } from "react";
import { Badge, ExternalLink, type Tone } from "@/components/ui";
import type { Network } from "@/lib/config";
import {
  CONTRACT_CHECKS,
  DECISION_LIMITS,
  type DecisionAttestation,
  type DecisionRow,
  type DecisionVerdict,
  onlineCommand,
  type RuleOutcome,
  type ShownPayment,
  type ShownRule,
  type TeeSaw,
  type TeeSigned,
} from "@/lib/proof/decisions";
import { CopyAuditLink } from "./DecisionLinks";

// One decision of a vault's ledger on /proof (G7), as a server component: what the ledger records the TEE was shown,
// what it signed, and what the code and the contract checked, with checks A1 to A7 run on this snapshot. The rows come
// from lib/proof/decisions.ts, where every ledger string is made safe and the raw quote, GPU payload and response body
// stay out (sizes only, in snapshot.json). Nothing here says the TEE or its quote was verified: the fixed limits line
// says what was not checked.

/** What each of A1 to A7 shows, in one line. The detail under it is core's own result for this entry. */
export const ATTESTATION_MEANINGS: Readonly<Record<string, string>> = {
  A1: "The signed text is model:request_sha256:response_sha256, the format NEAR AI Cloud documents.",
  A2: "The low-s ECDSA (EIP-191) signature recovers to the signer address.",
  A3: "The attestation report names the same ECDSA signer.",
  A4: "The first half of report_data, read from the TDX quote bytes, is that signer.",
  A5: "The second half of report_data, and the report's request_nonce, are this decision's nonce.",
  A6: "That nonce is recomputed from this ledger position: vault, prev_link, invoice_hash, mandate_id and seq.",
  A7: "The response hashes to response_sha256, carries the chat_id, and holds exactly the recorded proposal.",
};

/** How many rules a card lists before "The other N rules": every rule that did not pass, then passes up to this. */
const RULES_UP_FRONT = 5;

const link = "text-ink underline decoration-ink/30 hover:decoration-ink";
const muted = "text-ink/60";
const codeBlock =
  "mt-1.5 block rounded-2xl bg-ink px-3 py-2 font-mono text-xs text-paper wrap-anywhere";
const moreSummary =
  "w-max cursor-pointer text-xs underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

const VERDICT_TONE: Readonly<Record<DecisionVerdict, Tone>> = {
  allow: "good",
  hold: "warn",
  refuse: "bad",
  unknown: "neutral",
};

const RULE_TONE: Readonly<Record<RuleOutcome, Tone>> = {
  pass: "good",
  hold: "warn",
  refuse: "bad",
  unknown: "neutral",
};

/** A spend's or a payment's status: paid out is good, waiting is amber, refused or failed is red. */
function statusTone(status: string): Tone {
  if (["paid", "burned", "settled"].includes(status)) return "good";
  if (["held", "pending", "unconfirmed", "unknown"].includes(status)) return "warn";
  if (["refused", "failed", "rejected", "expired"].includes(status)) return "bad";
  return "neutral";
}

/** "2026-11-11 09:14 UTC" (or with seconds) for an ISO time; any other text as it is (it is already safe). */
function utc(at: string, seconds = false): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  return `${new Date(t)
    .toISOString()
    .slice(0, seconds ? 19 : 16)
    .replace("T", " ")} UTC`;
}

const shortHash = (h: string): string =>
  /^[0-9a-f]{64}$/.test(h) ? `${h.slice(0, 6)}...${h.slice(-6)}` : h;

/** The host a link points at, such as testnet.nearblocks.io. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "the explorer";
  }
};

function titleOf(r: DecisionRow): string {
  if (r.amount.text === "none") return "Decision with no amount";
  return `Pay ${r.amount.text}${r.mandateId === null ? ", no mandate" : ` under mandate ${r.mandateId}`}`;
}

/** The contract's part in one badge: the bound spend, a refusal, the payment's status, or that nothing was sent. */
function outcomeBadge(r: DecisionRow): { tone: Tone; label: string } | null {
  const spend = r.checked.spends[0];
  if (spend)
    return { tone: statusTone(spend.status), label: `${spend.status}, spend #${spend.id}` };
  const payment = r.checked.payments[0];
  if (payment?.status === "refused") return { tone: "bad", label: "refused by contract" };
  if (payment) return { tone: statusTone(payment.status), label: `payment ${payment.status}` };
  if (r.verdict === "hold" || r.verdict === "refuse") return { tone: "neutral", label: "not sent" };
  return null;
}

const DECIDER_BADGE: Readonly<Record<DecisionRow["decidedBy"], { tone: Tone; label: string }>> = {
  "model+rules": { tone: "info", label: "model+rules" },
  "rules-only": { tone: "neutral", label: "rules-only" },
  unknown: { tone: "bad", label: "decided_by unknown" },
};

function attestationBadge(a: DecisionAttestation): { tone: Tone; label: string } {
  if (a.ok) return { tone: "good", label: "A1-A7 pass offline" };
  const failed = a.checks.filter((c) => !c.pass).map((c) => c.id);
  return {
    tone: "bad",
    label: `A1-A7: ${failed.join(", ")} ${failed.length === 1 ? "fails" : "fail"}`,
  };
}

function Chevron() {
  return (
    <span
      aria-hidden="true"
      className="mt-px inline-grid h-[22px] w-[22px] flex-none place-items-center rounded-full border border-ink/15 text-ink/70"
    >
      <svg
        viewBox="0 0 12 12"
        className="h-3 w-3 transition-transform group-open/card:rotate-90"
        aria-hidden="true"
      >
        <path
          d="M4.5 2.5L8 6l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** One term of a column, with an optional grey line under its value saying why it matters. */
function Item({ term, why, children }: { term: ReactNode; why?: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className={`mt-2.5 text-xs ${muted}`}>{term}</dt>
      <dd className="mt-px text-xs text-ink wrap-anywhere">
        {children}
        {why ? <span className={`block ${muted}`}>{why}</span> : null}
      </dd>
    </>
  );
}

function Column({
  id,
  step,
  title,
  sub,
  children,
}: {
  id: string;
  step: number;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 rounded-2xl border border-line bg-paper p-3.5 max-[480px]:p-3"
      data-column={title}
    >
      <h3 id={id} className="flex items-start gap-2 text-sm leading-snug font-semibold text-ink">
        <span
          aria-hidden="true"
          className="-mt-px inline-grid h-[22px] w-[22px] flex-none place-items-center rounded-full border border-gold-small text-xs font-semibold text-gold-small"
        >
          {step}
        </span>
        {title}
      </h3>
      {sub ? <p className={`mt-1 mb-1.5 text-xs ${muted}`}>{sub}</p> : null}
      <dl>{children}</dl>
    </section>
  );
}

function Saw({ id, saw }: { id: string; saw: TeeSaw }) {
  const p = saw.systemPrompt;
  return (
    <Column
      id={`${id}-saw`}
      step={1}
      title="What the TEE saw"
      sub={<>The request as the ledger records it. {saw.inputsBinding ?? saw.inputsNote}</>}
    >
      <Item term="Model">
        <code>{saw.model}</code>
      </Item>
      {p ? (
        <Item
          term="System prompt"
          why={
            p.known
              ? `Its sha256 is on core's allow-list of system prompts: ${p.sha256}`
              : `Its sha256 is not on core's allow-list: ${p.sha256}`
          }
        >
          <code>{p.name}</code>
          <details className="mt-1">
            <summary className={moreSummary}>
              The prompt, {p.lines.length} {p.lines.length === 1 ? "line" : "lines"}
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded-xl border border-line bg-surface p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
              {p.lines.join("\n")}
            </pre>
          </details>
        </Item>
      ) : null}
      {saw.facts ? (
        <Item term="Facts shown">
          <span className="block font-mono">invoice_hash {saw.facts.invoiceHash}</span>
          <span className="block font-mono">
            amount {saw.facts.amount.units ?? saw.facts.amount.text}
          </span>
          <span className="block font-mono">po_ref {saw.facts.poRef ?? "none"}</span>
          <span className="block font-mono">purpose_hash {saw.facts.purposeHash ?? "none"}</span>
        </Item>
      ) : null}
      {saw.mandates.length > 0 ? (
        <Item term={`Mandates shown (${saw.mandates.length})`}>
          <ul>
            {/* A crafted list can repeat an id, so its place keeps the keys apart. */}
            {saw.mandates
              .map((m, n) => ({ m, key: `${n}:${m.id}` }))
              .map(({ m, key }) => (
                <li key={key} className="mt-0.5">
                  #{m.id} &quot;{m.label}&quot;: pays <code>{m.payee}</code>, at most{" "}
                  {m.maxPerPayment.text} a payment, {m.remaining.text} left, until {m.expires},{" "}
                  {m.status}
                </li>
              ))}
          </ul>
        </Item>
      ) : null}
      <Item term="Invoice text" why={saw.invoiceTextNote}>
        {saw.invoiceTextSha256 === null ? (
          "not recorded"
        ) : (
          <code>sha256 {saw.invoiceTextSha256}</code>
        )}
      </Item>
      <Item term="Nonce" why="A6 recomputes it from this ledger position.">
        <code>{saw.nonce}</code>
      </Item>
      <Item term="request_sha256" why="A1 checks it is part of the signed text.">
        <code>{saw.requestSha256}</code>
      </Item>
      {saw.inputsBinding !== null && saw.inputsNote !== null ? (
        <Item term="Note">{saw.inputsNote}</Item>
      ) : null}
    </Column>
  );
}

function Signed({ id, signed }: { id: string; signed: TeeSigned }) {
  const p = signed.proposal;
  const r = signed.report;
  const snapshot = signed.snapshotHref ? (
    <a className={link} href={signed.snapshotHref}>
      snapshot.json
    </a>
  ) : (
    "snapshot.json"
  );
  return (
    <Column
      id={`${id}-signed`}
      step={2}
      title="What the TEE signed"
      sub="The response, its signature, and the attestation report fetched with it."
    >
      <Item term="Proposal">
        {p ? (
          <>
            <strong className="font-semibold">{p.action}</strong> {p.amount.text}, mandate{" "}
            {p.mandateId}, confidence {p.confidence}
          </>
        ) : (
          "none recorded, so A7 has nothing to bind"
        )}
      </Item>
      {p && p.reasoning !== "" ? (
        <Item term="Reasoning (as the model wrote it)">
          <span className="mt-1 block rounded-r-lg border-l-2 border-gold-deep bg-surface px-2.5 py-1.5 text-ink/80">
            {p.reasoning}
          </span>
        </Item>
      ) : null}
      {p?.payeeHint ? (
        <Item term="Payee hint" why="A hint only: the payee always comes from the mandate.">
          {p.payeeHint}
        </Item>
      ) : null}
      <Item term="chat_id">
        <code>{signed.chatId}</code>
      </Item>
      <Item
        term="response_sha256"
        why={
          signed.responseBytes === null ? (
            "No response body is stored."
          ) : (
            <>
              Response body, {signed.responseBytes} bytes, in {snapshot}
            </>
          )
        }
      >
        <code>{signed.responseSha256}</code>
      </Item>
      <Item term="Signed text" why="model:request_sha256:response_sha256">
        <code>{signed.text}</code>
      </Item>
      <Item term="Signature" why={`algorithm ${signed.algo}`}>
        <code>{signed.signature}</code>
      </Item>
      <Item term="Signer">
        <code>{signed.signer}</code>
      </Item>
      <Item term="Attestation report">
        {r ? (
          <>
            <span className="block">
              {r.quote.text}, not shown here (in {snapshot})
            </span>
            <span className="block">
              Report signer <code>{r.signer}</code>, algorithm {r.algo}
            </span>
            {r.reportData ? (
              <>
                <span className="block">
                  report_data, first half <code>{r.reportData.signerHalf}</code>
                </span>
                <span className="block">
                  report_data, second half <code>{r.reportData.nonceHalf}</code>
                </span>
              </>
            ) : (
              <span className="block">report_data is not 64 bytes of hex</span>
            )}
            <span className="block">
              request_nonce <code>{r.requestNonce}</code>
            </span>
            <span className="block">{r.gpuPayload.text}</span>
            <span className="block">Event log: {r.eventLog.text}</span>
          </>
        ) : (
          "No attestation report is recorded."
        )}
      </Item>
      <Item term="Fetched at" why={signed.rawNote}>
        {utc(signed.fetchedAt, true)}
      </Item>
    </Column>
  );
}

function RuleLine({ rule }: { rule: ShownRule }) {
  return (
    <li className="mt-1.5 flex items-baseline gap-1.5 wrap-anywhere" data-rule={rule.id}>
      <span className="flex-none">
        <Badge tone={RULE_TONE[rule.outcome]}>{rule.outcome}</Badge>
      </span>
      <span className="min-w-0">
        <code>{rule.id}</code> {rule.detail}
      </span>
    </li>
  );
}

function rulesTerm(rules: readonly ShownRule[]): string {
  const count = (o: RuleOutcome) => rules.filter((r) => r.outcome === o).length;
  const pass = count("pass");
  if (pass === rules.length) return `Code rules: ${pass} of ${rules.length} pass`;
  const parts = [
    `${pass} pass`,
    ...(["hold", "refuse", "unknown"] as const)
      .filter((o) => count(o) > 0)
      .map((o) => `${count(o)} ${o}`),
  ];
  return `Code rules: ${parts.join(", ")}`;
}

/** The rules the code ran: each one that did not pass, then passes up to RULES_UP_FRONT, the rest behind a toggle. */
function CodeRules({ rules }: { rules: readonly ShownRule[] }) {
  if (rules.length === 0) {
    return <Item term="Code rules">No rule result is recorded.</Item>;
  }
  // A ledger may repeat a rule id, so a rule's place keeps the keys apart.
  const items = rules.map((rule, n) => ({
    rule,
    key: `${n}:${rule.id}`,
    front: rule.outcome !== "pass",
  }));
  for (const item of items) {
    if (items.filter((x) => x.front).length >= RULES_UP_FRONT) break;
    item.front = true;
  }
  const front = items.filter((x) => x.front);
  const rest = items.filter((x) => !x.front);
  return (
    <Item term={rulesTerm(rules)}>
      <ul>
        {front.map(({ rule, key }) => (
          <RuleLine key={key} rule={rule} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="mt-2">
          <summary className={moreSummary}>
            The other {rest.length} {rest.length === 1 ? "rule" : "rules"}
          </summary>
          <ul>
            {rest.map(({ rule, key }) => (
              <RuleLine key={key} rule={rule} />
            ))}
          </ul>
        </details>
      ) : null}
    </Item>
  );
}

function PaymentLine({ p }: { p: ShownPayment }) {
  const check = p.code === null ? undefined : CONTRACT_CHECKS.find((c) => c.code === p.code);
  return (
    <span className="mb-1.5 block">
      <Badge tone={statusTone(p.status)}>{p.status}</Badge>
      {p.spendId === null ? null : ` spend #${p.spendId}.`}
      {p.code === null ? null : (
        <>
          {" "}
          <code>{p.code}</code>
          {check ? `: the check "${check.text}" failed.` : "."}
        </>
      )}
      {p.status === "refused" ? " Nothing was paid, and no spend was created." : null}
      <span className="block">
        {p.txUrl === null ? (
          <span className={muted}>{p.txLabel}</span>
        ) : (
          <ExternalLink className={link} href={p.txUrl}>
            {`${p.txLabel[0]?.toUpperCase() ?? ""}${p.txLabel.slice(1)} on ${hostOf(p.txUrl)}`}
          </ExternalLink>
        )}
      </span>
      <span className={`block ${muted}`}>
        Recorded by the payment entry at seq {p.seq}, {utc(p.at)}
      </span>
    </span>
  );
}

/** The contract's 14 checks as chips: passed, the one that refused, and the ones after it that did not run. */
function ContractChips({ r }: { r: DecisionRow }) {
  const c = r.checked;
  const refused = c.contractChecks.findIndex((x) => x.refused);
  if (refused < 0 && c.spends.length === 0) return null;
  const state = (i: number): "passed" | "refused" | "did not run" =>
    refused < 0 || i < refused ? "passed" : i === refused ? "refused" : "did not run";
  const look = {
    passed: "bg-ok-bg text-ok",
    refused: "bg-bad-bg font-semibold text-bad",
    "did not run": "bg-plan-bg text-plan",
  } as const;
  return (
    <Item
      term={`The contract's ${c.contractChecks.length} spend checks, in order`}
      why={
        refused < 0
          ? `All ${c.contractChecks.length} passed: the contract accepted the spend. ${c.holdRule}`
          : "The first failing check is the refusal; the ones after it did not run."
      }
    >
      <ul className="mt-1 flex flex-wrap gap-1">
        {c.contractChecks.map((x, i) => (
          <li
            key={x.code}
            title={x.text}
            data-contract-check={x.code}
            className={`rounded-md px-1.5 font-mono text-xs leading-[18px] ${look[state(i)]}`}
          >
            {x.code}
            <span className="sr-only">: {state(i)}</span>
          </li>
        ))}
      </ul>
    </Item>
  );
}

function ContractParts({ r }: { r: DecisionRow }) {
  const c = r.checked;
  return (
    <>
      <Item term="Contract">
        {c.payments.length > 0 ? (
          c.payments.map((p) => <PaymentLine key={p.seq} p={p} />)
        ) : r.verdict === "hold" || r.verdict === "refuse" ? (
          <>
            <Badge tone="neutral">not sent</Badge> The code{" "}
            {r.verdict === "hold" ? "held" : "refused"} this decision, so nothing reached the
            contract and nothing was paid.
          </>
        ) : (
          "No payment entry in this snapshot records a spend for this decision."
        )}
      </Item>
      {c.spends.length > 0 ? (
        <Item term="Bound on chain" why="Check (d) ties each spend to its own decision.">
          {c.spends.map((s) => (
            <span key={s.id} className="block">
              Spend #{s.id}&apos;s decision_hash is this entry&apos;s body_hash: {s.status},{" "}
              {s.amount.text} to <code>{s.destination}</code>, mandate {s.mandateId}.
            </span>
          ))}
        </Item>
      ) : c.payments.some((p) => p.spendId !== null) ? (
        <Item term="Bound on chain">
          No spend in this snapshot&apos;s chain data names this entry&apos;s body_hash.
        </Item>
      ) : null}
      {c.mandate ? (
        <Item term={`Mandate ${c.mandate.id} on chain`}>
          &quot;{c.mandate.label}&quot;: pays <code>{c.mandate.payee}</code>,{" "}
          {c.mandate.maxPerPayment.text} a payment, {c.mandate.maxTotal.text} in all,{" "}
          {c.mandate.maxUses} uses, holds above {c.mandate.approvalAbove.text}, until{" "}
          {c.mandate.expires}, {c.mandate.status}
        </Item>
      ) : c.mandateNote ? (
        <Item term="Mandate on chain">{c.mandateNote}</Item>
      ) : null}
      <ContractChips r={r} />
    </>
  );
}

function Attestation({
  id,
  a,
  vault,
  network,
}: {
  id: string;
  a: DecisionAttestation;
  vault: string;
  network: Network;
}) {
  return (
    <section
      aria-labelledby={`${id}-checks`}
      className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3.5 max-[480px]:p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-checks`} className="text-sm font-semibold text-ink">
          Offline checks on this decision
        </h3>
        <Badge tone={a.ok ? "good" : "bad"}>{a.summary}</Badge>
      </div>
      <ol className="mt-1.5">
        {a.checks.map((c) => (
          <li
            key={c.id}
            data-attestation={c.id}
            data-result={c.pass ? "pass" : "fail"}
            className="grid grid-cols-[20px_26px_minmax(0,1fr)] items-start gap-2 border-t border-ink/10 py-1.5 text-sm first:border-t-0 max-[480px]:grid-cols-[18px_24px_minmax(0,1fr)] max-[480px]:gap-1.5 max-[480px]:text-[13px]"
          >
            <Mark pass={c.pass} />
            <span className="pt-0.5 font-mono text-xs font-semibold">{c.id}</span>
            <span className="min-w-0 text-ink/80 wrap-anywhere">
              {ATTESTATION_MEANINGS[c.id] ?? ""}
              <span className={`block text-xs ${muted}`}>{c.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-ink/10 pt-3 text-xs text-ink/70">{DECISION_LIMITS}</p>
      <p className="mt-2 text-xs text-ink/70">
        To run O1 and O2 on this vault, download its ledger file (
        <a className={link} href="#verify">
          Verify it yourself
        </a>
        , below), then run:
      </p>
      <code className={codeBlock}>{onlineCommand(network, vault)}</code>
    </section>
  );
}

function Mark({ pass }: { pass: boolean }) {
  return (
    <span
      role="img"
      aria-label={pass ? "pass" : "fail"}
      className={`mt-0.5 inline-grid h-[18px] w-[18px] place-items-center rounded-full ${pass ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}
    >
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
        <path
          d={pass ? "M2.5 6.5l2.2 2.2L9.5 3.8" : "M3.5 3.5l5 5M8.5 3.5l-5 5"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * One decision as a card: an <li> that holds its audit anchors (id="seq-N" on the card, id="spend-N" for each spend
 * bound to it), so a link to either scrolls to the card even with the card closed and no JavaScript. `open` starts
 * the card open (the newest decision made with model output).
 */
export function DecisionPanel({
  row,
  vault,
  network,
  open = false,
}: {
  row: DecisionRow;
  vault: string;
  network: Network;
  open?: boolean;
}) {
  const verdict = row.verdict;
  const outcome = outcomeBadge(row);
  const decider = DECIDER_BADGE[row.decidedBy];
  const anchors = [row.id, ...row.spendIds];
  const copyTarget = row.spendIds[0] ?? row.id;
  return (
    <li
      id={row.id}
      data-decision={row.seq}
      className={`overflow-hidden rounded-[20px] border bg-surface ${open ? "border-gold-deep/45 shadow-[0_1px_0_rgb(165_122_38/0.10)]" : "border-line"}`}
    >
      {row.spendIds.map((s) => (
        <span key={s} id={s} aria-hidden="true" />
      ))}
      <details className="group/card" open={open}>
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3.5 hover:bg-ink/[0.02] max-[480px]:p-3 sm:px-5 sm:py-4 [&::-webkit-details-marker]:hidden">
          <Chevron />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="rounded-full border border-line bg-paper px-2 py-px font-mono text-xs whitespace-nowrap text-gold-ink">
                seq {row.seq}
              </span>
              <span className="text-[15px] font-medium text-ink">{titleOf(row)}</span>
            </span>
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge tone={VERDICT_TONE[verdict]}>{verdict}</Badge>
              {outcome ? <Badge tone={outcome.tone}>{outcome.label}</Badge> : null}
              <Badge tone={decider.tone}>{decider.label}</Badge>
              {row.attestation ? (
                <>
                  <Badge tone={attestationBadge(row.attestation).tone}>
                    {attestationBadge(row.attestation).label}
                  </Badge>
                  <Badge tone="neutral">quote not checked here</Badge>
                </>
              ) : null}
            </span>
            <span className={`mt-1 block text-xs ${muted}`}>
              {utc(row.at)}
              {row.invoiceHash === null ? null : (
                <>
                  {" · invoice "}
                  <code className="text-ink">{shortHash(row.invoiceHash)}</code>
                </>
              )}
            </span>
          </span>
        </summary>

        <div className="border-t border-line p-4 max-[480px]:p-3 sm:p-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs md:grid-cols-3">
            <div>
              <dt className={muted}>Ledger entry</dt>
              <dd className="mt-px wrap-anywhere">
                seq {row.seq}, decision, {utc(row.at, true)}
              </dd>
            </div>
            <div>
              <dt className={muted}>Mandate</dt>
              <dd className="mt-px wrap-anywhere">
                {row.mandateId === null ? "none" : row.mandateId}
                {row.checked.mandate ? `, "${row.checked.mandate.label}"` : null}
              </dd>
            </div>
            <div>
              <dt className={muted}>Amount</dt>
              <dd className="mt-px wrap-anywhere">
                {row.amount.text}
                {row.amount.units === null ? null : (
                  <span className={`font-mono ${muted}`}> ({row.amount.units})</span>
                )}
              </dd>
            </div>
            <div>
              <dt className={muted}>Verdict</dt>
              <dd className="mt-px wrap-anywhere">
                {verdict}, decided by {row.decidedBy}
              </dd>
            </div>
            <div>
              <dt className={muted}>body_hash</dt>
              <dd className="mt-px wrap-anywhere">
                <code>{row.bodyHash}</code>
              </dd>
            </div>
            <div>
              <dt className={muted}>Anchored</dt>
              <dd className="mt-px wrap-anywhere">{row.anchor.text}</dd>
            </div>
          </dl>

          {row.modelNote ? <p className="mt-4 text-sm text-ink/70">{row.modelNote}</p> : null}

          {row.saw && row.signed ? (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <Saw id={row.id} saw={row.saw} />
              <Signed id={row.id} signed={row.signed} />
              <Column
                id={`${row.id}-checked`}
                step={3}
                title="What the code and the contract checked"
                sub="The code's rules off chain, then the vault contract on chain."
              >
                <CodeRules rules={row.checked.rules} />
                <ContractParts r={row} />
              </Column>
            </div>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Column id={`${row.id}-code`} step={1} title="What the code checked">
                <CodeRules rules={row.checked.rules} />
              </Column>
              <Column id={`${row.id}-contract`} step={2} title="What the contract checked">
                <ContractParts r={row} />
              </Column>
            </div>
          )}

          {row.attestation ? (
            <Attestation id={row.id} a={row.attestation} vault={vault} network={network} />
          ) : null}

          <div className="mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs">
            <span className={muted}>{anchors.length === 1 ? "Audit link:" : "Audit links:"}</span>
            {anchors.map((a) => (
              <a key={a} className={link} href={`#${a}`}>
                <code>#{a}</code>
              </a>
            ))}
            <CopyAuditLink
              anchor={copyTarget}
              className="rounded-full border border-ink/15 bg-surface px-2.5 py-0.5 text-xs font-medium text-ink no-underline hover:bg-ink/5"
            />
            <span className={muted}>
              In snapshot.json: <code>ledger[{row.seq}]</code>
            </span>
          </div>
        </div>
      </details>
    </li>
  );
}
