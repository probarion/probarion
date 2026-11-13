"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type CheckOutcome,
  type Payout,
  type PayoutCheckId,
  runPayout,
  tally,
} from "@/lib/site/mainnet-payout";
import {
  CHECK_ORDER,
  checkRows,
  checkTitle,
  liveVerdict,
  type PayoutLiveCopy,
  readingVerdict,
  restVerdict,
  rowState,
  type ValuesFrom,
  type VerdictView,
} from "@/lib/site/mainnet-payout-view";
import { onMainnetRead } from "@/lib/site/mainnet-read";
import m from "./mainnet.module.css";

/**
 * The lists say their role out loud: Tailwind's preflight sets list-style: none, and Safari's VoiceOver then drops
 * list semantics (as in BuiltOn.tsx).
 */
const LIST = { role: "list" } as const;

/**
 * Where each check's tick sits on the route, from NEAR (0) to Base (1): the checks on NEAR share the first 70 percent,
 * the bridge is at 85 and the arrival on Base is at the end.
 */
const NEAR_SPAN = 0.7;
const BRIDGE = 0.85;
const POS: readonly number[] = CHECK_ORDER.map((_, i) =>
  i === CHECK_ORDER.length - 1 ? 1 : (i * NEAR_SPAN) / Math.max(1, CHECK_ORDER.length - 2),
);
/** The pause between two rows while a run lands, so the coin rides tick by tick. None under reduced motion. */
const STEP_MS = 260;
/** The widths at which each check's values fold behind a summary: the site's phone step. */
const PHONE = "(max-width: 620px)";

type Shown = CheckOutcome | "recorded" | "reading";
type Trace = "rest" | "running" | "done" | "stopped";
type RowName = "recorded" | "reading" | "pass" | "fail" | "unread";

const nameOf = (s: Shown): RowName => (typeof s === "string" ? s : s.state);
const byId = <T,>(f: (id: PayoutCheckId, i: number) => T) =>
  Object.fromEntries(CHECK_ORDER.map(({ id }, i) => [id, f(id, i)])) as Record<PayoutCheckId, T>;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const css = (vars: Record<string, number>) => vars as CSSProperties;

export interface MainnetPayoutClientProps {
  payout: Payout;
  /** The seven checks on the recorded reads, in CHECKS order: what the page shows at rest. */
  recorded: readonly CheckOutcome[];
  recordedAt: string;
  copy: PayoutLiveCopy;
  /** Server-rendered: the stone's label, the two figures and their transactions. */
  intro: ReactNode;
  /** Server-rendered: each check's "Read from" line, with its transaction links. */
  sources: Readonly<Record<PayoutCheckId, ReactNode>>;
  /** Server-rendered: what a visitor with no JavaScript reads in place of the button. */
  noScript: ReactNode;
  timing: string;
  foot: string;
  bridge: string;
  /**
   * Read by a screen reader after the button's label, and not shown: the payout it reads, so the buttons of two payouts
   * have two names.
   */
  own: string;
}

