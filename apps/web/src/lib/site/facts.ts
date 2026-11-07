// Every word and fact of the public site, in one module so that test/site-facts.test.ts can hold each one to the file
// it comes from. Backticks in a string render as <code> (components/site/Rich.tsx). The transactions are the testnet
// smoke run of contracts/deployments/testnet.json: they stay testnet links whatever network the page is opened at.
import type { CheckId } from "@probarion/core";
import { explorerTxUrl } from "@/lib/config";
import { CLI_ON_NPM, cli, REPO_URL } from "@/lib/proof/cli";
import { FOOTER_NAV, isBuilt, type NavItem, SITE_NAV } from "@/lib/routes";
import type { TamperResult } from "./tamper";

const blob = (path: string) => `${REPO_URL}/blob/main/${path}`;

export const FIXTURE_PATH = "packages/core/test/fixtures/valid-snapshot.json";

export const LINKS = {
  github: REPO_URL,
  evaluate: `${REPO_URL}#how-to-evaluate-probarion-in-5-minutes`,
  spec: blob("docs/specs/2026-10-21-probarion-design.md"),
  interfaces: blob("docs/specs/2026-10-21-probarion-interfaces.md"),
  security: blob("SECURITY.md"),
  threatModel: blob("docs/THREAT_MODEL.md"),
  runbook: blob("docs/RUNBOOK.md"),
  changelog: blob("CHANGELOG.md"),
  fixture: blob(FIXTURE_PATH),
  x: "https://x.com/probarionhq",
} as const;

// --- metadata -------------------------------------------------------------------------------------

export const SITE_TITLE = "Probarion. Spend by mandate. Prove every payment.";
export const SITE_DESCRIPTION =
  "A mandate layer for AI agents on NEAR. The agent pays only inside mandates its owner signed, a NEAR contract checks every payment, and anyone can verify the signed ledger.";
export const OG_IMAGE = {
  url: "/og.png",
  width: 1280,
  height: 640,
  alt: "Probarion. Spend by mandate. Prove every payment. Mandates for AI agents on NEAR.",
} as const;

/** What the sitemap lists: the landing page, /proof and any public page as it gets built. The console is private. */
export function publicRoutes(): string[] {
  const nav = [...SITE_NAV, ...FOOTER_NAV].map(({ route }) => route);
  return [...new Set(["/", "/proof", ...nav])].filter(
    (r) => isBuilt(r) && !r.startsWith("/console"),
  );
}

// --- chrome ---------------------------------------------------------------------------------------

export { betaStrip } from "./beta";

/** The landing sections. A full path, so that each one works from every page. */
export const HEADER_ANCHORS: readonly { href: string; label: string }[] = [
  { href: "/#payment", label: "How a payment works" },
  { href: "/#verify", label: "Verify" },
  { href: "/#chain", label: "On chain" },
];

export const PROOF_ROUTE = "/proof";
export const CONSOLE_ROUTE = "/console";

/**
 * Planned pages the footer leaves out until they exist, because it already covers them some other way (for
 * /security, the developers list links SECURITY.md). Once built, each one joins its list by itself.
 */
const COVERED_WHILE_PLANNED: readonly string[] = ["/security"];
const listed = (items: readonly NavItem[]) =>
  items.filter(({ route }) => isBuilt(route) || !COVERED_WHILE_PLANNED.includes(route));

export const FOOTER = {
  motto: "TEE protects the data. The contract protects the money.",
  note: "Unaudited beta. Use small amounts. Built for the NEAR Hackathon 2026. MIT license.",
  /** Internal links: SITE_NAV and FOOTER_NAV stay the source of the routes. */
  product: listed(SITE_NAV),
  legal: listed(FOOTER_NAV).filter(({ route }) => !SITE_NAV.some((i) => i.route === route)),
  developers: [
    { href: LINKS.github, label: "GitHub" },
    { href: LINKS.interfaces, label: "Interfaces" },
    { href: LINKS.security, label: "SECURITY.md" },
    { href: LINKS.changelog, label: "Changelog" },
  ],
  follow: [{ href: LINKS.x, label: "@probarionhq on X" }],
} as const;

// --- the smoke run --------------------------------------------------------------------------------

export interface TxFact {
  hash: string;
  label: string;
  url: string;
}
const tx = (hash: string, label: string): TxFact => ({
  hash,
  label,
  url: explorerTxUrl("testnet", hash),
});

