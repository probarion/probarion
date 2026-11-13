// The #mainnet section's words for the server render, as plain functions of the payouts: the head, the dark card of
// each payout, its decision trail and the verifier's verdict, with the transaction links. It reads MAINNET_PAYOUT and
// the explorer links from facts.ts, so the server component imports it and the client component does not: that one uses
// lib/site/mainnet-payout-view.ts with the copy it is handed. Every count and amount comes from the data.
import {
  baseTxFact,
  type CopyPart,
  MAINNET_PAYOUT,
  mainnetTxFact,
  repoFileUrl,
  type TxFact,
} from "./facts";
import {
  CHECKS,
  fill,
  nsToIso,
  type Payout,
  type PayoutCheckId,
  type ReadName,
  shortAddr,
  shortHex,
  type TrailEntry,
  usdc,
  utcDate,
  utcMinute,
} from "./mainnet-payout";
import {
  decidedBy,
  listText,
  numberWord,
  refusedProposals,
  type Tone,
} from "./mainnet-payout-view";

const C = MAINNET_PAYOUT;

/** A link part for a transaction. */
const link = (t: TxFact): CopyPart => ({ label: t.label, href: t.url });
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sum = (xs: readonly string[]) => xs.reduce((a, x) => a + BigInt(x), 0n);

// --- the section head -----------------------------------------------------------------------------

export interface SectionHead {
  eyebrow: string;
  line1: string;
  line2: string;
  lede: string;
}

/** The eyebrow, the two lines of the h2 and the lede, over every payout. */
export function sectionHead(payouts: readonly Payout[]): SectionHead {
  const dates = [...new Set(payouts.map((p) => p.date))].sort();
  const vaults = [...new Set(payouts.map((p) => p.vault))];
  const wallets = new Set(payouts.map((p) => `${p.chain}:${p.payee.toLowerCase()}`)).size;
  return {
    eyebrow: fill(C.eyebrow, { dates: listText(C, dates) }),
    line1: C.line1,
    line2: C.line2,
    lede: fill(payouts.length === 1 ? C.lede.one : C.lede.many, {
      count: capital(numberWord(C, payouts.length)),
      vault: listText(C, vaults),
      amount: usdc(sum(payouts.map((p) => p.amount))),
      received: usdc(sum(payouts.map((p) => p.received))),
      wallets: wallets === 1 ? C.wallets.one : fill(C.wallets.many, { n: numberWord(C, wallets) }),
    }),
  };
}

// --- the stone ------------------------------------------------------------------------------------

export interface StoneEnd {
  place: string;
  figure: string;
  unit: string;
  tone: Tone;
  line: CopyPart[];
}

export interface StoneView {
  id: string;
  aria: string;
  /** "A test, not a customer payment". */
  label: string;
  test: string;
  /** How it was decided, and what code refused before. */
  decided: string;
  near: StoneEnd;
  base: StoneEnd;
  timing: string;
}

/** The dark card of one payout: what it was, how it was decided, the two figures and their transactions. */
export function stoneView(p: Payout): StoneView {
  const refused = refusedProposals(p).length;
  const d = C.stone.decided[decidedBy(p)];
  const burned = utcMinute(p.pin.at);
  const arrived = utcMinute(p.base.at);
  return {
    id: p.id,
    aria: fill(C.stone.aria, { spendId: p.spendId, date: p.date }),
    label: C.stone.label,
    test: C.stone.test,
    decided: fill(refused === 0 ? d.none : refused === 1 ? d.one : d.many, {
      refused: numberWord(C, refused),
    }),
    near: {
      place: C.stone.near.place,
      figure: usdc(p.amount),
      unit: C.stone.near.unit,
      tone: "neutral",
      line: [
        fill(C.stone.near.line, { vault: p.vault, spendId: p.spendId }),
        C.comma,
        link(mainnetTxFact(p.tx.spend.hash)),
      ],
    },
    base: {
      place: C.stone.base.place,
      figure: usdc(p.received),
      unit: C.stone.base.unit,
      tone: "ok",
      line: [
        fill(C.stone.base.line, { payee: shortAddr(p.payee), block: p.base.block }),
        C.comma,
        link(baseTxFact(p.tx.base)),
      ],
    },
    timing:
      burned === arrived && utcDate(p.pin.at) === utcDate(p.base.at)
        ? fill(C.stone.sameMinute, { minute: burned, fee: usdc(p.fee) })
        : fill(C.stone.apart, { burned, arrived, fee: usdc(p.fee) }),
  };
}

