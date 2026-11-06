import type { Network } from "@/lib/config";
import { cli } from "@/lib/proof/cli";

// The words of the operations pages (/status, /security, /terms, /privacy), in one module so that ops-copy.test.ts can
// hold them to the repository: no claim that has not shipped, no contact or host that does not exist yet, no reward.
// Backticks render as <code> through components/site/Rich.tsx.

export const STATUS_PAGE = {
  meta: {
    title: "Status",
    description:
      "Live checks of this address: the NEAR RPC providers it reads and NEAR AI Cloud's model list.",
  },
  eyebrow: "Status",
  title: "Status",
  lede: (network: Network) =>
    `This address serves NEAR ${network}. These checks ran when the page loaded and are at most 30 seconds old.`,
  rpcTitle: "NEAR RPC",
  nearaiTitle: "NEAR AI Cloud",
  up: "passing",
  down: "failing",
  settings:
    "The server's settings could not be read, so the NEAR RPC checks did not run. The console is unavailable until they are fixed.",
  noKey: "The model key is not set on this deployment, so decisions use the code rules only.",
  failed: "The checks could not run. Reload the page in a minute.",
  checkedAt: (iso: string) => `Checked at ${iso.slice(0, 19).replace("T", " ")} UTC.`,
  funds:
    "Funds stay in your own vault. If Probarion is down, your vault and its limits keep working on chain, and you can freeze it, withdraw and remove agent keys from your own wallet.",
  other: (network: Network) => `Status of the ${network} address`,
  whatWorks: "What works today, and what does not",
} as const;

export const LAST_UPDATED = "2026-11-07";

/** The lede of /terms and /privacy (spec §13, Legal row). */
export const LEGAL_STATUS =
  "Probarion is non-custodial software in beta. It is unaudited: use it at your own risk. This page is plain language, not legal advice; a lawyer will review it before general availability.";

export interface CopySection {
  id: string;
  title: string;
  paragraphs: readonly string[];
}

export interface TermsRule {
  title: string;
  body: string;
  link?: { text: string; href: string };
}

/** If Probarion itself is breached. The same rows, word for word, are in docs/THREAT_MODEL.md (ops-copy.test.ts). */
export const BLAST_RADIUS: readonly { can: string; cannot: string }[] = [
  { can: "Call `spend` with stolen agent keys", cannot: "Pay anyone not named in a mandate" },
  {
    can: "Submit fake invoice hashes against open mandates, or skip the owner's Confirm on a waiting invoice",
    cannot:
      "Exceed a mandate's per-payment cap, total cap, uses or expiry, or the vault's daily backstop; a spend above `approval_above` still waits for an approver",
  },
  {
    can: "Rewrite off-chain history",
    cannot: "Hide it: the anchored roots and `verify` expose the first altered entry",
  },
  {
    can: "Stop the service",
    cannot:
      "Touch the owner's funds: the owner can freeze, withdraw and revoke keys from their own wallet without Probarion",
  },
  {
    can: "Use the console's login keys or a hijacked owner or approver session",
    cannot:
      "Approve, withdraw, rotate keys, revoke mandates or unfreeze: each needs exactly 1 yoctoNEAR, which only a full-access key can attach, through a wallet prompt",
  },
];

