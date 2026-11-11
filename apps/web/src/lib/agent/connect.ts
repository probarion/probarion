import { parsePublicKey, USDC_DECIMALS } from "@probarion/core";
import type { Network } from "@/lib/config";
import { cleanLabel } from "@/lib/keys/rules";
import { formatUnits } from "@/lib/near/units";
import { REPO_URL } from "@/lib/proof/cli";

// The rules of the console's "Agent (MCP)" tab, as pure functions shared by the browser and the server actions: what a
// pasted key is, whether each key may go on the vault, and the lines the page shows. Nothing here reads the chain or
// the database, and nothing here ever holds a secret: a pasted secret is recognised and refused, and the error says so
// without repeating any of it.

/**
 * True once `@probarion/mcp` is on npm (the 0.1.1 release). While false, the page shows the server built from a clone
 * of the public repository, as CLI_ON_NPM does for the CLI (lib/proof/cli.ts). Flipping it is the whole change here.
 */
export const MCP_ON_NPM: boolean = false;

export const MCP_VERSION = "0.1.1";
/** The npx form of the server, pinned to the release. */
export const MCP_NPX = `npx -y @probarion/mcp@${MCP_VERSION}`;
/** The built server's bin in a clone (`packages/mcp/package.json` "bin"), run from the repository folder. */
export const MCP_FROM_CLONE = "node packages/mcp/dist/bin.js";
/** What a client config points at while the server runs from a clone: the user puts their clone's path in. */
export const CLONE_PATH_PLACEHOLDER = "/path/to/probarion";
const CLONE_BIN = `${CLONE_PATH_PLACEHOLDER}/packages/mcp/dist/bin.js`;

/** The contract's MAX_AGENTS (contracts/vault/src/lib.rs): add_agent refuses a 17th key. */
export const MAX_AGENTS = 16;

export const KEY_ERRORS = {
  empty: "Paste the public key init printed.",
  notPublic:
    "This is not a public key: it must start with ed25519: and be 32 bytes. Paste the line init printed.",
  secret:
    "This is a SECRET key (64 bytes). It was not sent anywhere: clear it, and paste the public key instead.",
  same: "The two keys are the same. Run init again: it makes two different keys.",
  onVault: "This key is already on the vault as an agent key.",
  agentIsLedger:
    "This key is the vault's ledger key. The agent key must be another key: paste the agent public key init printed.",
  ledgerIsAgent:
    "This key is on the vault as an agent key. The ledger key must be another key: paste the ledger public key init printed.",
  full: `The vault already holds ${MAX_AGENTS} agent keys, the most it can. Remove one on the Keys tab first.`,
  hosted:
    "Probarion made this key for hosted Payables, so its secret is on Probarion's server, not on your machine. Paste the key init printed.",
} as const;

/** A base58 run this long is no public key (at most 44 characters): 64 bytes, a secret key, take 86 to 88. */
const LONG_BASE58 = /[1-9A-HJ-NP-Za-km-z]{80,}/;

/**
 * True when `raw` holds what looks like a secret key: a base58 run of 80 characters or more (a NEAR secret key is 64
 * bytes, about 88 characters), with or without `ed25519:` and wherever it sits, so a pasted keys file is caught too.
 * The browser runs this before anything is sent, so a pasted secret never leaves the page.
 */
export function looksLikeSecret(raw: string): boolean {
  return LONG_BASE58.test(raw);
}

export type PastedKey =
  | { ok: true; key: string }
  | { ok: false; error: string; secret: boolean; empty: boolean };

/**
 * A pasted public key: `ed25519:` and 32 bytes of base58 (`parsePublicKey`, packages/core). Spaces around it are
 * dropped. A secret key is refused as one, and no error ever repeats what was pasted.
 */
export function parsePastedKey(raw: unknown): PastedKey {
  if (typeof raw !== "string") {
    return { ok: false, error: KEY_ERRORS.notPublic, secret: false, empty: false };
  }
  const text = raw.trim();
  if (text === "") return { ok: false, error: KEY_ERRORS.empty, secret: false, empty: true };
  if (looksLikeSecret(text))
    return { ok: false, error: KEY_ERRORS.secret, secret: true, empty: false };
  try {
    parsePublicKey(text);
  } catch {
    return { ok: false, error: KEY_ERRORS.notPublic, secret: false, empty: false };
  }
  return { ok: true, key: text };
}

