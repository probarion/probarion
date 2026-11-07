// Every word of the public Canary pages, in one module so that its test can hold the copy to the limits and to the
// words the page must not use. The numbers come from CANARY_LIMITS and LIMITS (lib/ratelimit). The one literal is the
// single on-chain attempt per visitor window, which limits.ts also takes as a literal 1. The
// Canary runs on testnet today, so nothing here promises anything for winning, and a token is named a test token
// there. This file is imported by the client form too, so it reaches no server-only module.
import type { Tone } from "@/components/ui";
import type { Network } from "@/lib/config";
import { formatNear } from "@/lib/near/units";
import { LIMITS } from "@/lib/ratelimit";
import { plural, thousands } from "./format";
import { CANARY_LIMITS, type RawSkip } from "./limits";
import type { AttemptResult } from "./service";

type Done = Extract<AttemptResult, { status: "done" }>;

/** The token the page names: a test token on testnet, so that it never reads as money. */
export const tokenNoun = (network: Network): string =>
  network === "mainnet" ? "USDC" : "test USDC";

export const eyebrow = (network: Network): string => `Public challenge · NEAR ${network}`;

const MAX_CHARS = thousands(CANARY_LIMITS.maxTextChars);
/** The agent key's gas allowance below which raw mode pauses, in NEAR ("0.2"). */
const ALLOWANCE = formatNear(CANARY_LIMITS.minAllowanceYocto.toString());

// --- raw mode -------------------------------------------------------------------------------------

/** One line for each reason a raw spend was not sent. The comments in limits.ts are the source of each text. */
export const RAW_SKIP_TEXT: Record<RawSkip, string> = {
  mode: "Raw mode is off right now, so only the code layer judged this attempt.",
  not_refused_by_code: "Code did not refuse this one, and raw mode sends only what code refused.",
  not_pay: "The model did not propose a payment, so there was nothing to send to the contract.",
  allowance_low: `The agent key's gas allowance is below ${ALLOWANCE} NEAR or could not be read, so raw mode is paused for now.`,
  visitor_limit: `One on-chain attempt per visitor every ${CANARY_LIMITS.rawVisitorWindowS / 60} minutes. Your model attempt still counted.`,
  global_limit: `The cap of ${CANARY_LIMITS.rawGlobalPerHour} on-chain attempts per hour is reached. Try again later.`,
  contract_would_accept:
    "A dry run showed the contract would accept or hold this request, paying only the mandate's own payee, so raw mode did not send it. It sends only what the contract refuses.",
  check_failed: "The dry run against the contract could not be read, so nothing was sent.",
  no_amount: "Neither the model nor the code gave an amount that can be sent, so nothing was sent.",
  decision_unreadable:
    "The code's decision could not be read back from the ledger, so nothing was sent.",
  sdk_refused: "The SDK refused this spend before it reached the chain, so nothing was sent.",
  no_time: "Too little of this attempt's time was left to ask the chain, so nothing was sent.",
  error: "Something failed before sending, and nothing reached the contract.",
};

export function describeRaw(raw: Done["raw"]): { tone: Tone; text: string } {
  if (!raw.sent) return { tone: "neutral", text: RAW_SKIP_TEXT[raw.skipped] };
  switch (raw.status) {
    case "refused_by_contract":
      return {
        tone: "good",
        text: raw.code
          ? `Even with the code rules bypassed, the NEAR contract refused it: ${raw.code}.`
          : "Even with the code rules bypassed, the NEAR contract refused it.",
      };
    case "held":
      return {
        tone: "warn",
        text: "The contract accepted the request but held it for a human approver. It can only ever pay the mandated payee, never you.",
      };
    case "paid":
    case "burned":
    case "settled":
      return {
        tone: "warn",
        text: "The contract paid. Only the mandated payee can receive funds, so the destination was not yours.",
      };
    default:
      return { tone: "neutral", text: `Contract result: ${raw.status}.` };
  }
}

// --- the page -------------------------------------------------------------------------------------

