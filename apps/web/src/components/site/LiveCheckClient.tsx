"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  checkSpendArgs,
  expiryDate,
  fill,
  formatUsdc,
  type KeyChoice,
  LIVE_RPC_URLS,
  LIVE_VAULT,
  type MandateFacts,
  matchScenario,
  OTHER_PK,
  parseMandate,
  parseUsdc,
  parseVerdict,
  payeeText,
  type RecordedFile,
  remaining,
  SCENARIO_INPUTS,
  type ScenarioId,
  viewCall,
} from "@/lib/site/live-check";
import {
  type Answer,
  answerFromRecorded,
  explain,
  type LiveCopy,
  lastAnswer,
  nextAnswer,
  type Shown,
} from "@/lib/site/live-check-view";
import s from "./site.module.css";

export interface LiveCheckProps {
  recorded: RecordedFile;
  scenarios: readonly { id: string; title: string; sub: string; injected?: string }[];
  mandates: readonly { id: number; label: string }[];
  copy: LiveCopy;
  codes: Readonly<Record<string, string>>;
  /** Server-rendered: the explorer link, so that lib/config stays out of this file's first load. */
  explorer: ReactNode;
}

interface Controls {
  mandateId: number;
  amount: string;
  key: KeyChoice;
}

const DEFAULT: ScenarioId = "normal";
const asControls = (id: ScenarioId): Controls => {
  const s = SCENARIO_INPUTS.find((x) => x.id === id) ?? SCENARIO_INPUTS[0];
  return { mandateId: s?.mandateId ?? 1, amount: s?.amount ?? "2", key: s?.key ?? "agent" };
};

