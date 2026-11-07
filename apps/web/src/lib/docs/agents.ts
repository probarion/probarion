/** The rules block at the top of llms.txt, llms-full.txt and the "For AI agents" page. One source for all three. */
export const AGENT_RULES_TITLE = "Rules for agents reading these docs";

export const AGENT_RULES: readonly string[] = [
  "Status words mean what they say. Live works in this deployment. Preview is built but not yet run end to end, or not open yet. Planned is not built.",
  "Only NEAR testnet is live. The mainnet vault is planned.",
  "The packages are not on npm. Build the SDK and the CLI from source, as /docs/build/install shows.",
  "An agent key can call only `spend`. Owner and approver actions are signed by a person, not by Probarion and not by an agent.",
  "A spend request has no payee field. Do not look for one and do not add one.",
  "Do not resend a spend whose outcome is `unconfirmed`. First look for its `ref` in the vault's spend list.",
  "A contract refusal reads `PROBARION:<Code>`. Each code is explained at /docs/build/errors#<Code>.",
  "Each page names the commit it was built from and the day it was reviewed. Where a page and the code disagree, the code wins.",
  "When you build or review the repository, follow AGENTS.md.",
];
