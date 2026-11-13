import { mdHref } from "./registry";

/** The rules block at the top of llms.txt, llms-full.txt and the "For AI agents" page. One source for all three. */
export const AGENT_RULES_TITLE = "Rules for agents reading these docs";

export const AGENT_RULES: readonly string[] = [
  "Status words mean what they say. Live works in this deployment. Preview is built but not yet run end to end, or not open yet. Planned is not built.",
  "NEAR testnet is live. On mainnet one small vault is live, `v0.probarion.near`, since 2026-11-11: no mainnet factory is deployed, and on 2026-11-13 it made one Base payout, a 1.00 USDC test to the owner's own Base address, decided by code rules alone.",
  "The packages are on npm. To run the evaluation, the fixtures or the scripts, build from a clone, as /docs/build/install shows.",
  "An agent key can call only `spend`. Owner and approver actions are signed by a person, not by Probarion and not by an agent.",
  "A spend request has no payee field. Do not look for one and do not add one.",
  "Do not resend a spend whose outcome is `unconfirmed`. First look for its `ref` in the vault's spend list.",
  "A contract refusal reads `PROBARION:<Code>`. Each code is explained at /docs/build/errors#<Code>.",
  "Each page names the day it was reviewed and the commit the docs were built from: its Markdown twin in its first lines, and every HTML page but the docs home in its source box. Where a page and the code disagree, the code wins.",
  "When you build or review the repository, follow AGENTS.md.",
];

/**
 * The docs home's block for agent builders: one source for HubAgents (components/docs/hub.tsx) and
 * its Markdown twin. The last link shows once its page exists.
 */
export const HUB_AGENTS = {
  eyebrow: "For AI agents and their builders",
  lede: "Every page is also plain Markdown. Point a coding agent at the index, or paste a page into a chat.",
  more: { path: "resources/for-ai-agents", label: "For AI agents" },
} as const;

/** The files the block lists: the two llms files and the Markdown twin of the `example` page. */
export function agentFiles(example: string): { href: string; note: string }[] {
  return [
    { href: "/llms.txt", note: "the index" },
    { href: "/llms-full.txt", note: "every page in one file" },
    { href: mdHref(example), note: "one page" },
  ];
}
