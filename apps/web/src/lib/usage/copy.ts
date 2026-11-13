// Every word of the public Usage page's counts, in one module so that its test can hold the copy to the words the page
// must not use: no promise (a guarantee, "never"), no em dash in a sentence, none of the Canary challenge's words. The
// counting rules it states are the ones in the spec's honesty rules for metrics (§14.5), and migration 0009 is where each
// one is carried out. It reaches no server-only module. The words of the two cards read from the committed evidence (the
// mainnet record and what it costs) live in components/usage/MainnetSections.tsx, and MainnetSections.test.ts holds them.

import { thousands, utcMinute } from "@/lib/canary/format";
import type { Network } from "@/lib/config";
import type { SegmentCounts } from "./view";

/** The glyph of an empty cell. The one em dash on the page, as in the console's keys table; no sentence has one. */
export const EMPTY = "—";

export const eyebrow = (network: Network): string => `Usage · NEAR ${network}`;

export const USAGE_COPY = {
  meta: {
    title: "Usage",
    description:
      "Live usage counts, with team vaults, external owners and Canary participants kept apart.",
  },
  head: {
    title: "Usage, counted apart",
    lede: "Team vaults, external owners and Canary participants are counted separately. These are counts, not dollar volumes, so the team paying itself adds no volume to them. Every payment is on chain.",
    definitions: "Definitions",
    canary: "Canary",
    testnetPill: "Testnet: test tokens, no value",
  },
  tiles: {
    owners: { label: "External owners", sub: "distinct owner wallets" },
    participants: { label: "Canary participants: at least", sub: "not customers" },
    team: { label: "Team vaults", sub: "ours, counted apart" },
  },
  table: {
    title: "All time, with the last 7 days in grey",
    tableLabel: "Usage by segment",
    metric: "Metric",
    team: "Team",
    external: "External",
    canary: "Canary",
    /** Read out after a "+N" by a screen reader, which cannot see that the number is grey. */
    weekHint: " in the last 7 days",
  },
  costs: {
    title: "Unit costs",
    tableLabel: "Unit costs by segment",
    unit: "Unit cost",
    tokens: "NEAR AI tokens per decision",
    usd: "USD per decision",
    gas: "Gas per spend",
    hosting: "Hosting and RPC",
    usdUnset: "price not set yet",
    gasUnset: "not measured yet",
    hostingUnset: "not published yet",
    footnote:
      "A price is shown only once it is set from NEAR AI's own price list, with the date read. Nothing is estimated.",
  },
  pilots: {
    title: "Pilots, by cohort",
    named: "Named with written consent:",
  },
  definitions: {
    title: "How each number is counted",
  },
} as const;

/** Shown in place of the numbers when they cannot be read: the header and the definitions stay. */
export const UNAVAILABLE =
  "The usage numbers are not available right now. Every payment stays visible on chain.";

/** What a week adds to an all-time count: "+3". */
export const deltaText = (n: number): string => `+${thousands(n)}`;

const REFRESH =
  "Refreshed at most hourly while people view this page, and once a day on a schedule.";

/** "Updated 2026-11-06 10:15 UTC. ...", or that nothing has been computed yet. */
export const updatedLine = (updatedAt: string | null): string =>
  updatedAt === null
    ? `Updated: not computed yet. ${REFRESH}`
    : `Updated ${utcMinute(updatedAt)} UTC. ${REFRESH}`;

/** Tokens per decision as a whole number, or the empty glyph for a segment with no model decision. */
export const tokensCell = (tokens: number | null): string =>
  tokens === null ? EMPTY : thousands(Math.round(tokens));

export const priceLine = (price: { model: string; source: string }): string =>
  `Price: ${price.model}, ${price.source}`;

export const pilotsLine = (c: SegmentCounts): string =>
  `External ${thousands(c.external)} · Team ${thousands(c.team)} · Canary ${thousands(c.canary)}`;

/**
 * Which network the live counts are for. The other one is named by what it is, so that a testnet page's counts do not
 * talk of mainnet. The mainnet record above them is not a live count, and says itself that it is not added in.
 */
export const networkSentence = (network: Network): string =>
  `The live counts are for NEAR ${network} only${network === "testnet" ? ", with test tokens" : ""}. Activity on the other NEAR network is counted apart and is not added in.`;

/** One entry of "How each number is counted": a sentence, with the name of the figure first where it is about one row. */
export interface Definition {
  lead?: string;
  text: string;
}

export function definitions(network: Network): readonly Definition[] {
  return [
    {
      text: "Team vaults, external owners and Canary participants are counted apart. A vault is team when we run it, and external when its owner registered it themselves. Canary participants are people who tried the public Canary and are not on the team.",
    },
    {
      text: "Canary participants come only from Canary attempts by people who are not on the team. A team member's Canary attempts are counted under team. The Canary's own vault is left out of every figure taken from a ledger, so an attempt is not counted twice.",
    },
    {
      text: "In the Canary column, vaults, mandates, payments and held spends are the Canary vault's own on-chain events. Refusals, attempts and model decisions come from the attempts instead, because the Canary's ledger is private.",
    },
    {
      text: "These are counts, not dollar volumes. Amounts are not added up, so the team paying itself adds no volume to them.",
    },
    {
      lead: "External owners:",
      text: "the distinct owner wallets of external vaults on this network.",
    },
    {
      lead: "Canary participants:",
      text: "shown as at least that many people. It is the smaller of the distinct browsers and the distinct network addresses of people who are not on the team.",
    },
    { lead: "Vaults:", text: "a vault counts on the day it was registered." },
    {
      text: "Payments and mandates come from on-chain events our watcher records. Payments made includes the cross-chain payouts to Base, which are also shown on their own row.",
    },
    { lead: "Held for approval:", text: "a spend the contract held for a human approver." },
    {
      lead: "Refused by code:",
      text: "for a vault, a decision in its signed ledger with the verdict refuse. For the Canary, an attempt that the code rules refused.",
    },
    {
      lead: "Refused on chain:",
      text: "a spend the contract refused, with its transaction. A spend that a dry run stops before it is sent has no transaction and is not counted here.",
    },
    {
      lead: "Canary attempts:",
      text: "every attempt that was recorded. One that did not finish is counted as an attempt and nothing else, once 90 seconds have passed. Sent straight to the contract means a code-refused attempt that was also sent on chain, bypassing the code rules.",
    },
    {
      lead: "Model decisions:",
      text: "decisions where a model gave an answer. For a vault, a ledger decision that carries attestation evidence. For the Canary, an attempt with a model answer.",
    },
    {
      lead: "Tokens per decision:",
      text: "the tokens the model reported, divided by its decisions, for the same segment.",
    },
    { text: networkSentence(network) },
    {
      text: "Pilots are counted by cohort from our pilot list, and are not split by network. A pilot's name appears only with its written consent.",
    },
    {
      text: "Days are UTC. A day is computed while it runs and once more early the next day, and the totals add up the days computed so far.",
    },
  ];
}