/** The agent key's label on the vault: the same rules as the Keys tab (`cleanLabel`), "mcp" when left blank. */
export function cleanAgentLabel(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, value: "mcp" };
  return cleanLabel(raw, "agent");
}

/** `ed25519:7Qk3Lm...TzX9Tz`: the prefix, six characters, and the last six. */
export function shortKey(publicKey: string): string {
  return publicKey.length > 30 ? `${publicKey.slice(0, 14)}...${publicKey.slice(-6)}` : publicKey;
}

/** `list_agents` as the contract returns it, or null when it is anything else. Labels are kept as text. */
export function agentList(value: unknown): { public_key: string; label: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { public_key: string; label: string }[] = [];
  for (const a of value) {
    if (typeof a !== "object" || a === null) return null;
    const { public_key, label } = a as Record<string, unknown>;
    if (typeof public_key !== "string" || public_key === "") return null;
    out.push({ public_key, label: typeof label === "string" ? label : "" });
  }
  return out;
}

/**
 * What the vault and the console know about the vault's keys, as the page and the actions read it: the chain's
 * `list_agents`, `get_config().ledger_key` and `list_anchors(0, 1)`, and the tenant's key rows (every key Probarion
 * made for it, whatever its status) and hosted ledger.
 */
export interface VaultKeyFacts {
  agents: { public_key: string; label: string }[];
  ledgerKey: string | null;
  /** The key that signed the vault's first anchor, or null when the vault has none. */
  firstAnchorSigner: string | null;
  /** Every public key in the tenant's key rows: keys Probarion made, whose secrets are on its server. */
  hostedKeys: string[];
  /** The tenant has an active hosted ledger key: Payables anchors this vault. */
  hostedLedgerActive: boolean;
  /** Entries in the tenant's hosted ledger (Payables). */
  hostedLedgerEntries: number;
}

export type AgentBlock = "hosted" | "is_ledger_key" | "full";
export type AgentEligibility =
  | { kind: "add" }
  | { kind: "on_vault"; label: string }
  | { kind: "blocked"; reason: AgentBlock; error: string };

/**
 * Whether the pasted agent key can go on the vault. A key Probarion made is refused (its secret is not on the user's
 * machine), and so is the vault's ledger key (the contract refuses a key that is both). A key already listed is done.
 * The vault holds at most 16.
 */
export function agentEligibility(facts: VaultKeyFacts, agentKey: string): AgentEligibility {
  if (facts.hostedKeys.includes(agentKey)) {
    return { kind: "blocked", reason: "hosted", error: KEY_ERRORS.hosted };
  }
  if (facts.ledgerKey === agentKey) {
    return { kind: "blocked", reason: "is_ledger_key", error: KEY_ERRORS.agentIsLedger };
  }
  const listed = facts.agents.find((a) => a.public_key === agentKey);
  if (listed) return { kind: "on_vault", label: listed.label };
  if (facts.agents.length >= MAX_AGENTS) {
    return { kind: "blocked", reason: "full", error: KEY_ERRORS.full };
  }
  return { kind: "add" };
}

/** Why the vault's ledger cannot become this agent's: it already has one that another writer keeps. */
export type LedgerBlock = "hosted_entries" | "hosted_active" | "hosted_key" | "anchors";
export type LedgerEligibility =
  | { kind: "set" }
  | { kind: "same" }
  | { kind: "replace"; current: string }
  | { kind: "blocked"; reason: LedgerBlock }
  | { kind: "error"; error: string };

/**
 * Whether the pasted ledger key can become the vault's. A vault has one ledger: one ledger key, one chain of entries,
 * anchored in order. So the key is withheld from a vault whose ledger another writer already keeps: hosted Payables
 * (its active ledger key, its entries, or a ledger key it made that the vault already names), or anchors signed by
 * another key. Otherwise it is set (no ledger key yet), already this key, or replaces a key that never anchored.
 */