// --- the checks' sources --------------------------------------------------------------------------

/** The transaction a read fetches, on its explorer; null for a view. */
function readTx(p: Payout, read: ReadName): TxFact | null {
  if (read === "base") return baseTxFact(p.tx.base);
  if (read === "mandate" || read === "spend" || read === "anchor") {
    return mainnetTxFact(p.tx[read].hash);
  }
  return null;
}

/** What a check rests on besides the chain: the request type at the vault's build, the ledger file, the bridge's status. */
function sourcesMore(p: Payout, id: PayoutCheckId): CopyPart[] {
  const M = C.sourcesMore;
  if (id === "noaddr") {
    const href = repoFileUrl("contracts/vault/src/types.rs", p.build.commit);
    return [M.noaddr.lead, { label: M.noaddr.label, href }];
  }
  if (id === "anchor")
    return [M.anchor.lead, { label: M.anchor.label, href: repoFileUrl(p.files.ledger) }];
  if (id === "base") {
    return [
      fill(M.base.lead, { spendId: p.spendId }),
      { label: M.base.label, href: repoFileUrl(p.files.poa) },
    ];
  }
  return [];
}

/**
 * The line under a check's title: what it reads, from the check's own `needs`. The transactions come first, each a link
 * to its explorer, then the views by their method name, then the files or the code the check also rests on.
 */
export function checkSources(p: Payout, id: PayoutCheckId): CopyPart[] {
  const needs = CHECKS.find((c) => c.id === id)?.needs ?? [];
  const ordered = [
    ...needs.filter((r) => readTx(p, r) !== null),
    ...needs.filter((r) => readTx(p, r) === null),
  ];
  const parts: CopyPart[] = [C.sourcesLead];
  ordered.forEach((read, i) => {
    if (i > 0) parts.push(i === ordered.length - 1 ? C.and : C.comma);
    const tx = readTx(p, read);
    parts.push(
      tx === null ? `\`${C.reads.names[read]}\`` : { label: C.reads.names[read], href: tx.url },
    );
  });
  return [...parts, ...sourcesMore(p, id)];
}

// --- the decision trail ---------------------------------------------------------------------------

export interface TrailItem {
  seq: number;
  label: string;
  pill: string;
  tone: Tone;
  text: CopyPart[];
  /** On the dashed spur off the main line: an attested proposal code refused. */
  spur: boolean;
}

/** One anchor, drawn as a coin seal: its number, the entries it covers, and its transaction. */
export interface SealItem {
  seq: number;
  /** The entries it covers, 0 to count - 1. */
  from: number;
  to: number;
  text: string;
  tx: TxFact;
}

export interface TrailView {
  title: string;
  setup: CopyPart[];
  items: TrailItem[];
  spur: string;
  spurEnd: string;
  sealsLabel: string;
  seals: SealItem[];
  summary: CopyPart[];
}

function entryText(e: TrailEntry, p: Payout, earlier: readonly TrailEntry[]): CopyPart[] {
  const E = C.trail.entries;
  const vars = {
    model: e.model ?? "",
    action: e.action ?? "",
    rule: e.refusedBy.join(", "),
    bodyHash: shortHex(e.bodyHash),
    spendId: p.spendId,
  };
  if (e.kind === "payment") {
    return [
      fill(E.payment, { spendId: e.spend?.id ?? p.spendId, amount: usdc(p.amount) }),
      C.comma,
      link(mainnetTxFact(e.spend?.tx ?? p.tx.spend.hash)),
      ".",
    ];
  }
  if (e.verdict === "refuse") {
    if (e.model === null) return [fill(E.refusedRules, vars)];
    const again = earlier.some(
      (x) =>
        x.verdict === "refuse" && x.model !== null && x.refusedBy.join() === e.refusedBy.join(),
    );
    if (again) return [fill(E.refusedAgain, vars)];
    return [fill(e.hintIsAsset ? E.refusedAsset : E.refused, vars)];
  }
  if (e.verdict === "allow") {
    if (e.decidedBy === "model+rules") return [fill(E.allowedModel, vars)];
    return [
      fill(earlier.some((x) => x.model !== null) ? E.allowedRulesAfter : E.allowedRules, vars),
    ];
  }
  return [E.held];
}

