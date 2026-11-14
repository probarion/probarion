"use client";

import { useEffect, useRef, useState } from "react";
import { fill } from "@/lib/site/live-check";
import { labelled } from "@/lib/site/live-check-view";
import {
  ASK_AMOUNTS,
  type AskAmount,
  type AskCopy,
  type AskShown,
  type AskTone,
  askHeadline,
  askMainnet,
  askSentence,
  askSource,
} from "@/lib/site/mainnet-ask";
import { KeepRich, Mark, type OutcomeTone } from "./bits";
import m from "./mainnet.module.css";

/** Each verdict's tone as the page's outcome mark draws it (bits.tsx Mark): none for a state that is not a verdict. */
const MARK: Readonly<Record<AskTone, OutcomeTone | null>> = {
  pay: "paid",
  hold: "held",
  refuse: "refused",
  none: null,
};

export interface MainnetAskClientProps {
  copy: AskCopy & {
    amountsLabel: string;
    amount: string;
    retry: string;
    method: string;
    rpc: string;
  };
  codes: Readonly<Record<string, string>>;
  /** The one RPC host the question goes to. */
  host: string;
}

/**
 * Two amounts and the contract's answer. A click sends one request; a click while one is out sends nothing. Every
 * failure, whatever its cause, shows "could not read the chain" and no verdict.
 */
export function MainnetAskClient({ copy, codes, host }: MainnetAskClientProps) {
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState<AskShown>({ kind: "rest" });
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    setReady(true);
    return () => inflight.current?.abort();
  }, []);

  const ask = async (amount: AskAmount) => {
    if (inflight.current !== null) return;
    const ctl = new AbortController();
    inflight.current = ctl;
    setShown({ kind: "asking", amount });
    try {
      const answer = await askMainnet(amount, { signal: ctl.signal });
      if (!ctl.signal.aborted) setShown({ kind: "answer", answer });
    } catch {
      if (!ctl.signal.aborted) setShown({ kind: "failed", amount });
    } finally {
      if (inflight.current === ctl) inflight.current = null;
    }
  };

  const busy = shown.kind === "asking";
  const picked =
    shown.kind === "rest" ? null : shown.kind === "answer" ? shown.answer.amount : shown.amount;
  const head = askHeadline(shown, copy);
  const mark = MARK[head.tone];
  const why = askSentence(shown, copy, codes);
  const source = askSource(shown, copy);
  const method = labelled(copy.method);
  const rpc = labelled(fill(copy.rpc, { host }));

  return (
    <div className={m.askPanel} hidden={!ready}>
      <fieldset className={m.askAmounts} aria-label={copy.amountsLabel}>
        {ASK_AMOUNTS.map((a) => (
          <button
            key={a}
            type="button"
            className={m.askAmount}
            aria-pressed={picked === a}
            aria-disabled={busy || undefined}
            onClick={() => void ask(a)}
          >
            {fill(copy.amount, { amount: a })}
          </button>
        ))}
      </fieldset>
      <div className={m.askAnswer} aria-live="polite" aria-busy={busy} data-tone={head.tone}>
        <p className={m.askVerdict}>
          {mark === null ? null : <Mark tone={mark} className={m.askMark} />}
          <span>{head.text}</span>
        </p>
        {why === "" ? null : <p className={m.askWhy}>{why}</p>}
        {source.raw === null ? null : (
          <p className={m.askSource}>
            {source.lead}
            <code>{source.raw}</code>
            {source.tail}
          </p>
        )}
        {shown.kind === "failed" ? (
          <button type="button" className={m.askRetry} onClick={() => void ask(shown.amount)}>
            {copy.retry}
          </button>
        ) : null}
      </div>
      <dl className={m.askFacts}>
        <div>
          <dt>{method.label}</dt>
          <dd className={m.askFactValue}>
            <KeepRich text={method.value} />
          </dd>
        </div>
        <div>
          <dt>{rpc.label}</dt>
          <dd className={m.askFactValue}>{rpc.value}</dd>
        </div>
      </dl>
    </div>
  );
}
