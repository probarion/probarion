import { Badge, Card, ExternalLink, type Tone } from "@/components/ui";
import type { Network } from "@/lib/config";
import type { CycleView } from "@/lib/payables/view";
import { usdcFixed } from "@/lib/payables/view";

// One Payables cycle in three columns: what the model wanted, what the code allowed, what the contract did. Every
// string here was made safe by buildCycleView (lib/payables/view.ts); this component only lays it out.

const muted = "text-ink/75";
const link = "text-ink underline decoration-ink/30 hover:decoration-ink";

const ruleTone = (o: string): Tone =>
  o === "pass" ? "good" : o === "hold" ? "warn" : o === "refuse" ? "bad" : "neutral";
const verdictTone = (v: string | null): Tone =>
  v === "allow" ? "good" : v === "hold" ? "warn" : v === "refuse" ? "bad" : "neutral";
const ATTESTATION_TONE: Record<CycleView["attestation"]["state"], Tone> = {
  attested: "good",
  "rules-only": "warn",
  missing: "bad",
};

/** "20.000000 USDC", or the raw text when it is not base units. */
const usdc = (units: string) => {
  const fixed = usdcFixed(units);
  return fixed === "unreadable" ? units : `${fixed} USDC`;
};

export function CycleColumns({ view }: { view: CycleView; network: Network }) {
  const m = view.modelWanted;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card
        title="Model wanted"
        actions={
          <Badge tone={ATTESTATION_TONE[view.attestation.state]}>{view.attestation.label}</Badge>
        }
      >
        {m ? (
          <div className="text-sm">
            <p>
              <strong>{m.action}</strong> {m.amount ? usdc(m.amount) : "(no amount stated)"} ·
              mandate {m.mandateId ?? "?"} · confidence {m.confidence.toFixed(2)}
            </p>
            {m.payeeHint ? (
              <p className="mt-1 text-xs wrap-anywhere">
                The invoice says pay: <span className="mono">{m.payeeHint}</span> (a hint only: the
                payee always comes from the mandate)
              </p>
            ) : null}
            <p className={`mt-2 text-xs wrap-anywhere ${muted}`}>{m.reasoning}</p>
          </div>
        ) : (
          <p className={`text-sm ${muted}`}>
            {view.found
              ? "No model was used for this decision."
              : "The decision is not in the ledger."}
          </p>
        )}
        {view.attestation.state === "attested" ? (
          <p className={`mt-2 text-xs wrap-anywhere ${muted}`}>
            model {view.attestation.model} · chat {view.attestation.chatId} · signer{" "}
            {view.attestation.signingAddress}. The TDX quote itself is checked only by an online
            verify (check O1).
          </p>
        ) : null}
      </Card>
      <Card
        title="Code allowed"
        actions={
          <Badge tone={verdictTone(view.codeAllowed.verdict)}>
            {view.codeAllowed.verdict ?? "n/a"}
          </Badge>
        }
      >
        {view.codeAllowed.decidedBy ? (
          <p className={`mb-2 text-xs ${muted}`}>decided by {view.codeAllowed.decidedBy}</p>
        ) : null}
        <ul className="text-xs">
          {view.codeAllowed.rules.map((r, i) => (
            // Rule ids repeat only in a malformed entry; the index keeps the keys unique anyway.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is static and never reordered
            <li key={`${r.id}-${i}`} className="mb-1 wrap-anywhere">
              <Badge tone={ruleTone(r.outcome)}>{r.outcome}</Badge> <code>{r.id}</code> {r.detail}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Contract did">
        <p className="text-sm">
          <Badge tone={view.contractDid.tone}>{view.contractDid.label}</Badge>
          {view.contractDid.spendId !== null ? ` · spend #${view.contractDid.spendId}` : ""}
        </p>
        {view.contractDid.note ? (
          <p className={`mt-2 text-xs ${muted}`}>{view.contractDid.note}</p>
        ) : null}
        {view.contractDid.txUrl ? (
          <p className="mt-2 text-xs">
            <ExternalLink className={link} href={view.contractDid.txUrl}>
              Transaction on the explorer ↗
            </ExternalLink>
          </p>
        ) : null}
        {view.anchorTxUrl ? (
          <p className="mt-1 text-xs">
            <ExternalLink className={link} href={view.anchorTxUrl}>
              Ledger anchor ↗
            </ExternalLink>
          </p>
        ) : null}
        <p className={`mt-2 text-xs mono ${muted}`}>
          decision_hash {view.decisionHash.slice(0, 16)}…
        </p>
      </Card>
    </div>
  );
}