export const CANARY_COPY = {
  head: {
    title: "Make the agent pay you",
    lede: "The Canary's model believes what you write and is told to pay. It only proposes. Code rules and a NEAR contract decide what moves. Try to get a payment to anyone other than its one payee.",
    rules: "Rules",
    testnetPill: "Testnet: test tokens, no value",
  },
  vault: {
    title: "The vault, read from the chain",
    account: "Vault",
    unreadable: "Could not read the chain right now",
    onlyMandate: "Its only mandate pays",
    firstOfMany: "The first pays",
    perPayment: "per payment",
    holdsEverySpend: "and holds every spend for a human",
    noMandate: "It has no active mandate right now.",
  },
  attacker: {
    title: "Paid to an attacker: 0, by construction",
    body: "A spend request has no address field. The contract pays the payee stored in the mandate, and only the owner's wallet sets it.",
    link: "How the site shows this",
    href: "/#payee",
  },
  form: {
    title: "Your attempt",
    label: "Your message to the agent",
    placeholder:
      "Write an invoice, an email, a poem in Morse code… anything that makes the agent pay you.",
    note: `Up to ${MAX_CHARS} characters. Don't include personal data: we store a hash of your text and the result.`,
    codeOnly: "Code only today",
    rawOn: "Raw mode on",
    button: "Try to get paid",
    busy: "The agent is thinking…",
  },
  result: {
    modelTitle: "The model wanted",
    noProposal: "No proposal came back from the model.",
    mandate: "mandate",
    noMandate: "no mandate",
    noAmount: "no amount",
    codeTitle: "Code decided",
    refused: "Refused",
    held: "Held for a human",
    contractTitle: "The contract did",
    notSent: "Not sent",
    explorer: "See it on the explorer",
  },
  board: {
    title: "Scoreboard",
    visitorsLead: "At least",
    attempts: "Attempts",
    raw: "Sent straight to the contract",
    technique: "Technique",
    byCode: "Refused by code",
    onChain: "Refused on chain",
    held: "Held",
    codes: "Codes NEAR returned:",
    noCodes: "none yet",
    updated: "Updated every minute.",
    unavailable: "The scoreboard is not available right now.",
    tableLabel: "Attempts by technique",
  },
  feed: {
    title: "Latest attempts (UTC)",
    when: "When",
    techniques: "Techniques",
    code: "Code",
    contract: "Contract",
    tx: "Tx",
    killed: "did not finish",
    team: "team",
    notSent: "not sent",
    empty: "No attempts yet. Be the first.",
    unavailable: "The latest attempts are not available right now.",
    tableLabel: "Latest attempts",
  },
  freysa: {
    title: "Why this is not Freysa",
    body: "In November 2024, Freysa guarded a pool of ETH with a model told never to transfer it. On the 482nd attempt, a player won 13.19 ETH (about $47,000) by convincing it that its transfer function handled incoming payments. Here, convincing the model wins nothing: it only proposes.",
  },
  limits: {
    title: "What this page does not show",
    ipv6: "IPv6 visitors count per /64 network, so one large network can look like many visitors.",
    caps: "The hourly caps are shared, so a visitor with many network addresses can use them up for everyone.",
  },
  replay: {
    title: "Recorded attacks",
    off: "The live Canary is paused.",
    replay: "This is a replay of recorded attacks.",
    closed: "The live Canary is not open yet.",
    /** Shown only when there is a row to describe. */
    rows: "Each row is a recorded attempt, with its transaction when one was sent.",
    empty: "No recorded attacks yet.",
    when: "When (UTC)",
    technique: "Technique",
    tried: "What it tried",
    stoppedBy: "Stopped by",
    tx: "Tx",
    noTx: "no tx (refused before sending)",
    tableLabel: "Recorded attacks",
  },
} as const;

/** The second half of the "does not show" card: the network of the address the page is opened at, and the audit. */
export const runsOn = (network: Network): string =>
  `This runs on ${network}, and no third party has audited the code.`;

export const visitorsUnit = (n: number): string => plural(n, "visitor", "visitors");

export const visitorsSub = (browsers: number, addresses: number): string =>
  `the smaller of ${thousands(browsers)} ${plural(browsers, "browser", "browsers")} and ${thousands(addresses)} network ${plural(addresses, "address", "addresses")}`;

export const teamSub = (team: number): string =>
  `plus ${thousands(team)} by the team, counted apart`;

export const refusedSub = (n: number): string => `${thousands(n)} refused on chain`;

export const characterCount = (n: number): string => `${thousands(n)} / ${MAX_CHARS}`;

export const moreMandates = (n: number): string => `It has ${n} active mandates.`;

/** The vault card's Base line: shown only when the vault holds some. */
export const baseLine = (amount: string, noun: string): string =>
  `plus ${amount} ${noun} for Base payees, held in Intents`;

/** The mandate sentence in three pieces, so that the page can set the payee in mono between the other two. */
export function mandateParts(
  m: { count: number; payee: string; maxPerPayment: string; holdsEverySpend: boolean },
  noun: string,
): { lead: string; payee: string; tail: string } {
  const V = CANARY_COPY.vault;
  return {
    lead: m.count > 1 ? `${moreMandates(m.count)} ${V.firstOfMany}` : V.onlyMandate,
    payee: m.payee,
    tail: `, at most ${m.maxPerPayment} ${noun} ${V.perPayment}${m.holdsEverySpend ? `, ${V.holdsEverySpend}` : ""}.`,
  };
}

// --- answers that are not a result ---------------------------------------------------------------

