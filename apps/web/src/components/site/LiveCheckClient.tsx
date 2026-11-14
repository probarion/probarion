"use client";

import Link from "next/link";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  agentKeyFor,
  amountLine,
  answerFromRecorded,
  failureKind,
  hintParts,
  type LiveCopy,
  labelled,
  lastAnswer,
  nextAnswer,
  payeeShown,
  rawPieces,
  type Shown,
  sentenceText,
  type Tone,
  utcTime,
  verdictText,
  verdictTone,
} from "@/lib/site/live-check-view";
import { Keep, KeepRich, Mark, type OutcomeTone } from "./bits";
import lc from "./live.module.css";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

export interface LiveCheckProps {
  recorded: RecordedFile;
  scenarios: readonly { id: string; title: string; sub: string; injected?: string }[];
  mandates: readonly { id: number; label: string }[];
  copy: LiveCopy;
  codes: Readonly<Record<string, string>>;
  /** Server-rendered: the explorer link, so that lib/config stays out of this file's first load. */
  explorer: ReactNode;
  /** The panels' heading level: h3 under a section's h2, h4 inside a block whose head is an h3 (LiveCheck embedded). */
  level?: 3 | 4;
}

interface Fields {
  mandateId: number;
  amount: string;
  key: KeyChoice;
}

interface Controls extends Fields {
  /**
   * The scenario these fields are: its button sets it, and an edit matches the fields again. The hijack sends the normal
   * invoice's request, so only its button picks it.
   */
  scenario: ScenarioId | null;
}

const DEFAULT: ScenarioId = "normal";
const asControls = (id: ScenarioId): Controls => {
  const s = SCENARIO_INPUTS.find((x) => x.id === id) ?? SCENARIO_INPUTS[0];
  return {
    mandateId: s?.mandateId ?? 1,
    amount: s?.amount ?? "2",
    key: s?.key ?? "agent",
    scenario: s?.id ?? null,
  };
};
/** Fields changed by hand, with the scenario they now match, if any. */
const edited = ({ mandateId, amount, key }: Fields): Controls => ({
  mandateId,
  amount,
  key,
  scenario: matchScenario({ mandateId, amount, key }),
});

const TONE_CLASS: Readonly<Record<Tone, string | undefined>> = {
  pay: lc.pay,
  hold: lc.hold,
  refuse: lc.refuse,
  none: lc.none,
};

/** Each verdict's tone as the page's outcome mark draws it (bits.tsx Mark). */
const MARK_TONE: Readonly<Record<Exclude<Tone, "none">, OutcomeTone>> = {
  pay: "paid",
  refuse: "refused",
  hold: "held",
};

/**
 * The verdict's mark, the page's outcome shapes: a dot for would pay, a struck circle for refused, a half-filled
 * circle for held. It is drawn in currentColor, the verdict's own colour, so forced colours reach it too. The word
 * says it, so the mark is hidden from a screen reader; with no verdict to show (asking, no answer, not an amount)
 * there is none.
 */
function VerdictMark({ tone }: { tone: Tone }) {
  if (tone === "none") return null;
  return <Mark tone={MARK_TONE[tone]} className={lc.mark} />;
}

/** The raw answer as code, with a line break offered after each comma between its members and nowhere else. */
function Raw({ raw }: { raw: string }) {
  // Each piece is keyed by where it starts in the answer, which no other piece shares.
  let start = 0;
  const pieces = rawPieces(raw).map((piece) => {
    const at = start;
    start += piece.length;
    return (
      <Fragment key={at}>
        {at === 0 ? null : <wbr />}
        {piece}
      </Fragment>
    );
  });
  return <code>{pieces}</code>;
}

/** A line of the request preview whose comment, after its last "  // ", is set quieter than the code. */
function Commented({ line }: { line: string }) {
  const at = line.lastIndexOf("  // ");
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at + 2)}
      <span className={lc.comment}>{line.slice(at + 2)}</span>
    </>
  );
}