export function ledgerEligibility(facts: VaultKeyFacts, ledgerKey: string): LedgerEligibility {
  if (facts.hostedKeys.includes(ledgerKey)) return { kind: "error", error: KEY_ERRORS.hosted };
  if (facts.agents.some((a) => a.public_key === ledgerKey)) {
    return { kind: "error", error: KEY_ERRORS.ledgerIsAgent };
  }
  if (facts.hostedLedgerEntries > 0) return { kind: "blocked", reason: "hosted_entries" };
  if (facts.hostedLedgerActive) return { kind: "blocked", reason: "hosted_active" };
  if (facts.ledgerKey !== null && facts.hostedKeys.includes(facts.ledgerKey)) {
    return { kind: "blocked", reason: "hosted_key" };
  }
  if (facts.firstAnchorSigner !== null) {
    return facts.ledgerKey === ledgerKey && facts.firstAnchorSigner === ledgerKey
      ? { kind: "same" }
      : { kind: "blocked", reason: "anchors" };
  }
  if (facts.ledgerKey === ledgerKey) return { kind: "same" };
  if (facts.ledgerKey === null) return { kind: "set" };
  return { kind: "replace", current: facts.ledgerKey };
}

export function eligibility(
  facts: VaultKeyFacts,
  agentKey: string,
  ledgerKey: string,
): { agent: AgentEligibility; ledger: LedgerEligibility } {
  return { agent: agentEligibility(facts, agentKey), ledger: ledgerEligibility(facts, ledgerKey) };
}

/** What "Check these keys" found: each field's error, or both keys checked against the vault. */
export type PairCheck =
  | {
      ok: true;
      agentKey: string;
      ledgerKey: string;
      label: string;
      agent: AgentEligibility;
      ledger: LedgerEligibility;
    }
  | {
      ok: false;
      agentError: string | null;
      ledgerError: string | null;
      labelError: string | null;
      /** A secret was pasted: the page must send nothing. */
      secret: boolean;
    };

/** The browser's check of the form, before anything is sent: both keys, the pair, the label, then the vault. */
export function checkPastedPair(
  facts: VaultKeyFacts,
  form: { agent: unknown; ledger: unknown; label: unknown },
): PairCheck {
  const agent = parsePastedKey(form.agent);
  const ledger = parsePastedKey(form.ledger);
  const label = cleanAgentLabel(form.label);
  let agentError = agent.ok ? null : agent.error;
  let ledgerError = ledger.ok ? null : ledger.error;
  if (agent.ok && ledger.ok && agent.key === ledger.key) ledgerError = KEY_ERRORS.same;
  let a: AgentEligibility | null = null;
  let l: LedgerEligibility | null = null;
  if (agent.ok && ledgerError !== KEY_ERRORS.same) {
    a = agentEligibility(facts, agent.key);
    if (a.kind === "blocked") agentError = a.error;
  }
  if (ledger.ok && ledgerError === null) {
    l = ledgerEligibility(facts, ledger.key);
    if (l.kind === "error") ledgerError = l.error;
  }
  const labelError = label.ok ? null : label.error;
  if (
    !agent.ok ||
    !ledger.ok ||
    !label.ok ||
    agentError !== null ||
    ledgerError !== null ||
    a === null ||
    l === null
  ) {
    return {
      ok: false,
      agentError,
      ledgerError,
      labelError,
      secret: (!agent.ok && agent.secret) || (!ledger.ok && ledger.secret),
    };
  }
  return {
    ok: true,
    agentKey: agent.key,
    ledgerKey: ledger.key,
    label: label.value,
    agent: a,
    ledger: l,
  };
}

// --- the lines the page shows ------------------------------------------------------------------------------------

/** Step 1: make the keys. One command per line, so that every shell runs them (PowerShell 5.1 has no `&&`). */
export function initLines(vault: string, onNpm: boolean = MCP_ON_NPM): string[] {
  if (onNpm) return [`${MCP_NPX} init --vault ${vault}`];
  return [
    `git clone ${REPO_URL}`,
    "cd probarion",
    "pnpm install --frozen-lockfile",
    'pnpm --filter "@probarion/mcp..." run build',
    `${MCP_FROM_CLONE} init --vault ${vault}`,
  ];
}