export const TX = {
  nearPayment: tx("3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX", "3DFV2thB…Fy9cX"),
  baseBurn: tx("3u4ffrwpiwLoNV6cU72NHLVBAMq729NwLs6ixDLdcvYe", "3u4ffrwp…dcvYe"),
  noMandate: tx("AkjyVPmb6LdMES7ykpzJQR7EXXGvw3kYH6Nhem9YdzgY", "AkjyVPmb…dzgY"),
} as const;

// --- hero -----------------------------------------------------------------------------------------

export const HERO = {
  line1: "Spend by mandate.",
  line2: "Prove every payment.",
  lede: "A mandate layer for AI agents on NEAR. Your agent pays people and services only inside limits you signed. A contract checks every payment, and every decision goes into a signed ledger anyone can verify.",
  openConsole: "Open console",
  breakTheLedger: "Try to break the ledger",
  fineprint:
    "Testnet today, mainnet planned. You need no account to read the chain or run the verifier.",
  paid: {
    aria: "A payment the contract allowed",
    mandate: "Mandate 1",
    state: "Paid",
    big: "1 test USDC",
    caller: "Agent key",
    payee: "probarion-payee.testnet",
    event: "spend_paid",
    tx: TX.nearPayment,
  },
  refused: {
    aria: "A payment the contract refused",
    mandate: "Mandate 999",
    state: "Refused",
    code: ["PROBARION:", "NoMandate"],
    caller: "Agent key",
    payee: "None on record",
    paid: "Nothing",
    tx: TX.noMandate,
  },
  note: "Two real calls by one agent key on `v0.probarion.testnet`, with test tokens. The contract decided both.",
} as const;

export const THESIS = {
  lead: "Giving an AI agent a wallet means trusting a prompt with money.",
  rule: "Probarion moves the rule into a NEAR contract.",
} as const;

export const NUMBERS = [
  { value: "0", name: "full-access keys", rest: " on the vault. A public RPC call shows it." },
  { value: "1", name: "method", rest: " the agent's key can call: `spend`." },
  {
    value: "0",
    name: "recipient arguments",
    rest: " on `spend`. The payee comes from the mandate.",
  },
  {
    value: "9",
    name: "checks",
    rest: " anyone can run. Live, they read the chain. Offline, they check a snapshot against itself, so take the snapshot yourself.",
  },
] as const;

// --- what happens to one payment ------------------------------------------------------------------

/** One line of a step's panel: a quiet note, a command to copy, a key and its value, or a plain line. A tone is said in words too. */
export type PanelLine =
  | { note: string }
  | { command: string }
  | { key: string; value: string; tone?: "pass" | "fail" }
  | { text: string; tone?: "pass" };

export interface JourneyStep {
  n: number;
  title: string;
  body: string;
  /** An unfinished part of this step, marked as unfinished. */
  tag?: string;
  panelLabel: string;
  panel: readonly PanelLine[];
}

/** Rule ids of `decide()`; the test checks each one against packages/core/src/policy.ts. */
export const RULES_SHOWN = [
  "mandate.none",
  "mandate.payee_mismatch",
  "mandate.over_total",
  "invoice.duplicate",
  "vault.daily_backstop",
] as const;

export const VERIFIER_OUTPUT = {
  summary: "9 passed, 0 failed, 0 unproven",
  result: "RESULT: PASS",
} as const;

export const CONTRACT_REFUSAL_CODE = "OverPerPayment";