export function MainnetPayoutClient({
  payout,
  recorded,
  recordedAt,
  copy,
  intro,
  sources,
  noScript,
  timing,
  foot,
  bridge,
  own,
}: MainnetPayoutClientProps) {
  const atRest = () => byId<Shown>(() => "recorded");
  const restValues = () =>
    byId((_, i) => {
      const o = recorded[i];
      return o?.state === "pass" ? o.values : null;
    });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);
  const [trace, setTrace] = useState<Trace>("rest");
  const [shown, setShown] = useState<Record<PayoutCheckId, Shown>>(atRest);
  const [values, setValues] =
    useState<Record<PayoutCheckId, Record<string, string> | null>>(restValues);
  // Where each row's values come from: a row that fails or cannot be read keeps the last ones it showed.
  const [from, setFrom] = useState<Record<PayoutCheckId, ValuesFrom>>(() =>
    byId<ValuesFrom>(() => "recorded"),
  );
  const [verdict, setVerdict] = useState<VerdictView>(() =>
    restVerdict(copy, tally(recorded), recordedAt),
  );
  // Which rows show their values. The server renders them open, so a page with no script shows them all; on a phone
  // the script folds them, and a wider window opens them again.
  const [open, setOpen] = useState<Record<PayoutCheckId, boolean>>(() => byId(() => true));
  const inflight = useRef<AbortController | null>(null);

  // The button shows once the script runs; with no JavaScript the noscript line stands in its place.
  useEffect(() => {
    setReady(true);
    const phone = window.matchMedia?.(PHONE);
    const fold = () => setOpen(byId(() => !phone?.matches));
    fold();
    phone?.addEventListener("change", fold);
    return () => {
      phone?.removeEventListener("change", fold);
      inflight.current?.abort();
    };
  }, []);

  const run = async () => {
    if (inflight.current !== null) return;
    const ctl = new AbortController();
    inflight.current = ctl;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setBusy(true);
    setTrace("running");
    setShown(byId<Shown>(() => "reading"));
    setVerdict(readingVerdict(copy));
    const landed = new Map<PayoutCheckId, (o: CheckOutcome) => void>();
    const waits = CHECK_ORDER.map(
      ({ id }) => new Promise<CheckOutcome>((resolve) => landed.set(id, resolve)),
    );
    const result = runPayout(payout, {
      signal: ctl.signal,
      onCheck: (id, o) => landed.get(id)?.(o),
    });
    try {
      // The rows land in route order, each as soon as the reads it needs are back.
      for (const [i, { id }] of CHECK_ORDER.entries()) {
        const o = await Promise.race([
          waits[i] as Promise<CheckOutcome>,
          result.then((r) => r.outcomes[i] as CheckOutcome),
        ]);
        if (ctl.signal.aborted) return;
        setShown((cur) => ({ ...cur, [id]: o }));
        // A row that does not pass opens, so its values sit under the sentence that says where they come from.
        if (o.state !== "pass") setOpen((cur) => ({ ...cur, [id]: true }));
        if (o.state === "pass") {
          setValues((cur) => ({ ...cur, [id]: o.values }));
          setFrom((cur) => ({ ...cur, [id]: "earlier" }));
        }
        if (!calm) await pause(STEP_MS);
      }
      const r = await result;
      if (ctl.signal.aborted) return;
      setTrace(r.tally.state === "pass" ? "done" : "stopped");
      setVerdict(liveVerdict(copy, r.tally, r.startedAt, r.ms, r.hosts));
      setRan(true);
    } catch {
      if (ctl.signal.aborted) return;
      // runPayout turns every failed read into an unread check, so only a fault of this page lands here: back to rest.
      setTrace("rest");
      setShown(atRest());
      setValues(restValues());
      setFrom(byId<ValuesFrom>(() => "recorded"));
      setVerdict(restVerdict(copy, tally(recorded), recordedAt));
    } finally {
      if (inflight.current === ctl) {
        inflight.current = null;
        setBusy(false);
      }
    }
  };

  // The hero's "Read the chain now" asks this payout's stone to run, as its own button does. The listener calls the
  // latest `run`, so it is attached once.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => onMainnetRead(payout.id, () => void runRef.current()), [payout.id]);

  // The coin stands at the last tick of the unbroken run of passes from NEAR: at rest, the recorded run's.
  let coin = 0;
  for (const [i, { id }] of CHECK_ORDER.entries()) {
    const s = shown[id];
    const passed = s === "recorded" ? recorded[i]?.state === "pass" : nameOf(s) === "pass";
    if (!passed) break;
    coin = POS[i] ?? coin;
  }

  return (
    <div
      className={m.stone}
      data-trace={trace === "rest" ? undefined : trace}
      style={css({ "--p": coin })}
    >
      <div className={m.intro}>{intro}</div>

      <div className={m.route} aria-hidden="true">
        <span className={m.track}>
          <span className={m.sheen} />
        </span>
        <span className={m.dim} />
        <span className={m.bridge} style={css({ "--x": BRIDGE })} />
        <span className={m.coin}>
          <span className={m.glint} />
        </span>
        <ol className={m.ticks}>
          {CHECK_ORDER.map(({ id, n }, i) => (
            <li
              key={id}
              className={m.tick}
              data-state={nameOf(shown[id])}
              style={css({ "--x": POS[i] ?? 0 })}
            >
              {n}
            </li>
          ))}
          <li className={`${m.tick} ${m.tickBridge}`} style={css({ "--x": BRIDGE })}>
            {bridge}
          </li>
        </ol>
      </div>

      <p className={m.timing}>{timing}</p>

      <div className={m.runBar}>
        <div className={m.verdict} aria-live="polite" aria-atomic="true" data-tone={verdict.tone}>
          <span className={m.verdictTitle}>{verdict.title}</span>
          <span className={m.verdictSub}>{verdict.sub}</span>
        </div>
        <button
          type="button"
          className={m.run}
          hidden={!ready}
          aria-disabled={busy || undefined}
          onClick={() => void run()}
        >
          {busy ? copy.run.buttonBusy : ran ? copy.run.buttonAgain : copy.run.button}
          <span className="sr-only">{own}</span>
        </button>
        {noScript}
      </div>

      <ol className={m.checks} aria-busy={busy} {...LIST}>
        {CHECK_ORDER.map(({ id, n }) => {
          const s = shown[id];
          const name = nameOf(s);
          const v = values[id];
          const state = rowState(copy, s, from[id]);
          const problem =
            name === "fail" || name === "unread"
              ? `${state.word}${v !== null && state.note !== null ? ` ${state.note}` : ""}`
              : null;
          const rows = v === null ? [] : checkRows(copy, id, v);
          return (
            <li key={id} className={m.check} data-state={name}>
              <span className={m.checkRail} aria-hidden="true">
                <span className={m.railSheen} />
              </span>
              <span className={m.num} aria-hidden="true">
                {n}
              </span>
              <div className={m.what}>
                <h4 className={m.checkTitle}>
                  <span className="sr-only">{n} </span>
                  {checkTitle(copy, id, payout)}
                </h4>
                {problem === null ? (
                  <span className={m.state}>
                    <span className={m.word}>{state.word}</span>
                    {state.note === null ? null : <span> {state.note}</span>}
                  </span>
                ) : null}
                <span className={m.sources}>{sources[id]}</span>
              </div>
              <details
                className={m.vals}
                open={open[id]}
                onToggle={(e) => {
                  const now = e.currentTarget.open;
                  setOpen((cur) => (cur[id] === now ? cur : { ...cur, [id]: now }));
                }}
              >
                <summary className={m.valsSummary}>{copy.run.values}</summary>
                <dl className={id === "noaddr" ? m.fields : m.pairs}>
                  {rows
                    .filter((r) => !r.note)
                    .map((r) => (
                      <div key={r.label}>
                        <dt>{r.label}</dt>
                        <dd className={r.full ? m.full : undefined}>{r.text}</dd>
                      </div>
                    ))}
                </dl>
                {rows
                  .filter((r) => r.note)
                  .map((r) => (
                    <span key={r.text} className={m.valsNote}>
                      {r.text}
                    </span>
                  ))}
              </details>
              {problem === null ? null : <p className={m.problem}>{problem}</p>}
            </li>
          );
        })}
      </ol>

      <p className={m.foot}>{foot}</p>
    </div>
  );
}
