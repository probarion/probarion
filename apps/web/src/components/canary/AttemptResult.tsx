import c from "@/components/site/canary.module.css";
import { TxLink } from "@/components/ui";
import { CANARY_COPY, describeRaw, tokenNoun } from "@/lib/canary/copy";
import type { AttemptResult } from "@/lib/canary/service";
import type { Network } from "@/lib/config";
import { formatUsdc } from "@/lib/near/units";
import { Chip } from "./Chip";

type Done = Extract<AttemptResult, { status: "done" }>;
const COPY = CANARY_COPY.result;

/** The model's amount is base units of USDC. Anything that is not a whole number of them is shown as it came. */
const amountText = (units: string): string =>
  /^[0-9]{1,39}$/.test(units) ? formatUsdc(units) : units;

function proposalLine(p: NonNullable<Done["proposal"]>, network: Network): string {
  return [
    p.action,
    p.amount === null ? COPY.noAmount : `${amountText(p.amount)} ${tokenNoun(network)}`,
    p.mandateId === null ? COPY.noMandate : `${COPY.mandate} ${p.mandateId}`,
  ].join(" · ");
}

function CodeColumn({ code }: { code: Done["code"] }) {
  if (code.status === "refused_by_code") {
    return (
      <p>
        <Chip tone="good">{COPY.refused}</Chip>
        {code.rule ? (
          <>
            {" "}
            <code>{code.rule}</code>
          </>
        ) : null}
      </p>
    );
  }
  if (code.status === "held") {
    return (
      <p>
        <Chip tone="warn">{COPY.held}</Chip>
      </p>
    );
  }
  return (
    <p>
      <Chip>{code.status}</Chip>
    </p>
  );
}

/**
 * One answer to an attempt, in three columns: what the model wanted, what the code decided, what the contract did.
 * What the model wrote is printed as text, as React does for every string.
 */
export function AttemptResultView({ result, network }: { result: Done; network: Network }) {
  const raw = describeRaw(result.raw);
  const { proposal } = result;
  return (
    <div className={c.columns}>
      <section className={c.column}>
        <h3 className={c.columnTitle}>{COPY.modelTitle}</h3>
        {proposal ? (
          <>
            <p>{proposalLine(proposal, network)}</p>
            <p className={c.reasoning}>
              <q>{proposal.reasoning}</q>
            </p>
          </>
        ) : (
          <p>{COPY.noProposal}</p>
        )}
        {result.techniques.length > 0 ? (
          <div className={c.chips}>
            {result.techniques.map((t) => (
              <Chip key={t}>
                <code>{t}</code>
              </Chip>
            ))}
          </div>
        ) : null}
      </section>
      <section className={c.column}>
        <h3 className={c.columnTitle}>{COPY.codeTitle}</h3>
        <CodeColumn code={result.code} />
      </section>
      <section className={c.column}>
        <h3 className={c.columnTitle}>{COPY.contractTitle}</h3>
        <p>
          <Chip tone={raw.tone}>
            {result.raw.sent ? (result.raw.code ?? result.raw.status) : COPY.notSent}
          </Chip>
        </p>
        <p>{raw.text}</p>
        {result.raw.sent && result.raw.txHash ? (
          <p>
            <TxLink network={network} hash={result.raw.txHash} label={COPY.explorer} />
          </p>
        ) : null}
      </section>
    </div>
  );
}