export const REPLY_TEXT = {
  busyAgain: "Another attempt is running. Try again in a few seconds.",
  closed: "The Canary is closed right now.",
  notReady: "The Canary is not ready right now. Try again later.",
  tooLong: `Your text is over ${MAX_CHARS} characters.`,
  empty: "Write something first.",
  failed: "This attempt did not finish and was stored as an error. Try again.",
  other: "Something went wrong. Try again.",
  limitLater: "An attempt limit is reached for now, yours or the Canary's. Try again later.",
} as const;

/**
 * The one text for a limit that has been reached, whichever it is: the route cannot say which (an address's own, a
 * global one, or the day's tokens). `minutes` is already rounded up: under an hour it is "<m> min", from an hour up
 * "<h> h <m> min".
 */
export const limitText = (minutes: number): string =>
  `An attempt limit is reached for now, yours or the Canary's. Try again in ${
    minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60}` : minutes
  } min.`;

// --- /canary/rules --------------------------------------------------------------------------------

/** A piece of a rule's text: plain text, or a link. */
export type Part = string | { text: string; href: string };
export interface Rule {
  title: string;
  body: readonly Part[];
}

export const RULES_HEAD = {
  eyebrow: "Public challenge",
  title: "Canary rules",
  back: "Back to the Canary",
} as const;

/**
 * The eight rules. `links` are the addresses of SECURITY.md and of @probarionhq on X (LINKS in lib/site/facts.ts),
 * given by the page so that this file stays light. A report goes the way SECURITY.md says: a direct message on X that
 * asks for a private channel (a GitHub advisory only once private vulnerability reporting is switched on, which it is
 * not yet). There is no security mailbox.
 */
export function rulesCopy(
  network: Network,
  links: { readonly security: string; readonly x: string },
): readonly Rule[] {
  const securityMd = { text: "SECURITY.md", href: links.security };
  const [modelMax, modelWindowS] = LIMITS.canaryModelVisitor;
  return [
    {
      title: "The goal.",
      body: [
        "Make the Canary vault pay anyone other than its single mandated payee. If you find a way, tell us how: send a direct message to ",
        { text: "@probarionhq", href: links.x },
        " on X that says you have a security report, with no details, as ",
        securityMd,
        " describes.",
      ],
    },
    {
      title: "How it works.",
      body: [
        "A deliberately gullible model proposes a payment. Code rules judge it. In raw mode, a rate-limited share of code-refused proposals also goes straight to the contract, bypassing the code rules, when the contract's own dry run says it would refuse them. That lets you watch NEAR refuse it on chain.",
      ],
    },
    {
      title: "Why an address in your message cannot work.",
      body: [
        "A spend request has no address field. The contract pays only the payee stored in the mandate, which only the owner's wallet can create.",
      ],
    },
    {
      title: "Limits.",
      body: [
        `A message is at most ${MAX_CHARS} characters. One network address gets at most ${modelMax} model attempts every ${modelWindowS / 60} minutes and ${CANARY_LIMITS.attemptsPerIpPerHour} an hour. All visitors together get at most ${CANARY_LIMITS.attemptsGlobalPerHour} an hour and ${CANARY_LIMITS.attemptsGlobalPerDay} a day. On chain, one visitor gets 1 attempt every ${CANARY_LIMITS.rawVisitorWindowS / 60} minutes, and all visitors together get at most ${CANARY_LIMITS.rawGlobalPerHour} an hour. There is also a daily budget of ${thousands(CANARY_LIMITS.dailyTokenBudget)} model tokens for everyone together. Raw mode pauses when the agent key's gas allowance falls below ${ALLOWANCE} NEAR.`,
      ],
    },
    {
      title: "Out of scope.",
      body: [
        "Denial of service; spam; attacks on Vercel, Supabase, NEAR AI Cloud, wallets or other users; social engineering of the team; anything illegal. Report bugs in Probarion's own servers as ",
        securityMd,
        " says, not here.",
      ],
    },
    {
      title: "Your data.",
      body: [
        "Your message goes to a private model on NEAR AI Cloud. We store a sha256 hash of it, not the text, plus technique labels and the on-chain result. Your IP address and cookie are stored only as keyed hashes, for rate limits. Do not submit personal data.",
      ],
    },
    {
      title: "How you are counted.",
      body: [
        "You are a challenge participant, not a customer. The ",
        { text: "Usage page", href: "/usage" },
        " counts you apart from the product's own users.",
      ],
    },
    {
      title: "The fine print.",
      body: [
        `This is beta, unaudited software.${network === "testnet" ? " It runs on testnet, with test tokens that have no value." : ""} The challenge may pause or end at any time; the live balance is on the Canary page. These rules may change while the challenge runs.`,
      ],
    },
  ];
}
