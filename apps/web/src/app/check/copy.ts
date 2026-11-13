// The words of /check. Plain facts only: what the check reads, what it does with a read that fails, and what it is not.
import { NETWORKS, PAYEE_BLOCKLIST } from "@probarion/core";
import {
  PAYEE_ARCHIVAL_RPC_URLS,
  PAYEE_BASE_RPC_URLS,
  PAYEE_SIGNALS_BUDGET_MS,
} from "@probarion/sdk/payee";
import { REPO_URL } from "@/lib/proof/cli";

const host = (url: string) => new URL(url).host;
const hosts = (urls: readonly string[]) => urls.map(host).join(" and ");
/** The first host, and the ones the reads fall back to when it fails. */
const withFallback = (urls: readonly string[]) => {
  const [first, ...rest] = urls.map(host);
  return rest.length === 0 ? (first ?? "") : `${first} (falling back to ${rest.join(" and ")})`;
};
const testnetNames = PAYEE_BLOCKLIST.filter((e) => e.network === "testnet").length;
const mainnetNames = PAYEE_BLOCKLIST.filter((e) => e.network === "mainnet").length;

export const SOURCES = {
  rules: `${REPO_URL}/blob/main/packages/core/src/payee-check.ts`,
  reads: `${REPO_URL}/blob/main/packages/sdk/src/payee-signals.ts`,
  blocklist: `${REPO_URL}/blob/main/packages/core/src/payee-blocklist.json`,
  page: `${REPO_URL}/blob/main/apps/web/src/app/check/PayeeCheck.tsx`,
  report: `${REPO_URL}/issues/new?template=report-payee.yml`,
} as const;

export const CHECK_PAGE = {
  meta: {
    title: "Check a payee",
    description:
      "Allow, warn or block for a payee on NEAR or Base, with the reasons. A Solana payee is not read on its own chain. Your browser reads public nodes itself, before an owner signs a mandate.",
  },
  eyebrow: "Payee check",
  title: "Check a payee before you sign a mandate",
  // The agent's key can call one method, and `spend` has no address field. "Before": the console's mandate form does not
  // run this check, so the page does not say that signing does.
  lede: "The agent does not pick a payee, so the place to check one is where it is chosen: before the owner signs a mandate.",
  why: "The agent's key can call one method, spend, and spend has no address field. A payee enters through the mandate the owner signs.",
  how: "Name a payee, and this page answers allow, warn or block, with the reasons. Your browser reads public NEAR and Base nodes itself. No wallet, no sign-in, and the check calls no Probarion server route.",
  form: {
    title: "The payee",
    network: "Network",
    payee: "Payee",
    payeeHint:
      "near:<account>, base:<0x address> or solana:<address>. A bare NEAR account works too.",
    payeePlaceholder: "for example near:vendor.near",
    vault: "Vault (optional)",
    vaultHint:
      "With a vault, the check compares the payee with the vault's own payees (lookalikes) and its past payments. Without one, that is a warning.",
    vaultPlaceholder: "for example v0.probarion.near",
    button: "Check the payee",
    busy: "Reading the chain",
    busyLine: `Reading public nodes. This takes up to ${PAYEE_SIGNALS_BUDGET_MS / 1000} seconds.`,
    tryLabel: "Or try one. Each one reads live, so its answer is what the chain says now.",
  },
  result: {
    reasons: "Reasons",
    reads: "What we read, from where",
    readsLede:
      "Each read the verdict used, and the hosts this browser asked. A read that failed is unknown, and unknown warns.",
    noRequest: "no request sent",
    requests: (n: number) => `The ${n} ${n === 1 ? "request" : "requests"} this browser sent`,
    json: "The signals and the assessment as JSON",
    cli: "The same check in a terminal",
    cliNote:
      "In a clone of the repository, once the CLI is built. Release 0.1.1 on npm does not have this command.",
    readOnly: "Read-only: views and block headers, no transaction signed or sent.",
    advice:
      "The verdict is advice for the owner who writes this payee into a mandate. It changes nothing on chain.",
    failed: (message: string) =>
      `The check could not run: ${message}. This is not an allow: check the payee another way before you sign.`,
    link: "Link to this check",
  },
  about: {
    title: "What this check is, and is not",
    items: [
      `Read-only. Your browser reads from ${withFallback(NETWORKS.mainnet.rpcUrls)} on mainnet, ${withFallback(NETWORKS.testnet.rpcUrls)} on testnet, FastNEAR's archival nodes (${hosts([...PAYEE_ARCHIVAL_RPC_URLS.mainnet, ...PAYEE_ARCHIVAL_RPC_URLS.testnet])}) and, for a Base payee on mainnet, ${host(PAYEE_BASE_RPC_URLS.mainnet ?? "https://mainnet.base.org")}. It calls no Probarion server route, and this page saves nothing.`,
      "Advice for the owner. The contract does not read this check: it pays a mandate's own payee, and the owner can still sign a mandate for a payee this page blocks.",
      "A read that fails or times out is unknown, and an unknown is a warning. Without a vault, lookalikes and past payments are not checked, and that is a warning too. So the page does not answer allow on a read it could not make.",
      `The blocklist is a seed, not a reputation service: ${testnetNames} testnet ${testnetNames === 1 ? "name" : "names"} and ${mainnetNames} on mainnet, from Probarion's own eval cases and test fixtures. Probarion does not hold them, and none has a report of wrongdoing.`,
      "On Base the age signal is the nonce, which does not show an age. Base is read on mainnet and not on testnet (a testnet vault pays Base through a stub), and Solana payees are not read, so those signals are unknown.",
      "The code is unaudited. The rules and the reads are the same ones the CLI's payee check runs.",
    ],
    sources: "The code:",
    links: [
      { href: SOURCES.rules, label: "the rules (core)" },
      { href: SOURCES.reads, label: "the reads (SDK)" },
      { href: SOURCES.blocklist, label: "the seed blocklist" },
      { href: SOURCES.page, label: "this page" },
      { href: SOURCES.report, label: "report a payee" },
    ],
  },
} as const;
