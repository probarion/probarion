// `probarion-mcp status`: is this machine's server ready to pay from its vault? It reads the same settings as the
// server (PROBARION_VAULT_ID and the same key sources), then checks the keys, the vault's view of them, the vault
// itself, the mandates, the USDC and the local ledger, and prints one line per check: ok, not yet (a step to
// take) or fail (something is wrong, or could not be read). Read-only: view calls and a dry run of the server's
// single-writer guard. Nothing is signed or sent. Exit code 0 when ready, 1 when not, 2 for a config error.
import type { Writable } from "node:stream";
import type {
  AccessKeyInfo,
  AgentView,
  AnchorView,
  MandateView,
  VaultConfig,
} from "@probarion/core";
import { FileLedgerStore, RpcClient, VaultClient } from "@probarion/sdk";
import { ConfigError, loadConfig, type McpConfig } from "./config.js";
import { assertSingleWriter, LedgerForkError, type LedgerReader } from "./guard.js";
import { defaultKeysPath, type ReadKeysFile, readKeysFileFromDisk } from "./keys-file.js";
import { safeMessage } from "./server.js";
import { AGENT_TAB, consoleWhere, MANDATES_TAB, OVERVIEW_TAB, TOPUP_TAB } from "./site.js";
import { formatUsdc } from "./units.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The chain reads `status` makes: view calls only. */
export interface StatusChain {
  listAgents(): Promise<AgentView[]>;
  getConfig(): Promise<VaultConfig>;
  /** The vault account's access key, or null when it has no such key. */
  accessKey(publicKey: string): Promise<AccessKeyInfo | null>;
  listMandates(): Promise<MandateView[]>;
  /** The vault's balance of this NEP-141 token, in its smallest units. */
  tokenBalance(token: string): Promise<string>;
  latestAnchor(): Promise<AnchorView | null>;
}

/** The reads over the SDK's `VaultClient` and `RpcClient`, at the RPC URLs `loadConfig` checked. */
export function sdkStatusChain(cfg: McpConfig): StatusChain {
  const rpc = new RpcClient({ urls: cfg.rpcUrls });
  const vault = new VaultClient(cfg.vault, rpc);
  return {
    listAgents: () => vault.listAgents(),
    getConfig: () => vault.getConfig(),
    accessKey: (publicKey) => rpc.viewAccessKey(cfg.vault, publicKey),
    listMandates: () => vault.listAllMandates(),
    tokenBalance: (token) =>
      rpc.viewFunction<string>(token, "ft_balance_of", { account_id: cfg.vault }),
    // The same read as the SDK's `Probarion.anchors.latest()`, which the server's guard uses.
    latestAnchor: async () => (await vault.listAllAnchors()).at(-1) ?? null,
  };
}

export interface StatusIo {
  env: Env;
  home: string;
  out: Writable;
  err: Writable;
  /** Test seams. */
  chain?: (cfg: McpConfig) => StatusChain;
  ledger?: (path: string) => LedgerReader;
  readKeysFile?: ReadKeysFile;
  now?: () => Date;
}

export type Verdict = "ok" | "not yet" | "fail";

export interface StatusLine {
  check: string;
  verdict: Verdict;
  detail: string;
  /** What to do about it, for a line that is not ok. */
  next: string | null;
}

export const STATUS_HELP = `Usage: probarion-mcp status

Checks whether the MCP server on this machine is ready to pay from its vault, with the settings the server
reads: PROBARION_VAULT_ID, and the keys from PROBARION_KEYS_FILE, ~/.probarion/<vault>/keys.json, or
PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY. One line per check, each ok, not yet or fail: the keys; the vault is
not frozen; the agent key is an agent key of the vault, limited to spend, with allowance left; the ledger key
is the vault's, limited to anchor; an active mandate is bound to the agent key; the vault's USDC; and the
local ledger file against the vault's latest anchor (the server's single-writer check, run dry).
Read-only: nothing is signed or sent. Exit code 0 when ready, 1 when not, 2 for a configuration error.
`;

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, error: safeMessage(e) };
  }
}