/** The server command as a terminal runs it: the npx form, or the built bin from the clone's folder. */
export function serverCommand(onNpm: boolean = MCP_ON_NPM): string {
  return onNpm ? MCP_NPX : MCP_FROM_CLONE;
}

/**
 * Step 6: `status` reads the same settings as the server, so the vault goes in its environment. One line for a POSIX
 * shell, and the PowerShell form, which has no `VAR=value` prefix.
 */
export function statusCommand(
  vault: string,
  onNpm: boolean = MCP_ON_NPM,
): { posix: string; powershell: string } {
  const run = `${serverCommand(onNpm)} status`;
  return {
    posix: `PROBARION_VAULT_ID=${vault} ${run}`,
    powershell: `$env:PROBARION_VAULT_ID = "${vault}"; ${run}`,
  };
}

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "codex";

/**
 * One MCP client's settings. `where` and `windows` are sentences in which a `backticked` part is code (a file name, a
 * setting); `code` and `windowsCode` are the lines to copy.
 */
export interface ClientConfig {
  id: ClientId;
  label: string;
  /** Where the lines go, said before them (null: a terminal command). */
  where: string | null;
  /** The lines to copy. They name the vault only: no key, no secret. */
  code: string;
  /** The Windows form, said after them (null: the same lines work on Windows). */
  windows: string | null;
  /** A Windows line to copy, when it differs from `code` as a whole. */
  windowsCode: string | null;
}

/** The network from the vault's own name (`.near` or `.testnet`), as the server reads it; null for any other name. */
function suffixNetwork(vault: string): Network | null {
  if (vault.endsWith(".near")) return "mainnet";
  if (vault.endsWith(".testnet")) return "testnet";
  return null;
}

const q = (s: string) => JSON.stringify(s);

/**
 * The server's settings in each MCP client: only `PROBARION_VAULT_ID`, as the server reads its two keys from the keys
 * file init wrote on that machine. A vault whose name ends in neither `.near` nor `.testnet` also gets `NEAR_NETWORK`,
 * the server's one other way to tell its network. The forms follow packages/mcp/README.md.
 */
export function clientConfigs(
  vault: string,
  network: Network,
  onNpm: boolean = MCP_ON_NPM,
): ClientConfig[] {
  const env: [string, string][] = [["PROBARION_VAULT_ID", vault]];
  if (suffixNetwork(vault) === null) env.push(["NEAR_NETWORK", network]);
  const command = onNpm ? "npx" : "node";
  const args = onNpm ? ["-y", `@probarion/mcp@${MCP_VERSION}`] : [CLONE_BIN];
  const winArgs = ["/c", "npx", "-y", `@probarion/mcp@${MCP_VERSION}`];
  const list = (a: string[]) => `[${a.map(q).join(", ")}]`;

  const json = [
    "{",
    '  "mcpServers": {',
    '    "probarion": {',
    `      "command": ${q(command)},`,
    `      "args": ${list(args)},`,
    `      "env": { ${env.map(([k, v]) => `${q(k)}: ${q(v)}`).join(", ")} }`,
    "    }",
    "  }",
    "}",
  ].join("\n");
  const toml = [
    "[mcp_servers.probarion]",
    `command = ${q(command)}`,
    `args = ${list(args)}`,
    `env = { ${env.map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }`,
  ].join("\n");

  const flags = env.map(([k, v]) => `-e ${k}=${v}`);
  const run = onNpm ? MCP_NPX : `node ${CLONE_BIN}`;
  const claudeCode = [
    "claude mcp add probarion \\",
    ...flags.map((f) => `  ${f} \\`),
    `  -- ${run}`,
  ].join("\n");
  const winRun = onNpm ? `cmd /c ${MCP_NPX}` : `node C:${CLONE_BIN}`;
  const pathWindows = `On Windows, write the path with forward slashes, such as \`C:${CLONE_BIN}\`.`;
  const jsonWindows = onNpm
    ? `On Windows: \`"command": "cmd"\` and \`"args": ${list(winArgs)}\`.`
    : `On Windows, write the path with forward slashes, such as \`C:${CLONE_BIN}\`: in JSON a backslash must be doubled.`;

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      where: null,
      code: claudeCode,
      windows: `On Windows, put it on one line and end it with \`-- ${winRun}\`${onNpm ? "" : " (forward slashes; `node` needs no `cmd /c`)"}:`,
      windowsCode: `claude mcp add probarion ${flags.join(" ")} -- ${winRun}`,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      where:
        "In `claude_desktop_config.json` (Settings, Developer, Edit config), then restart Claude Desktop:",
      code: json,
      windows: jsonWindows,
      windowsCode: null,
    },
    {
      id: "cursor",
      label: "Cursor",
      where: "In `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:",
      code: json,
      windows: onNpm ? null : pathWindows,
      windowsCode: null,
    },
    {
      id: "codex",
      label: "Codex",
      where: "In `~/.codex/config.toml`:",
      code: toml,
      windows: onNpm ? null : pathWindows,
      windowsCode: null,
    },
  ];
}