export const SECURITY_PAGE = {
  meta: {
    title: "Security",
    description:
      "How to report a vulnerability in Probarion, what the contract enforces, and what a breach of Probarion could and could not do.",
  },
  eyebrow: "Security",
  title: "Security",
  lede: "Unaudited beta. No third party has audited this code. Probarion runs on NEAR testnet today, with test tokens; a mainnet vault is planned.",
  report: {
    title: "How to report a vulnerability",
    paragraphs: [
      "Send a direct message to @probarionhq on X that says you have a security report, with no details. We answer with a private channel for them.",
      "Once private vulnerability reporting is switched on for the repository, you can also use its private GitHub form.",
      "We aim to acknowledge a report within 72 hours. There is no bug bounty. Test only against vaults you deployed yourself, on testnet or in the sandbox, or against the Canary under its rules.",
    ],
    x: "@probarionhq on X",
  },
  enforces: {
    title: "What the contract enforces",
    items: [
      "The payee comes from the mandate the owner signed: `spend` takes no address.",
      "Every spend stays inside its mandate's per-payment limit, total, uses and expiry, and the vault's daily backstop.",
      "A spend above `approval_above` pays only after an approver approves it.",
      "Every owner and approver method except `freeze` needs an attached deposit (exactly 1 yoctoNEAR, or the storage cost for `create_mandate`), so a dapp login key cannot call them.",
      "Any owner key can freeze the vault, with no deposit, and stop every spend at once.",
    ],
  },
  breach: {
    title: "If Probarion itself is breached",
    lede: "An attacker with full control of Probarion's servers can do what the left column says, and still cannot do what the right column says.",
    can: "The attacker can",
    cannot: "but cannot",
  },
  limits: {
    title: "What a proof cannot show",
    items: [
      "That the TEE hardware is honest.",
      "That the POA bridge operator releases funds on Base.",
      "How the Intents Verifier DAO uses its roles.",
    ],
    more: "SECURITY.md lists everything that is not proven yet.",
  },
  relies: {
    title: "What we rely on",
    items: [
      "The NEAR protocol: a function-call key cannot attach a deposit, and a contract controls its own keys.",
      "NEAR AI Cloud's TEE for the privacy of invoice text. The model only proposes, so it cannot move money.",
      "NEAR Intents and the POA bridge for payouts to Base, on mainnet.",
      "Vercel and Supabase for the console being up and for the privacy of off-chain records, not for your funds.",
      "Your wallet, which shows what it signs, and your care of your full-access keys.",
    ],
  },
  verify: {
    title: "Check a vault yourself",
    text: `From a clone of the repository: \`${cli("verify --network testnet --vault <vault>")}\``,
  },
  links: {
    title: "More",
    policy: "Security policy (SECURITY.md)",
    threatModel: "Threat model",
    runbook: "Incident runbook",
    securityTxt: "security.txt",
    canaryRules: "Canary rules",
  },
} as const;

export const TERMS_PAGE = {
  meta: { title: "Terms", description: "The plain-language terms of the Probarion beta." },
  eyebrow: "Terms",
  title: "Terms of use",
  updated: `Last updated ${LAST_UPDATED}.`,
  rules: [
    {
      title: "What Probarion is.",
      body: "Software that lets an AI agent pay invoices in USDC inside mandates that the vault's owner signs. A NEAR contract checks every payment, and anyone can verify the signed ledger.",
    },
    {
      title: "It does not hold your funds.",
      body: "Your USDC stays in your own vault contract. Only your wallet can withdraw it, change its keys or unfreeze it. Probarion keeps no owner key.",
    },
    { title: "Unaudited beta.", body: "No third party has audited this code. Use small amounts." },
    {
      title: "Testnet today.",
      body: "The vault runs on NEAR testnet with test tokens. A mainnet vault is planned.",
    },
    {
      title: "At your own risk.",
      body: "The software is provided as is, without warranty of any kind, under the MIT license. You decide what your mandates allow, and you are responsible for the payments they permit.",
    },
    {
      title: "Liability.",
      body: "To the extent the law allows, we are not liable for losses from on-chain transactions that you or your agent made within the mandates you signed.",
    },
    {
      title: "You sign.",
      body: "Every transaction that creates, funds or configures a vault is signed by you, in your own wallet.",
    },
    {
      title: "Payments are final.",
      body: "A payment on chain cannot be reversed. Check every payee address before you sign a mandate.",
    },
    {
      title: "The agent key.",
      body: "The agent key Probarion keeps for your vault can call `spend` only, inside the mandates you signed. You can remove it, or freeze the vault, from your wallet at any time.",
    },
    {
      title: "Third-party services.",
      body: "NEAR, NEAR Intents and its bridges, NEAR AI Cloud, 1Click and your wallet are run by others. We do not control them or their fees.",
    },
    {
      title: "Lawful use.",
      body: "Use Probarion lawfully. Sanctions, tax and accounting rules where you operate are your responsibility. Do not use it to pay for anything illegal.",
    },
    {
      title: "Free during the beta.",
      body: "Using the console costs nothing. Your wallet pays the NEAR network's own fees.",
    },
    {
      title: "Fair use.",
      body: "Do not attack other people's vaults or overload the service. The Canary is the one vault open to attacks, under its own rules.",
      link: { text: "Canary rules", href: "/canary/rules" },
    },
    {
      title: "Not legal advice.",
      body: "This page is plain language, not legal advice. A lawyer reviews it before general availability. When these terms change, the date at the top changes with them, and the repository keeps every earlier version.",
    },
  ] satisfies readonly TermsRule[],
  contact: "Questions: a direct message to",
} as const;

