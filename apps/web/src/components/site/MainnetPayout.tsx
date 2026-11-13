import type { ReactNode } from "react";
import { ExternalLink } from "@/components/ui";
import { type CopyPart, MAINNET_PAYOUT } from "@/lib/site/facts";
import type { PayoutCheckId } from "@/lib/site/mainnet-payout";
import { PAYOUTS, RECORDED_RUNS, type RecordedRun } from "@/lib/site/mainnet-payout-data";
import {
  checkSources,
  foldView,
  newestFirst,
  ownName,
  type StoneEnd,
  type StoneView,
  sectionHead,
  stoneView,
  type TrailItem,
  type TrailView,
  trailView,
  type VerifyView,
  verifyView,
} from "@/lib/site/mainnet-payout-section";
import { CHECK_ORDER, liveCopy, type Tone } from "@/lib/site/mainnet-payout-view";
import { MainnetPayoutClient } from "./MainnetPayoutClient";
import m from "./mainnet.module.css";
import { Rich } from "./Rich";
import s from "./site.module.css";

const C = MAINNET_PAYOUT;

/** The lists say their role out loud (as in BuiltOn.tsx): Tailwind's preflight sets list-style: none. */
const LIST = { role: "list" } as const;
/** A no-break space: a link that wraps keeps its arrow on the line of its last word. */
const NBSP = " ";

const TONE: Readonly<Record<Tone, string | undefined>> = {
  neutral: m.toneNeutral,
  ok: m.toneOk,
  bad: m.toneBad,
};

/** The words a screen reader reads after a link's label, and the page does not show. */
function Sr({ text }: { text?: string }) {
  return text === undefined ? null : <span className="sr-only">{text}</span>;
}

/**
 * A line of copy with links in it: a place on this page or of the site stays in the tab, a transaction or a file opens
 * in a new one. A short hash keeps the site's mono face and stays whole while it fits; a link in words wraps between
 * them. A part can repeat (", " or ")"), so each key counts its own copies.
 */
function Parts({ parts }: { parts: readonly CopyPart[] }) {
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const id = typeof p === "string" ? p : p.href;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const key = `${id}#${n}`;
    if (typeof p === "string") return <Rich key={key} text={p} />;
    if (p.href.startsWith("#") || p.href.startsWith("/")) {
      return (
        <a key={key} className={s.link} href={p.href}>
          {p.label}
          <Sr text={p.sr} />
          {NBSP}
          <span aria-hidden="true">→</span>
        </a>
      );
    }
    return (
      <ExternalLink
        key={key}
        className={p.label.includes("…") ? `${s.link} ${m.tx} ${m.hash}` : s.link}
        href={p.href}
      >
        {p.label}
        <Sr text={p.sr} />
        {NBSP}
        <span aria-hidden="true">↗</span>
      </ExternalLink>
    );
  });
}

function End({ end, base }: { end: StoneEnd; base?: boolean }) {
  return (
    <div className={base ? `${m.end} ${m.endBase}` : m.end}>
      <span className={m.place}>{end.place}</span>
      <span className={m.figure}>
        <b>{end.figure}</b> <span className={`${m.pill} ${TONE[end.tone]}`}>{end.unit}</span>
      </span>
      <p className={m.endLine}>
        <Parts parts={end.line} />
      </p>
    </div>
  );
}

/** The top of the stone: what this payout was and how it was decided, then the burn on NEAR and the arrival on Base. */
function StoneIntro({ view }: { view: StoneView }) {
  return (
    <>
      <p className={m.caveat}>
        <strong className={m.caveatLabel}>{view.label}</strong> {view.test} {view.decided}
      </p>
      <div className={m.ends}>
        <End end={view.near} />
        <End end={view.base} base />
      </div>
    </>
  );
}

/** An internal link with its arrow. */
function Go({ link }: { link: { label: string; href: string; sr?: string } }) {
  return (
    <a className={s.link} href={link.href}>
      {link.label}
      <Sr text={link.sr} />
      {NBSP}
      <span aria-hidden="true">→</span>
    </a>
  );
}

function Entry({ item }: { item: TrailItem }) {
  return (
    <>
      <span className={m.entryHead}>
        <span className={m.entryLabel}>{item.label}</span>{" "}
        <span className={`${m.pill} ${TONE[item.tone]}`}>{item.pill}</span>
      </span>
      <p className={m.entryText}>
        <Parts parts={item.text} />
      </p>
    </>
  );
}