export function LiveCheckClient({
  recorded,
  scenarios,
  mandates,
  copy,
  codes,
  explorer,
  level = 3,
}: LiveCheckProps) {
  const H = level === 4 ? "h4" : "h3";
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
      // Asking again after a failure with no recorded answer still shows that it is asking: previous may be null.
      setShown((cur) => ({ kind: "loading", previous: lastAnswer(cur) }));
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
        const [checked, mandateRead] = await Promise.allSettled([
          viewCall(
            LIVE_RPC_URLS,
            LIVE_VAULT,
            "check_spend",
            checkSpendArgs(
              c.mandateId,
              units,
              c.key === "agent" ? agentKeyFor(recorded, c.mandateId) : OTHER_PK,
            ),
            { signal: ctl.signal },
          ),
          mandate,
        ]);
        if (checked.status === "rejected") throw checked.reason;
        const check = checked.value;
        const answer: Answer = {
          request: { mandateId: c.mandateId, units, key: c.key, scenario: c.scenario },
          verdict: parseVerdict(check.value),
          raw: check.value,
          // A mandate that could not be read does not take the verdict down with it: it is shown as unread.
          mandate: mandateRead.status === "fulfilled" ? mandateRead.value : undefined,
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
        const fallback = c.scenario === null ? null : answerFromRecorded(recorded, c.scenario);
        setShown((cur) =>
          nextAnswer(cur, seq.current, {
            seq: mine,
            shown: { kind: "failed", fallback, reason: failureKind(e) },
          }),
        );
      }
    },
    [recorded],
  );

  // The first call runs once, on mount, whatever happens to `ask`'s identity afterwards.
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  }, [ask]);
  useEffect(() => {
    void askRef.current(asControls(DEFAULT));
    return () => {
      inflight.current?.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const change = (next: Controls, debounce: boolean) => {
    setControls(next);
    if (timer.current !== null) clearTimeout(timer.current);
    if (debounce) timer.current = setTimeout(() => void ask(next), 250);
    else void ask(next);
  };

  const active = controls.scenario;
  const injected = scenarios.find((x) => x.id === active)?.injected;
  const answer = lastAnswer(shown);
  // The panel describes the answer with the request it answers; the controls only drive the request preview.
  const m = answer?.mandate;
  const payee = payeeShown(recorded, controls.mandateId, answer);
  const signerPk = controls.key === "agent" ? agentKeyFor(recorded, controls.mandateId) : OTHER_PK;
  const injectedIds = new Set(scenarios.filter((x) => x.injected !== undefined).map((x) => x.id));
  const badAmount = shown.kind === "failed" && shown.reason === "badAmount";
  const tone = verdictTone(shown);
  const source = hintParts(shown, copy, LIVE_VAULT, utcTime);
  const method = labelled(copy.method);
  const rpc = answer?.rpcHost ? labelled(fill(copy.rpc, { host: answer.rpcHost })) : null;

  return (
    <div className={lc.grid}>
      <div className={lc.panel}>
        <H className={lc.title}>{copy.formTitle}</H>
        <p className={lc.hint}>{copy.formHint}</p>
        <fieldset className={lc.scenarios} aria-label={copy.scenariosLabel}>
          {scenarios.map((x) => (
            <button
              key={x.id}
              type="button"
              className={lc.scenario}
              aria-pressed={active === x.id}
              onClick={() => change(asControls(x.id as ScenarioId), false)}
            >
              {x.title}
              <small>{x.sub}</small>
            </button>
          ))}
        </fieldset>
        <div className={lc.fields}>
          <label className={lc.field}>
            <span className={lc.label}>{copy.mandateLabel}</span>
            <span className={lc.control}>
              <select
                value={controls.mandateId}
                onChange={(e) =>
                  change(edited({ ...controls, mandateId: Number(e.target.value) }), false)
                }
              >
                {mandates.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <div className={lc.field}>
            <label className={lc.label} htmlFor="live-amount">
              {copy.amountLabel}
            </label>
            <div className={`${lc.control} ${lc.amountRow}`}>
              <input
                type="range"
                min="0.5"
                max="60"
                step="0.5"
                aria-label={copy.amountSlider}
                value={parseUsdc(controls.amount) === null ? 0 : Number(controls.amount)}
                onChange={(e) => change(edited({ ...controls, amount: e.target.value }), true)}
              />
              <input
                id="live-amount"
                inputMode="decimal"
                aria-invalid={badAmount}
                aria-describedby={badAmount ? "live-why" : undefined}
                value={controls.amount}
                onChange={(e) => change(edited({ ...controls, amount: e.target.value }), true)}
              />
              <span>{copy.unit}</span>
            </div>
          </div>
          <div className={lc.field}>
            <span className={lc.label}>{copy.payeeLabel}</span>
            <div className={lc.control}>
              <code className={lc.payee}>
                {payee === undefined
                  ? copy.payeeUnread
                  : payee === null
                    ? copy.noPayee
                    : payeeText(payee)}
              </code>
              <span className={lc.lockNote}>{copy.payeeLock}</span>
            </div>
          </div>
          <label className={lc.field}>
            <span className={lc.label}>{copy.keyLabel}</span>
            <span className={lc.control}>
              <select
                value={controls.key}
                onChange={(e) =>
                  change(edited({ ...controls, key: e.target.value as KeyChoice }), false)
                }
              >
                <option value="agent">{copy.keyAgent}</option>
                <option value="other">{copy.keyOther}</option>
              </select>
            </span>
          </label>
        </div>
        {injected === undefined ? null : (
          <div className={lc.inj}>
            <p className={lc.injLabel}>{copy.injectedLead}</p>
            <blockquote className={lc.injQuote}>
              <p>"{injected}"</p>
            </blockquote>
            <p className={lc.injLine}>{copy.injectedTail}</p>
            <p className={lc.injLine}>
              {copy.injectedCanary}{" "}
              <Link className={`${s.link} ${lc.injLink}`} href={copy.injectedCanaryLink.href}>
                {copy.injectedCanaryLink.label} <span aria-hidden="true">→</span>
              </Link>
            </p>
          </div>
        )}
      </div>

      <div className={`${lc.panel} ${lc.ink} ${lc.answer}`}>
        <div className={lc.head}>
          <H className={lc.title}>{copy.answerTitle}</H>
          {explorer}
        </div>
        {/* While a request is out, the region is busy and its last sentence is dimmed: it is not the answer yet. */}
        <div
          aria-live="polite"
          aria-busy={shown.kind === "loading"}
          className={shown.kind === "loading" ? lc.busy : undefined}
        >
          <p className={`${lc.verdict} ${TONE_CLASS[tone]}`}>
            <VerdictMark tone={tone} />
            <span className={lc.word}>{verdictText(shown, copy, injectedIds)}</span>
          </p>
          <p id="live-why" className={lc.why}>
            <Keep text={sentenceText(shown, copy, codes, injectedIds)} />
          </p>
        </div>
        <p className={lc.source}>
          {source.lead}
          {source.raw === null ? null : <Raw raw={source.raw} />}
          {source.tail}
        </p>
        {shown.kind === "failed" && shown.reason !== "badAmount" ? (
          <button type="button" className={lc.retry} onClick={() => void ask(controls)}>
            {copy.retry}
          </button>
        ) : null}
        <div className={lc.request}>
          <p id="live-request-cap" className={lc.requestCap}>
            <KeepRich text={copy.requestLabel} />
          </p>
          <ScrollRegion className={lc.requestBody} labelledBy="live-request-cap">
            <pre>
              {"check_spend({\n  request: {\n"}
              {`    mandate_id: ${controls.mandateId},\n    `}
              <Commented line={amountLine(controls.amount, copy)} />
              {`\n    ${copy.requestFields},\n    `}
              <del className={lc.gone}>{copy.recipientField}</del>
              {"  "}
              <span className={lc.comment}>{`// ${copy.noRecipient}`}</span>
              {`\n  },\n  signer_pk: "${signerPk.slice(0, 14)}…"  `}
              <span className={lc.comment}>
                {`// ${controls.key === "agent" ? copy.agentKeyNote : copy.otherKeyNote}`}
              </span>
              {"\n})"}
            </pre>
          </ScrollRegion>
        </div>
        <div className={lc.foot}>
          <dl className={lc.footList}>
            <div className={lc.footRow}>
              <dt>{method.label}</dt>
              <dd>
                <KeepRich text={method.value} />
              </dd>
            </div>
            {rpc === null ? null : (
              <div className={lc.footRow}>
                <dt>{rpc.label}</dt>
                <dd>{rpc.value}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <div className={`${lc.panel} ${lc.mandate}`}>
        <H className={lc.title}>
          {fill(copy.mandateTitle, { id: answer?.request.mandateId ?? controls.mandateId })}
        </H>
        <p className={lc.hint}>{copy.mandateHint}</p>
        {m === undefined ? (
          <p className={lc.empty}>{copy.mandateUnread}</p>
        ) : m === null ? (
          <p className={lc.empty}>{copy.noMandate}</p>
        ) : (
          // Who is paid and how much first, then how often, until when, with which key and in what state.
          <dl className={lc.facts}>
            <div>
              <dt>{copy.fields.payee}</dt>
              <dd className={lc.id}>{payeeText(m.payee)}</dd>
            </div>
            <div>
              <dt>{copy.fields.maxPerPayment}</dt>
              <dd>
                {formatUsdc(m.maxPerPayment)} {copy.unit}
              </dd>
            </div>
            <div>
              <dt>{copy.fields.maxTotal}</dt>
              <dd>
                {fill(copy.left, { total: formatUsdc(m.maxTotal), left: formatUsdc(remaining(m)) })}
              </dd>
            </div>
            <div>
              <dt>{copy.fields.approvalAbove}</dt>
              <dd>
                {formatUsdc(m.approvalAbove)} {copy.unit}
              </dd>
            </div>
            <div>
              <dt>{copy.fields.uses}</dt>
              <dd>{fill(copy.usesOf, { uses: m.uses, max: m.maxUses })}</dd>
            </div>
            <div>
              <dt>{copy.fields.expires}</dt>
              <dd>{expiryDate(m)}</dd>
            </div>
            <div>
              <dt>{copy.fields.agentPk}</dt>
              <dd className={lc.id}>{`${m.agentPk.slice(0, 18)}…`}</dd>
            </div>
            <div>
              <dt>{copy.fields.status}</dt>
              <dd className={lc.id}>{m.status}</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