function entryPill(e: TrailEntry): { pill: string; tone: Tone } {
  const P = C.trail.pills;
  if (e.kind === "payment") return { pill: P.burned, tone: "neutral" };
  if (e.verdict === "refuse") return { pill: P.refused, tone: "bad" };
  if (e.verdict === "allow") {
    return { pill: e.decidedBy === "model+rules" ? P.allowedModel : P.allowedRules, tone: "ok" };
  }
  return { pill: P.held, tone: "neutral" };
}

function setupLine(p: Payout): CopyPart[] {
  const sameDay = p.setup.every((s) => utcDate(s.at) === p.date);
  const parts: CopyPart[] = [sameDay ? C.trail.setupLead.sameDay : C.trail.setupLead.before];
  p.setup.forEach((s, i) => {
    if (i > 0) parts.push(i === p.setup.length - 1 ? C.trail.setupLast : C.trail.setupSep);
    const text = fill(C.trail.setup[s.kind], {
      amount: s.amount === null ? "" : usdc(s.amount),
      mandateId: p.mandate.id,
      max: usdc(p.mandate.maxPerPayment),
      uses: p.mandate.maxUses,
      until: utcDate(nsToIso(p.mandate.expiresAtNs)),
    });
    parts.push(`${text} (`, link(mainnetTxFact(s.tx)), ")");
  });
  parts.push(".");
  return parts;
}

function sealText(seq: number, count: number): string {
  const S = C.trail.seal;
  const t = count === 1 ? S.one : count === 2 ? S.two : S.range;
  return fill(t, { seq, from: 0, to: count - 1 });
}

/** The decision trail of one payout: the setup, the ledger entries in order, the anchors as seals. */
export function trailView(p: Payout): TrailView {
  const refused = refusedProposals(p);
  const spur = new Set(refused.map((e) => e.seq));
  const lastCovered = Math.max(0, ...p.seals.map((s) => s.count)) - 1;
  const lastSeq = p.trail.at(-1)?.seq ?? 0;
  const S = lastCovered >= lastSeq ? C.trail.summary : C.trail.summaryPartial;
  const sumVars = { entries: p.trail.length, anchors: p.seals.length, last: lastCovered };
  return {
    title: C.trail.title,
    setup: setupLine(p),
    items: p.trail.map((e, i) => ({
      seq: e.seq,
      label: fill(C.trail.entry, { seq: e.seq, minute: utcMinute(e.at) }),
      ...entryPill(e),
      text: entryText(e, p, p.trail.slice(0, i)),
      spur: spur.has(e.seq),
    })),
    spur: C.trail.spur,
    spurEnd: C.trail.spurEnd,
    sealsLabel: C.trail.sealsLabel,
    seals: p.seals.map((s) => ({
      seq: s.seq,
      from: 0,
      to: s.count - 1,
      text: sealText(s.seq, s.count),
      tx: mainnetTxFact(s.tx),
    })),
    summary: [
      fill(S.lead, sumVars),
      { label: S.label, href: repoFileUrl(p.files.ledger) },
      fill(S.tail, sumVars),
    ],
  };
}

// --- the verifier ---------------------------------------------------------------------------------

export interface VerifyView {
  title: string;
  lead: string;
  result: string;
  tone: Tone;
  counts: string;
  attested: string | null;
  foot: string;
  /** The run's text output in the evidence folder. */
  output: { label: string; href: string };
  /** To the #verify section, which lists the checks. */
  link: { label: string; href: string };
  /** The step-by-step docs page. */
  docs: { label: string; href: string };
}

/** The verifier's run on the payout with the ledger file: its verdict line, not the list of checks. */
export function verifyView(p: Payout): VerifyView {
  const v = p.verify;
  const attested = p.trail.filter((e) => e.attested).length;
  return {
    title: C.verify.title,
    lead: fill(C.verify.lead, { date: utcDate(v.at) }),
    result: v.ok ? C.verify.result.pass : C.verify.result.fail,
    tone: v.ok ? "ok" : "bad",
    counts: fill(C.verify.counts, {
      passed: v.passed,
      failed: v.failed,
      unproven: v.unproven,
      skipped: v.skipped,
    }),
    attested:
      attested === 0
        ? null
        : fill(v.quoteOnline ? C.verify.attested.online : C.verify.attested.offline, { attested }),
    foot: C.verify.foot,
    output: { label: C.verify.output, href: repoFileUrl(p.files.verify) },
    link: C.verify.link,
    docs: C.verify.docs,
  };
}