export function LiveCheckClient({
  recorded,
  scenarios,
  mandates,
  copy,
  codes,
  explorer,
}: LiveCheckProps) {
  const agentPk = parseMandate(recorded.mandates["1"] ?? null)?.agentPk ?? OTHER_PK;
  const [controls, setControls] = useState<Controls>(asControls(DEFAULT));
  const [shown, setShown] = useState<Shown>({
    kind: "answer",
    answer: answerFromRecorded(recorded, DEFAULT),
  });
  const seq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mandateCache = useRef(new Map<number, Promise<MandateFacts | null>>());

  const ask = useCallback(
    async (c: Controls) => {
      const mine = ++seq.current;
      inflight.current?.abort();
      const units = parseUsdc(c.amount);
      if (units === null) {
        setShown((cur) => ({ kind: "failed", fallback: lastAnswer(cur), reason: "badAmount" }));
        return;
      }
      const ctl = new AbortController();
      inflight.current = ctl;
      setShown((cur) => {
        const prev = lastAnswer(cur);
        return prev === null ? cur : { kind: "loading", previous: prev };
      });
      const cache = mandateCache.current;
      let mandate = cache.get(c.mandateId);
      if (mandate === undefined) {
        mandate = viewCall(LIVE_RPC_URLS, LIVE_VAULT, "get_mandate", {
          mandate_id: c.mandateId,
        }).then((a) => parseMandate(a.value));
        mandate.catch(() => cache.delete(c.mandateId));
        cache.set(c.mandateId, mandate);
      }
      try {
        const [check, m] = await Promise.all([
          viewCall(
            LIVE_RPC_URLS,
            LIVE_VAULT,
            "check_spend",
            checkSpendArgs(c.mandateId, units, c.key === "agent" ? agentPk : OTHER_PK),
            { signal: ctl.signal },
          ),
          mandate,
        ]);
        const answer: Answer = {
          verdict: parseVerdict(check.value),
          raw: check.value,
          mandate: m,
          blockHeight: check.blockHeight,
          at: new Date().toISOString(),
          rpcHost: check.rpcHost,
          recorded: false,
        };
        setShown((cur) =>
          nextAnswer(cur, seq.current, { seq: mine, shown: { kind: "answer", answer } }),
        );
      } catch (e) {
        if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        const id = matchScenario(c);
        const fallback = id === null ? null : answerFromRecorded(recorded, id);
        setShown((cur) =>
          nextAnswer(cur, seq.current, {
            seq: mine,
            shown: { kind: "failed", fallback, reason: "transport" },
          }),
        );
      }
    },
    [agentPk, recorded],
  );

  useEffect(() => {
    void ask(asControls(DEFAULT));
    return () => {
      inflight.current?.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [ask]);

  const change = (next: Controls, debounce: boolean) => {
    setControls(next);
    if (timer.current !== null) clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(() => void ask(next), 250);
    else void ask(next);
  };

  const active = matchScenario(controls);
  const injected = scenarios.find((x) => x.id === active)?.injected;
  const answer = lastAnswer(shown);
  const units = parseUsdc(controls.amount) ?? 0n;
  const m = answer?.mandate ?? null;
  const verdictClass =
    shown.kind === "failed" && shown.fallback === null
      ? s.liveNone
      : answer?.verdict.ok
        ? answer.verdict.wouldHold
          ? s.liveHold
          : s.livePay
        : s.liveRefuse;

  return (
    <div className={s.liveGrid}>
      <div className={s.livePanel}>
        <h3>{copy.formTitle}</h3>
        <p className={s.liveHint}>{copy.formHint}</p>
        <fieldset className={s.scenarios} aria-label={copy.scenariosLabel}>
          {scenarios.map((x) => (
            <button
              key={x.id}
              type="button"
              className={s.scenario}
              aria-pressed={active === x.id}
              onClick={() => change(asControls(x.id as ScenarioId), false)}
            >
              {x.title}
              <small>{x.sub}</small>
            </button>
          ))}
        </fieldset>
        <label className={s.field}>
          <span>{copy.mandateLabel}</span>
          <select
            value={controls.mandateId}
            onChange={(e) => change({ ...controls, mandateId: Number(e.target.value) }, false)}
          >
            {mandates.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className={s.field}>
          <label htmlFor="live-amount">{copy.amountLabel}</label>
          <div className={s.amountRow}>
            <input
              type="range"
              min="0.5"
              max="60"
              step="0.5"
              aria-label={copy.amountSlider}
              value={parseUsdc(controls.amount) === null ? 0 : Number(controls.amount)}
              onChange={(e) => change({ ...controls, amount: e.target.value }, true)}
            />
            <input
              id="live-amount"
              inputMode="decimal"
              value={controls.amount}
              onChange={(e) => change({ ...controls, amount: e.target.value }, true)}
            />
            <span>USDC</span>
          </div>
        </div>
        <div className={s.field}>
          <span>{copy.payeeLabel}</span>
          <div className={s.payee}>
            <code>{m === null ? copy.noPayee : payeeText(m.payee)}</code>
            <span className={s.payeeLock}>{copy.payeeLock}</span>
          </div>
        </div>
        <label className={s.field}>
          <span>{copy.keyLabel}</span>
          <select
            value={controls.key}
            onChange={(e) => change({ ...controls, key: e.target.value as KeyChoice }, false)}
          >
            <option value="agent">{copy.keyAgent}</option>
            <option value="other">{copy.keyOther}</option>
          </select>
        </label>
        {injected === undefined ? null : (
          <p className={s.injected}>
            <b>{copy.injectedLead}</b> "{injected}" {copy.injectedTail}
          </p>
        )}
      </div>

      <div
        className={`${s.livePanel} ${s.liveAnswer}`}
        aria-live="polite"
        aria-busy={shown.kind === "loading"}
      >
        <h3>{copy.answerTitle}</h3>
        <p className={s.liveHint}>
          {shown.kind === "loading"
            ? fill(copy.asking, { vault: LIVE_VAULT })
            : answer === null
              ? ""
              : fill(answer.recorded ? copy.recordedAt : copy.answeredAt, {
                  vault: LIVE_VAULT,
                  block: answer.blockHeight,
                  date: answer.at.slice(0, 10),
                  time: new Date(answer.at).toLocaleTimeString(),
                  raw: JSON.stringify(answer.raw),
                })}
        </p>
        <p className={`${s.liveVerdict} ${verdictClass}`}>
          {shown.kind === "failed" && (shown.reason === "badAmount" || shown.fallback === null)
            ? copy.noAnswer
            : answer === null
              ? ""
              : answer.verdict.ok
                ? answer.verdict.wouldHold
                  ? copy.verdictHold
                  : copy.verdictPay
                : answer.verdict.code}
        </p>
        <p className={s.liveWhy}>
          {shown.kind === "failed"
            ? shown.reason === "badAmount"
              ? copy.badAmount
              : shown.fallback === null
                ? copy.failedNoRecord
                : `${copy.failed} ${explain(shown.fallback, units, injected !== undefined, copy, codes)}`
            : answer === null
              ? ""
              : explain(answer, units, injected !== undefined, copy, codes)}
        </p>
        {shown.kind === "failed" && shown.reason === "transport" ? (
          <button type="button" className={s.liveRetry} onClick={() => void ask(controls)}>
            {copy.retry}
          </button>
        ) : null}
        <pre className={s.liveRequest}>
          {`check_spend({\n  request: {\n    mandate_id: ${controls.mandateId},\n    amount: "${units}",  // ${formatUsdc(units)} USDC\n    invoice_hash, ref, decision_hash,\n`}
          <del className={s.liveGone}>recipient</del>
          {`  // ${copy.noRecipient}\n  },\n  signer_pk: "${(controls.key === "agent" ? agentPk : OTHER_PK).slice(0, 14)}…"  // ${controls.key === "agent" ? copy.agentKeyNote : copy.otherKeyNote}\n})`}
        </pre>
        <p className={s.liveMeta}>
          <span>{copy.method.replace(/`/g, "")}</span>
          {answer?.rpcHost ? <span>{fill(copy.rpc, { host: answer.rpcHost })}</span> : null}
          {explorer}
        </p>
      </div>

      <div className={`${s.livePanel} ${s.liveMandate}`}>
        <h3>{fill(copy.mandateTitle, { id: controls.mandateId })}</h3>
        <p className={s.liveHint}>{copy.mandateHint}</p>
        {m === null ? (
          <p>{copy.noMandate}</p>
        ) : (
          <dl className={s.mandateFacts}>
            <dt>payee</dt>
            <dd>{payeeText(m.payee)}</dd>
            <dt>max_per_payment</dt>
            <dd>{formatUsdc(m.maxPerPayment)} USDC</dd>
            <dt>max_total</dt>
            <dd>
              {fill(copy.left, { total: formatUsdc(m.maxTotal), left: formatUsdc(remaining(m)) })}
            </dd>
            <dt>uses</dt>
            <dd>{fill(copy.usesOf, { uses: m.uses, max: m.maxUses })}</dd>
            <dt>approval_above</dt>
            <dd>{formatUsdc(m.approvalAbove)} USDC</dd>
            <dt>expires</dt>
            <dd>{expiryDate(m)}</dd>
            <dt>agent_pk</dt>
            <dd>{`${m.agentPk.slice(0, 18)}…`}</dd>
            <dt>status</dt>
            <dd>{m.status}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}