/** yoctoNEAR as NEAR, cut (not rounded) to at most 4 decimals. */
function near(yocto: bigint): string {
  const base = 10n ** 24n;
  const fraction = ((yocto % base) / 10n ** 20n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction === "" ? `${yocto / base}` : `${yocto / base}.${fraction}`;
}

/** The verdict on a function-call key that should call only `method` on the vault, with allowance left. */
function scopedKey(
  key: AccessKeyInfo | null,
  vault: string,
  method: string,
): { verdict: Verdict; detail: string } {
  if (key === null) {
    return { verdict: "fail", detail: "the vault account has no such access key" };
  }
  const p = key.permission;
  if (p === "FullAccess") {
    return {
      verdict: "fail",
      detail:
        "it is a full-access key of the vault account, which can do anything the owner can: the owner deletes it",
    };
  }
  if (p.receiver_id !== vault || p.method_names.length !== 1 || p.method_names[0] !== method) {
    return {
      verdict: "fail",
      detail: `its access key is not limited to ${method} on the vault (receiver ${p.receiver_id}, methods ${JSON.stringify(p.method_names)})`,
    };
  }
  if (p.allowance === null) {
    return {
      verdict: "ok",
      detail: `a function-call key for ${method} only, with no allowance cap`,
    };
  }
  const left = BigInt(p.allowance);
  if (left === 0n) {
    return {
      verdict: "fail",
      detail:
        "its allowance is used up: the owner removes the key and adds it again with a new allowance",
    };
  }
  return {
    verdict: "ok",
    detail: `a function-call key for ${method} only, ${near(left)} NEAR of allowance left`,
  };
}

/** The contract would still take a spend from `agentPk` under this mandate: active, bound to it, not expired, a use and room left. */
function usable(m: MandateView, now: Date, agentPk: string): boolean {
  if (m.status !== "active" || m.agent_pk !== agentPk) return false;
  try {
    if (BigInt(now.getTime()) * 1_000_000n >= BigInt(m.expires_at_ns)) return false;
    if (!(m.uses < m.max_uses)) return false;
    return BigInt(m.spent) + BigInt(m.reserved) < BigInt(m.max_total);
  } catch {
    return false; // an unreadable number counts as not usable
  }
}

/** Every check, in order. Read-only. */
export async function statusLines(
  cfg: McpConfig,
  chain: StatusChain,
  ledger: LedgerReader,
  now: Date,
): Promise<StatusLine[]> {
  const lines: StatusLine[] = [];
  const add = (check: string, verdict: Verdict, detail: string, next: string | null = null) => {
    lines.push({ check, verdict, detail, next });
  };
  const addKeys = `the vault's owner pastes the two public keys on ${consoleWhere(cfg.network, cfg.vault, AGENT_TAB)}, or prints the owner transactions with probarion agent add and probarion ledger set-key`;
  const initFirst = `run probarion-mcp init --vault ${cfg.vault}`;

  // The keys.
  if (cfg.keysSource === "none") {
    add("keys", "not yet", "no keys found, so the server would run read-only", initFirst);
  } else if (cfg.keysSource === "env") {
    add("keys", "ok", "from PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY");
  } else {
    add("keys", "ok", `from the keys file ${cfg.keysSource.slice("file:".length)}`);
  }

  // The vault. Its config is the first read: when it cannot be had, nothing else on chain is asked.
  const config = await settle(() => chain.getConfig());
  if (!config.ok) {
    add(
      "vault",
      "fail",
      `get_config could not be read: ${config.error}`,
      `check PROBARION_VAULT_ID (a vault on ${cfg.network}) and NEAR_RPC_URLS`,
    );
    for (const check of ["agent key", "ledger key", "mandates", "USDC", "ledger"]) {
      add(check, "fail", "not checked: the vault could not be read");
    }
    return lines;
  }
  if (config.value.frozen) {
    add(
      "vault",
      "not yet",
      "the vault is frozen: it pays nothing until its owner unfreezes it",
      `the owner unfreezes it on ${consoleWhere(cfg.network, cfg.vault, OVERVIEW_TAB)}`,
    );
  } else {
    add("vault", "ok", "not frozen");
  }

  // The agent key, as the vault sees it.
  const agentPk = cfg.agentPublicKey;
  if (agentPk === null) {
    add("agent key", "not yet", "no agent key", initFirst);
  } else {
    const agents = await settle(() => chain.listAgents());
    if (!agents.ok) {
      add("agent key", "fail", `list_agents could not be read: ${agents.error}`);
    } else if (!agents.value.some((a) => a.public_key === agentPk)) {
      add("agent key", "not yet", `${agentPk} is not an agent key of the vault yet`, addKeys);
    } else {
      const key = await settle(() => chain.accessKey(agentPk));
      if (!key.ok) {
        add("agent key", "fail", `its access key could not be read: ${key.error}`);
      } else {
        const v = scopedKey(key.value, cfg.vault, "spend");
        add("agent key", v.verdict, `${agentPk} is an agent key of the vault: ${v.detail}`);
      }
    }
  }

  // The ledger key, as the vault's config names it.
  const ledgerPk = cfg.ledgerPublicKey;
  if (ledgerPk === null) {
    add("ledger key", "not yet", "no ledger key", initFirst);
  } else if (config.value.ledger_key === null) {
    add("ledger key", "not yet", "the vault has no ledger key yet", addKeys);
  } else if (config.value.ledger_key !== ledgerPk) {
    add(
      "ledger key",
      "not yet",
      `the vault's ledger key is another key, ${config.value.ledger_key}. Setting ${ledgerPk} replaces it, so anchor the ledger the other key signs first`,
      addKeys,
    );
  } else {
    const key = await settle(() => chain.accessKey(ledgerPk));
    if (!key.ok) {
      add("ledger key", "fail", `its access key could not be read: ${key.error}`);
    } else {
      const v = scopedKey(key.value, cfg.vault, "anchor");
      add("ledger key", v.verdict, `${ledgerPk} is the vault's ledger key: ${v.detail}`);
    }
  }

  // The mandates bound to the agent key.
  if (agentPk === null) {
    add("mandates", "not yet", "no agent key to bind a mandate to", initFirst);
  } else {
    const mandates = await settle(() => chain.listMandates());
    if (!mandates.ok) {
      add("mandates", "fail", `list_mandates could not be read: ${mandates.error}`);
    } else {
      const ready = mandates.value.filter((m) => usable(m, now, agentPk));
      const bound = mandates.value.filter((m) => m.agent_pk === agentPk).length;
      if (ready.length === 0) {
        add(
          "mandates",
          "not yet",
          `no active mandate is bound to the agent key (the vault has ${mandates.value.length}, ${bound} of them for this key, none with a use and room left before its expiry)`,
          `the owner signs a mandate for the agent key on ${consoleWhere(cfg.network, cfg.vault, MANDATES_TAB)}, or with probarion mandate create`,
        );
      } else {
        const ids = ready.map((m) => m.id).join(", ");
        add(
          "mandates",
          "ok",
          `${ready.length} active ${ready.length === 1 ? "mandate" : "mandates"} bound to the agent key (${ready.length === 1 ? "id" : "ids"} ${ids})`,
        );
      }
    }
  }

  // The vault's USDC.
  const balance = await settle(() => chain.tokenBalance(config.value.usdc));
  if (!balance.ok) {
    add("USDC", "fail", `ft_balance_of could not be read: ${balance.error}`);
  } else if (typeof balance.value !== "string" || !/^\d+$/.test(balance.value)) {
    add("USDC", "fail", "ft_balance_of did not answer an amount");
  } else if (BigInt(balance.value) === 0n) {
    add(
      "USDC",
      "not yet",
      "the vault holds no USDC",
      `top it up on ${consoleWhere(cfg.network, cfg.vault, TOPUP_TAB)}`,
    );
  } else {
    add("USDC", "ok", `${formatUsdc(balance.value)} USDC in the vault`);
  }

  // The local ledger against the latest anchor: the server's single-writer check before a spend, run dry.
  const latest = await settle(() => chain.latestAnchor());
  const entries = await settle(() => ledger.all());
  if (!latest.ok) {
    add("ledger", "fail", `list_anchors could not be read: ${latest.error}`);
  } else if (!entries.ok) {
    add("ledger", "fail", `${cfg.ledgerPath} could not be read: ${entries.error}`);
  } else {
    const n = entries.value.length;
    const held = `${cfg.ledgerPath} holds ${n} ${n === 1 ? "entry" : "entries"}`;
    try {
      await assertSingleWriter({ all: async () => entries.value }, async () => latest.value);
      const a = latest.value;
      add(
        "ledger",
        "ok",
        a === null || a.count === 0
          ? `${held}, and the vault has no anchor yet`
          : `${held}; the vault's latest anchor (seq ${a.seq}) covers ${a.count} of them, with the same root`,
      );
    } catch (e) {
      if (!(e instanceof LedgerForkError)) throw e;
      add("ledger", "fail", `${held}. ${safeMessage(e)}`);
    }
  }
  return lines;
}

/** Runs `status`; returns the exit code. */
export async function runStatus(args: readonly string[], io: StatusIo): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.out.write(STATUS_HELP);
    return 0;
  }
  if (args.length > 0) {
    io.err.write(
      `probarion-mcp status: unknown argument ${JSON.stringify(args[0]).slice(0, 60)}\n\n${STATUS_HELP}`,
    );
    return 2;
  }
  let cfg: McpConfig;
  try {
    cfg = loadConfig(io.env, io.home, io.readKeysFile ?? readKeysFileFromDisk);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err.write(`probarion-mcp status: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const chain = (io.chain ?? sdkStatusChain)(cfg);
  const ledger = io.ledger?.(cfg.ledgerPath) ?? new FileLedgerStore(cfg.ledgerPath);
  const lines = await statusLines(cfg, chain, ledger, (io.now ?? (() => new Date()))());

  const say = (line = ""): void => {
    io.out.write(`${line}\n`);
  };
  say(
    `probarion-mcp status: vault ${cfg.vault} on ${cfg.network}. Read-only: nothing is signed or sent.`,
  );
  for (const l of lines) say(`  ${l.verdict.padEnd(8)} ${l.check.padEnd(11)} ${l.detail}`);
  say();
  const notYet = lines.filter((l) => l.verdict === "not yet").length;
  const failed = lines.filter((l) => l.verdict === "fail").length;
  if (notYet + failed === 0) {
    const settings =
      cfg.keysSource === "env"
        ? `PROBARION_VAULT_ID=${cfg.vault}, PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY`
        : cfg.keysSource === `file:${defaultKeysPath(io.home, cfg.vault)}`
          ? `only PROBARION_VAULT_ID=${cfg.vault}`
          : `PROBARION_VAULT_ID=${cfg.vault} and PROBARION_KEYS_FILE=${cfg.keysSource.slice("file:".length)}`;
    say(`Ready: an MCP client can start the server with ${settings}.`);
    return 0;
  }
  const counts = [
    notYet > 0 ? `${notYet} not yet` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter((c) => c !== null);
  say(`Not ready: ${counts.join(", ")}.`);
  const first = lines.find((l) => l.verdict !== "ok" && l.next !== null);
  if (first !== undefined && first.next !== null) say(`Next (${first.check}): ${first.next}.`);
  return 1;
}