// --- step 6: the status card -------------------------------------------------------------------------------------

/** A key's access key on the vault, as the page read it. */
export type KeyAccess =
  | { state: "scoped"; allowanceYocto: string | null }
  | { state: "missing" }
  | { state: "wrong_scope" }
  | { state: "unavailable" };

/** A key on the vault that Probarion did not make: the user's own agent holds its secret. */
export interface OutsideKey {
  public_key: string;
  label: string;
  access: KeyAccess;
}

export type StatusTone = "good" | "warn" | "bad" | "neutral";

export interface StatusRow {
  id: "agent" | "ledger" | "mandate" | "usdc" | "history";
  title: string;
  /** A sentence in which a `backticked` part is code. */
  text: string;
  tone: StatusTone;
  badge: string;
}

export interface StatusInput {
  vault: string;
  testnet: boolean;
  facts: VaultKeyFacts;
  outsideAgents: OutsideKey[];
  outsideLedger: OutsideKey | null;
  activeMandateKeys: string[] | null;
  usdc: string | null;
  /** The keys "Check these keys" accepted, if any: the card then speaks of these. */
  pasted: { agentKey: string; ledgerKey: string } | null;
}

/**
 * The agent key the card speaks of: the pasted one once it is on the vault, else the vault's one agent key held
 * outside Probarion, if there is exactly one.
 */
export function focusAgent(input: Pick<StatusInput, "outsideAgents" | "pasted">): string | null {
  const pasted = input.pasted?.agentKey;
  if (pasted !== undefined) {
    return input.outsideAgents.some((a) => a.public_key === pasted) ? pasted : null;
  }
  return input.outsideAgents.length === 1 ? (input.outsideAgents[0]?.public_key ?? null) : null;
}

/** At least `min` decimal places, at most `max`, so a balance reads as money: "25.00", "1.000". */
function decimal(units: string, decimals: number, min: number, max: number): string {
  const [int, frac = ""] = formatUnits(units, decimals, max).split(".");
  return `${int}.${frac.padEnd(min, "0")}`;
}

const near = (yocto: string) => `${decimal(yocto, 24, 3, 3)} NEAR`;

type RowBody = Pick<StatusRow, "text" | "tone" | "badge">;

function accessRow(key: OutsideKey, method: "spend()" | "anchor()"): RowBody {
  const k = `\`${shortKey(key.public_key)}\``;
  switch (key.access.state) {
    case "scoped": {
      const left = key.access.allowanceYocto;
      if (left === null) {
        return {
          text: `${k}, ${method} only, with no gas limit: the vault never adds such a key, so check it`,
          tone: "bad",
          badge: "check",
        };
      }
      if (left === "0")
        return { text: `${k}, ${method} only, no gas left`, tone: "bad", badge: "no gas" };
      return { text: `${k}, ${method} only, ${near(left)} gas left`, tone: "good", badge: "ready" };
    }
    case "missing":
      return {
        text: `${k} is registered, but its access key is not on the vault`,
        tone: "bad",
        badge: "check",
      };
    case "wrong_scope":
      return {
        text: `${k} is on the vault, but its access key is not limited to ${method}`,
        tone: "bad",
        badge: "check",
      };
    case "unavailable":
      return { text: `${k}: its access key could not be read`, tone: "warn", badge: "unavailable" };
  }
}