export const PRIVACY_PAGE = {
  meta: {
    title: "Privacy",
    description: "What Probarion stores, where it goes, and how to stop it.",
  },
  eyebrow: "Privacy",
  title: "Privacy notice",
  updated: `Last updated ${LAST_UPDATED}.`,
  sections: [
    {
      id: "on-chain",
      title: "What is public on chain",
      paragraphs: [
        "Your vault, its mandates, its spends and its anchors are NEAR transactions. Anyone can read them, on testnet and on mainnet. They are public and permanent, and we cannot delete them.",
      ],
    },
    {
      id: "account",
      title: "Your account",
      paragraphs: [
        "You sign in by signing a message with your NEAR wallet. We keep your account name and a session cookie, `pb_session`, which lasts 12 hours and which page scripts cannot read.",
      ],
    },
    {
      id: "invoices",
      title: "Invoices",
      paragraphs: [
        "An invoice you upload is encrypted before it is stored. With zero-retention on, we keep only its hashes and the outcome, not the file or the text.",
        "When the payables agent runs, the invoice text goes to a private model on NEAR AI Cloud. A recorded, attested run is in progress.",
      ],
    },
    {
      id: "ledger",
      title: "The signed ledger",
      paragraphs: [
        "Each decision goes into a signed ledger for your vault. The model's answer, which may quote details of an invoice, is part of it. A vault's ledger is public only if you turn on its public proof page.",
      ],
    },
    {
      id: "alerts",
      title: "Alerts",
      paragraphs: [
        "If you add an alert, we store the email address or the Telegram chat it goes to, and send through Resend or Telegram. Remove on the vault's Alerts tab stops it.",
      ],
    },
    {
      id: "canary",
      title: "The Canary",
      paragraphs: [
        "A message you send to the Canary goes to a private model on NEAR AI Cloud. We store a sha256 hash of it, not the text, plus technique labels and the on-chain result. Your IP address and cookie are stored only as keyed hashes, for rate limits.",
      ],
    },
    {
      id: "operations",
      title: "Operations",
      paragraphs: [
        "Our servers log each request with a request id, its route and its outcome. Known secrets are masked before a line is written.",
        "Rate limits on sign-in, alert links and the proof pages and downloads count requests per IP address (an IPv6 address cut to its /64). That address is stored as it is, in a counter that is deleted within two days of your last request. The Canary keeps only keyed hashes.",
        "Error reports go to Sentry once it is enabled, without cookies, request headers, query strings or your account name.",
      ],
    },
    {
      id: "processors",
      title: "Who processes data",
      paragraphs: [
        "Vercel hosts the site. Supabase holds the database. NEAR AI Cloud runs the model. Telegram and Resend deliver alerts. Sentry receives error reports once it is enabled.",
        "On mainnet, a top-up sends NEAR Intents 1Click the amount and the asset, your account name (for a refund) and the vault's (to receive the funds). Chain reads go to NEAR RPC providers. Your browser loads the wallet connectors' code from GitHub.",
        "We use no analytics and no advertising trackers.",
      ],
    },
    {
      id: "choices",
      title: "Your choices",
      paragraphs: [
        "You can freeze your vault and withdraw its funds from your own wallet at any time, without Probarion.",
        "In the vault's Settings, zero-retention keeps only each invoice's hash and discards its content after the decision, and the public proof page stays off unless you turn it on.",
        "A member of a vault can download its signed ledger at `/proof/<vault>/ledger.jsonl`, whether or not its proof page is public.",
        "To ask what we hold about your account, or to have it removed, send a direct message to @probarionhq on X.",
      ],
    },
  ] satisfies readonly CopySection[],
} as const;