export const JOURNEY = {
  title: "What happens to one payment",
  intro:
    "Three parties look at it in turn. The model may advise. Code decides. The contract has the last word.",
  steps: [
    {
      n: 1,
      title: "The owner signs a mandate",
      body: "From their own wallet: who gets paid, how much per payment and in total, how many times, until when, and above what amount a person must approve.",
      panelLabel: "Mandate fields",
      panel: [
        { note: "An example mandate" },
        { key: "payee", value: "probarion-payee.testnet" },
        { key: "max_per_payment", value: "5 USDC" },
        { key: "max_total", value: "20 USDC" },
        { key: "max_uses", value: "5" },
        { key: "approval_above", value: "5 USDC" },
      ],
    },
    {
      n: 2,
      title: "A private model proposes, if there is one",
      body: "It runs in a TEE on NEAR AI Cloud. Its attestation is bound by a nonce to one position in one vault's ledger. It only gives advice: it cannot widen a mandate.",
      tag: "Adapter built. First live attested run in progress.",
      panelLabel: "What the proposal is bound to",
      panel: [
        { note: "What the proposal is bound to" },
        { key: "action", value: "pay" },
        { key: "mandate_id", value: "1" },
        { key: "nonce", value: "next ledger position + vault" },
        { key: "signature", value: "provider_tee" },
      ],
    },
    {
      n: 3,
      title: "Code decides, and signs before anything moves",
      body: "Deterministic rules run first and cannot be removed. The SDK signs the decision into the ledger before anything is sent, and it records refusals too.",
      tag: "The testnet smoke run sent spends without a ledger.",
      panelLabel: "Built-in rules",
      panel: [
        { note: "decide(), built-in rules include" },
        ...RULES_SHOWN.map((text) => ({ text })),
      ],
    },
    {
      n: 4,
      title: "The contract decides last",
      body: "Even if every line of off-chain code were wrong, the vault refuses a payment outside its mandate. Above the approval limit, the spend waits for a person.",
      panelLabel: "check_spend results on the testnet vault",
      panel: [
        { note: "check_spend on mandate 1, at most 5 USDC, valid until 2026-12-01" },
        { key: "2 USDC", value: "ok: true", tone: "pass" },
        { key: "6 USDC", value: `ok: false, ${CONTRACT_REFUSAL_CODE}`, tone: "fail" },
      ],
    },
    {
      n: 5,
      title: "Anyone can check the record",
      body: "The SDK anchors the ledger root on the vault. The verifier ties each spend in a snapshot to exactly one decision, with no server and no account. Offline, those spends come from the file. A live run reads them from the chain.",
      tag: `The testnet vault has no ledger key or anchors yet, so this command runs on a test fixture.${
        CLI_ON_NPM ? "" : " Build it from a clone first (README step 1)."
      }`,
      panelLabel: "Verifier output",
      panel: [
        { command: cli(`verify --offline ${FIXTURE_PATH}`) },
        { text: VERIFIER_OUTPUT.summary },
        { text: VERIFIER_OUTPUT.result, tone: "pass" },
      ],
    },
  ] satisfies readonly JourneyStep[],
} as const;

// --- the ink band ---------------------------------------------------------------------------------

/** `interface SpendRequest` in packages/core/src/types.ts; the test reads it from the source. */
export const SPEND_REQUEST_FIELDS = [
  "mandate_id",
  "amount",
  "invoice_hash",
  "ref",
  "decision_hash",
] as const;

export const BAND = {
  title: "The agent cannot name a payee.",
  body: "A hijacked prompt can ask for anything. `spend` has no field to put an address in. For a cross-chain payee, the vault builds the withdrawal memo itself, from the mandate.",
  structName: "SpendRequest",
  gone: "recipient",
  goneNote: "does not exist",
} as const;

// --- the ledger test ------------------------------------------------------------------------------

/** The verifier's nine checks in plain English. The test holds the keys to the ids `runChecks` returns. */
export const CHECK_LABELS: Readonly<Record<CheckId, string>> = {
  a: "Signatures",
  b: "Hash links",
  c: "Anchors",
  d: "A decision for every spend",
  e: "Attestations",
  f: "Locked vault",
  g: "Intents keys",
  h: "Burn memos",
  i: "Factory version",
};

const CHECK_IDS = Object.keys(CHECK_LABELS) as CheckId[];

export const CHECK_LIST: readonly { id: CheckId; label: string }[] = CHECK_IDS.map((id) => ({
  id,
  label: CHECK_LABELS[id],
}));

/**
 * What the page shows before anyone clicks, with no JavaScript too. The test runs the real verifier against it. The
 * details stay empty: what a passing check shows beside its word comes from `checkView`, at rest as on a live run.
 */
export const RECORDED_RESULT: TamperResult = {
  ok: true,
  firstBroken: null,
  passed: CHECK_IDS.length,
  failed: 0,
  unproven: 0,
  checks: CHECK_IDS.map((id) => ({ id, status: "pass", detail: "" })),
};

export const TAMPER_COPY = {
  title: "Change one field. Watch it break.",
  intro:
    "This is the real verifier from `@probarion/core`. It runs in your browser on a committed test fixture: five entries signed with test keys, not a live vault. It shows one thing: the verifier catches an edit that was not re-signed. Nothing leaves the page.",
  sheetTitle: "Signed ledger, test fixture",
  atRest: "As recorded",
  notRun: "Not run. The verifier did not finish",
  caption: "The five entries of the signed test ledger",
  recorded: "Recorded result. Press a button to run the verifier yourself.",
  live: "Run in your browser just now.",
  restore: "Restore",
  running: "Running…",
  firstBroken: "First broken entry:",
  loadFailed:
    "The verifier did not load, so nothing ran and the result here did not change. Check your connection and press the button again.",
  runFailed:
    "The verifier stopped with an error before it gave a result, so the result here did not change.",
  noScript:
    "The buttons need JavaScript. The result here is the recorded run of the same verifier.",
} as const;