function agentRow(input: StatusInput, focus: string | null): RowBody {
  const focused = input.outsideAgents.find((a) => a.public_key === focus);
  if (focused) return accessRow(focused, "spend()");
  const n = input.outsideAgents.length;
  if (input.pasted === null && n > 1) {
    return {
      text: `${n} agent keys are held outside Probarion. Paste yours in step 2 to check it.`,
      tone: "neutral",
      badge: `${n} keys`,
    };
  }
  return {
    text: input.pasted === null ? "None yet" : "Not on the vault yet",
    tone: "warn",
    badge: "step 3",
  };
}

function ledgerRow(input: StatusInput): RowBody {
  const ledger = input.facts.ledgerKey;
  if (ledger === null)
    return { text: "The vault has no ledger key yet", tone: "warn", badge: "step 3" };
  if (input.facts.hostedKeys.includes(ledger)) {
    return {
      text: "Probarion's hosted Payables holds the vault's ledger key, so its ledger is not the agent's",
      tone: "bad",
      badge: "hosted",
    };
  }
  const pasted = input.pasted?.ledgerKey;
  if (pasted !== undefined && pasted !== ledger) {
    return {
      text: `The vault's ledger key is \`${shortKey(ledger)}\`, not the one pasted in step 2`,
      tone: "warn",
      badge: "step 3",
    };
  }
  if (input.outsideLedger === null)
    return { text: "Its access key could not be read", tone: "warn", badge: "unavailable" };
  return accessRow(input.outsideLedger, "anchor()");
}

function mandateRow(input: StatusInput, focus: string | null): RowBody {
  if (input.activeMandateKeys === null) {
    return { text: "The mandates could not be read", tone: "warn", badge: "unavailable" };
  }
  const keys = focus !== null ? [focus] : input.outsideAgents.map((a) => a.public_key);
  const bound = input.activeMandateKeys.filter((k) => keys.includes(k)).length;
  if (bound === 0) return { text: "None yet", tone: "warn", badge: "step 4" };
  return {
    text: bound === 1 ? "1 active mandate" : `${bound} active mandates`,
    tone: "good",
    badge: "ready",
  };
}

function usdcRow(input: StatusInput): RowBody {
  if (input.usdc === null)
    return { text: "The balance could not be read", tone: "warn", badge: "unavailable" };
  if (input.usdc === "0") return { text: "None yet", tone: "warn", badge: "step 4" };
  return {
    text: `${decimal(input.usdc, USDC_DECIMALS, 2, USDC_DECIMALS)} ${input.testnet ? "test USDC" : "USDC"}`,
    tone: "good",
    badge: "ready",
  };
}

function historyRow(input: StatusInput): RowBody {
  const { facts } = input;
  if (facts.hostedLedgerActive || facts.hostedLedgerEntries > 0) {
    const n = facts.hostedLedgerEntries;
    return {
      text: `Kept by Probarion's hosted Payables (${n} ${n === 1 ? "entry" : "entries"})`,
      tone: "neutral",
      badge: "hosted",
    };
  }
  const anchored = facts.firstAnchorSigner === null ? "No anchor yet." : "Anchored on chain.";
  return {
    text: `Kept by the agent, in \`~/.probarion/${input.vault}/ledger.jsonl\`. ${anchored}`,
    tone: "neutral",
    badge: "on your machine",
  };
}

/** The five rows of step 6, from the chain reads the page made. */
export function statusRows(input: StatusInput): StatusRow[] {
  const focus = focusAgent(input);
  return [
    { id: "agent", title: "Agent key on the vault", ...agentRow(input, focus) },
    { id: "ledger", title: "Ledger key is this agent's", ...ledgerRow(input) },
    { id: "mandate", title: "Mandate for this key", ...mandateRow(input, focus) },
    { id: "usdc", title: "USDC in the vault", ...usdcRow(input) },
    { id: "history", title: "Ledger", ...historyRow(input) },
  ];
}

/** How many rows still ask for a step: the ones that are neither ready nor only a fact. */
export function stepsLeft(rows: readonly StatusRow[]): number {
  return rows.filter((r) => r.tone === "warn" || r.tone === "bad").length;
}