type Group = { spur: true; items: TrailItem[] } | { spur: false; item: TrailItem };

/** The ledger in order, with each run of refused proposals gathered onto one spur off the main line. */
function groups(items: readonly TrailItem[]): Group[] {
  const out: Group[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (!item.spur) out.push({ spur: false, item });
    else if (last?.spur) last.items.push(item);
    else out.push({ spur: true, items: [item] });
  }
  return out;
}

/**
 * The decision trail: a gold main line, the attested proposals that code refused on a dashed spur that ends in a
 * refusal, then the allowed decision and the burn. Under it, the anchors as coin seals, each with the entries it covers.
 */
function Trail({ view, entries, id }: { view: TrailView; entries: readonly number[]; id: string }) {
  return (
    <div className={m.trail}>
      <h4 className={m.sideTitle}>{view.title}</h4>
      <p className={m.setup}>
        <Parts parts={view.setup} />
      </p>
      <ol className={m.line} {...LIST}>
        {groups(view.items).map((g) =>
          g.spur ? (
            <li key={`spur-${g.items[0]?.seq}`} className={m.spur}>
              <span className={m.spurName} id={`${id}-spur-${g.items[0]?.seq}`}>
                {view.spur}
              </span>
              <ol
                className={m.spurList}
                aria-labelledby={`${id}-spur-${g.items[0]?.seq}`}
                {...LIST}
              >
                {g.items.map((item) => (
                  <li key={item.seq} className={m.entry}>
                    <Entry item={item} />
                  </li>
                ))}
              </ol>
              <span className={m.spurEnd}>{view.spurEnd}</span>
            </li>
          ) : (
            <li key={g.item.seq} className={`${m.entry} ${m.station}`}>
              <Entry item={g.item} />
            </li>
          ),
        )}
      </ol>
      <p className={m.trailSum}>
        <Parts parts={view.summary} />
      </p>
      <ol className={m.seals} aria-label={view.sealsLabel} {...LIST}>
        {view.seals.map((seal) => (
          <li key={seal.seq} className={m.seal}>
            <span className={m.sealCoin} aria-hidden="true">
              {seal.seq}
            </span>
            <span className={m.sealText}>
              {seal.text}
              {C.comma}
              <ExternalLink className={`${s.link} ${m.tx} ${m.hash}`} href={seal.tx.url}>
                {seal.tx.label}
                {NBSP}
                <span aria-hidden="true">↗</span>
              </ExternalLink>
              <span className={m.cover} aria-hidden="true">
                {entries.map((seq) => (
                  <i key={seq} data-on={seq >= seal.from && seq <= seal.to ? "" : undefined} />
                ))}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The verifier's run with the ledger file: its verdict, and the full list of checks in the #verify section. */
function Verify({ view }: { view: VerifyView }) {
  return (
    <div className={m.verify}>
      <h4 className={m.sideTitle}>{view.title}</h4>
      <p className={m.verifyLead}>{view.lead}</p>
      <div className={m.verifyBlock}>
        <span className={view.tone === "ok" ? m.resultOk : m.resultBad}>{view.result}</span>
        <span className={m.verifyCounts}>{view.counts}</span>
        {view.attested === null ? null : <span className={m.verifyAttested}>{view.attested}</span>}
      </div>
      <p className={m.verifyFoot}>{view.foot}</p>
      <ul className={m.verifyLinks} {...LIST}>
        <li>
          <ExternalLink className={s.link} href={view.output.href}>
            {view.output.label}
            <Sr text={view.output.sr} />
            {NBSP}
            <span aria-hidden="true">↗</span>
          </ExternalLink>
        </li>
        <li>
          <Go link={view.link} />
        </li>
        <li>
          <Go link={view.docs} />
        </li>
      </ul>
    </div>
  );
}

/** The vault's two transactions of 2026-11-11, beside the newest payout: complementary to it, so an aside. */
function Earlier() {
  const E = C.earlier;
  return (
    <aside className={m.earlier} aria-labelledby="mainnet-earlier">
      <h3 className={m.sideTitle} id="mainnet-earlier">
        {E.title}
      </h3>
      <ul className={m.earlierList} {...LIST}>
        {E.rows.map((r) => (
          <li key={r.tx.hash}>
            <span className={m.earlierText}>
              <Rich text={r.text} />
            </span>{" "}
            <ExternalLink className={`${s.link} ${m.tx} ${m.hash}`} href={r.tx.url}>
              {r.tx.label}
              {NBSP}
              <span aria-hidden="true">↗</span>
            </ExternalLink>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * What one payout shows under its heading: its stone, with its own live re-read, then its decision trail beside the
 * verifier's verdict, so each h4 sits under the payout it is about.
 */
function PayoutBody({ run, aside }: { run: RecordedRun; aside: boolean }) {
  const p = run.payout;
  const stone = stoneView(p);
  const sources = Object.fromEntries(
    CHECK_ORDER.map(({ id }) => [id, <Parts key={id} parts={checkSources(p, id)} />]),
  ) as Record<PayoutCheckId, ReactNode>;
  return (
    <>
      <div className={m.stoneWrap}>
        <MainnetPayoutClient
          payout={p}
          recorded={run.outcomes}
          recordedAt={run.recordedAt}
          copy={liveCopy(C)}
          intro={<StoneIntro view={stone} />}
          sources={sources}
          noScript={
            <noscript>
              <p className={m.noJs}>{C.run.noScript}</p>
            </noscript>
          }
          timing={stone.timing}
          foot={C.run.foot}
          bridge={C.stone.bridge}
          own={ownName(p)}
        />
      </div>
      <div className={m.lower}>
        <Trail view={trailView(p)} entries={p.trail.map((e) => e.seq)} id={p.id} />
        <div className={m.side}>
          <Verify view={verifyView(p, PAYOUTS)} />
          {aside ? <Earlier /> : null}
        </div>
      </div>
    </>
  );
}

/**
 * The newest payout, one article, open. With more than one payout, its heading shows: the stones need it, and the
 * earlier ones carry theirs in their summaries.
 */
function PayoutBlock({ run, many }: { run: RecordedRun; many: boolean }) {
  const titleId = `${run.payout.id}-title`;
  return (
    <article className={m.payout} aria-labelledby={titleId}>
      <h3 className={many ? m.payoutTitle : "sr-only"} id={titleId}>
        {stoneView(run.payout).aria}
      </h3>
      <PayoutBody run={run} aside />
    </article>
  );
}

/**
 * An earlier payout, one article, folded in a native details that starts closed and opens with no script. The
 * summary holds its heading, what it was and how it was decided, and a hint to open it; inside, the same stone, with
 * its own button, the trail and the verdict as the newest payout shows.
 */
function FoldedPayout({ run }: { run: RecordedRun }) {
  const titleId = `${run.payout.id}-title`;
  const fold = foldView(run.payout);
  return (
    <article className={m.payout} aria-labelledby={titleId}>
      <details className={m.fold}>
        <summary className={m.foldSummary}>
          <h3 className={m.foldTitle} id={titleId}>
            {fold.title}
          </h3>
          <span className={m.foldLine}>{fold.line}</span>
          <span className={m.foldHint}>
            <span className={m.foldShow}>{fold.show}</span>
            <span className={m.foldHide}>{fold.hide}</span>
            <span className={m.foldArrow} aria-hidden="true">
              ↓
            </span>
          </span>
        </summary>
        <div className={m.foldBody}>
          <PayoutBody run={run} aside={false} />
        </div>
      </details>
    </article>
  );
}

/**
 * The payouts to Base on NEAR mainnet (#mainnet), between the ink band, which says the agent cannot name a payee, and
 * the console screenshots. The newest payout shows first and open; each earlier one follows, folded. Each count and
 * amount comes from the data, so another payout adds a fold and changes no copy. The page is complete with no
 * JavaScript and no network; each stone's button re-reads its payout from the visitor's browser.
 */
export function MainnetPayout() {
  if (RECORDED_RUNS.length === 0) return null;
  const head = sectionHead(PAYOUTS);
  const [newest, ...earlier] = newestFirst(RECORDED_RUNS);
  if (newest === undefined) return null;
  return (
    <section className={m.section} id="mainnet" aria-labelledby="mainnet-title">
      <div className={s.wrap}>
        <p className={s.eyebrow}>{head.eyebrow}</p>
        <div className={m.head}>
          <h2 className={s.h2} id="mainnet-title">
            <span className={m.headLine}>{head.line1}</span>{" "}
            <span className={`${m.headLine} ${s.gold}`}>{head.line2}</span>
          </h2>
          <p className={m.lede}>
            <Rich text={head.lede} />
          </p>
        </div>
        <div className={m.payouts}>
          <PayoutBlock run={newest} many={earlier.length > 0} />
          {earlier.length > 0 ? (
            <div className={m.folds}>
              {earlier.map((run) => (
                <FoldedPayout key={run.payout.id} run={run} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