// --- on chain -------------------------------------------------------------------------------------

export const CHAIN = {
  title: "Read it on chain",
  intro:
    "A smoke run of the contract alone on NEAR testnet, on 2026-11-01. Test tokens, no model and no ledger in this run.",
  rows: [
    {
      title: "Paid a NEAR account",
      body: "1 test USDC to `probarion-payee.testnet`. Events `spend_submitted`, `ft_transfer`, `spend_paid`.",
      tx: TX.nearPayment,
    },
    {
      title: "Burned for a Base address",
      body: "1 test USDC with the memo `WITHDRAW_TO:0x1111…1111` the vault built from the mandate. On testnet nothing leaves NEAR.",
      tx: TX.baseBurn,
    },
    {
      title: "Refused a mandate that does not exist",
      body: "The contract answered `PROBARION:NoMandate`. Nothing was paid.",
      tx: TX.noMandate,
    },
  ],
} as const;

// --- status ---------------------------------------------------------------------------------------

export type StatusTone = "live" | "work" | "plan";

export const STATUS = {
  title: "What works today, and what does not",
  rows: [
    { id: "vault-contract", row: "Vault contract", pill: "On testnet", tone: "live" },
    {
      id: "offline-verifier",
      row: "Offline verifier, checks a to i",
      pill: "Shipped in source",
      tone: "live",
    },
    { id: "reproducible-builds", row: "Reproducible builds", pill: "Shipped", tone: "live" },
    { id: "vault-factory", row: "Vault factory", pill: "On testnet", tone: "live" },
    { id: "web-console", row: "Web console", pill: "In progress", tone: "work" },
    {
      id: "public-proof-page",
      row: "Public proof page",
      pill: "Built, no public vault yet",
      tone: "work",
    },
    {
      id: "sdk-and-cli",
      row: "TypeScript SDK and CLI",
      pill: "In source, not on npm",
      tone: "work",
    },
    { id: "payables-agent", row: "Payables agent", pill: "In progress", tone: "work" },
    { id: "attested-model-run", row: "Live attested model run", pill: "In progress", tone: "work" },
    {
      id: "canary",
      row: "Canary public challenge",
      pill: "Page built, not open yet",
      tone: "work",
    },
    { id: "mcp-server", row: "MCP server", pill: "Planned", tone: "plan" },
    { id: "mainnet-vault", row: "Mainnet vault", pill: "Planned", tone: "plan" },
  ] as const satisfies readonly { id: string; row: string; pill: string; tone: StatusTone }[],
  noteBefore: "No third party has audited this code. Read the ",
  noteLink: "threat model",
  noteAfter: ", including what `verify` does not prove yet.",
  build:
    "`v0.probarion.testnet` runs a build older than the current source; the vaults the testnet factory creates run the fixed build recorded in `contracts/code-hashes.json`.",
} as const;

// --- closing --------------------------------------------------------------------------------------

export const CLOSING = {
  line1: "Don't trust us.",
  line2: "Run the verifier.",
  live: "A live run reads the chain itself: `verify --vault`. On the testnet vault it fails checks d and h today, because the smoke run sent its spends without a ledger.",
  evaluate: "Evaluate in 5 minutes",
  spec: "Read the spec",
} as const;

// --- /proof with no vault -------------------------------------------------------------------------

export const PROOF_INDEX = {
  eyebrow: "Public proof",
  title: "Check a vault yourself",
  intro:
    "A proof page shows a vault's checks a to i with explorer links, plus a ledger and a snapshot file you can download. Offline, the verifier checks that file against itself. The page also gives the command that reads the chain again.",
  noneListed: "No public vault is listed here yet.",
  label: "NEAR account of the vault",
  placeholder: "name.testnet",
  submit: "Open its proof page",
  publicOnly:
    "A vault's owner must make its proof page public first. If the owner has not, that address answers page not found.",
  invalid:
    "That is not a NEAR account. Use lowercase letters, digits and the separators . - _ in 2 to 64 characters.",
  tamperTitle: "Try the verifier here",
} as const;
