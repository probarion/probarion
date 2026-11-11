// `probarion-mcp status`: is this machine's server ready to pay from its vault? It reads the same settings as the
// server (PROBARION_VAULT_ID and the same key sources), then checks the keys, the vault's view of them, the vault
// itself, the mandates, the USDC and the local ledger, and prints one line per check: ok, not yet (a step to
// take) or fail (something is wrong, or could not be read). Read-only: view calls and a dry run of the server's
// single-writer guard. Nothing is signed or sent. Exit code 0 when ready, 1 when not, 2 for a config error.
import { statSync } from "node:fs";
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
import {
  type LedgerEntryLite,
  type LedgerReader,
  signerShown,
  singleWriterProblem,
} from "./guard.js";
import { defaultKeysPath, type ReadKeysFile, readKeysFileFromDisk } from "./keys-file.js";
import { safeMessage } from "./server.js";
import { AGENT_TAB, MANDATES_TAB, OVERVIEW_TAB, ownerStep, TOPUP_TAB } from "./site.js";
import { formatUsdc } from "./units.js";
import { argumentShown, shellWord } from "./words.js";

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

/** The permission bits of the file at `path`, or null where they mean nothing (Windows) or cannot be read. */
export function keysFileModeOnDisk(path: string, platform: NodeJS.Platform): number | null {
  if (platform === "win32") return null;
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

export interface StatusIo {
  env: Env;
  home: string;
  out: Writable;
  err: Writable;
  /** The command this binary was started as, for the commands it prints. Default `probarion-mcp`. */
  self?: string;
  /** Test seams. */
  chain?: (cfg: McpConfig) => StatusChain;
  ledger?: (path: string) => LedgerReader;
  readKeysFile?: ReadKeysFile;
  keysFileMode?: (path: string) => number | null;
  platform?: NodeJS.Platform;
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

/** What `statusLines` knows besides the config and the chain. */
export interface StatusContext {
  /** The command this binary was started as. Default `probarion-mcp`. */
  self?: string;
  /** The keys file's permission bits, or null where they mean nothing or were not read. */
  keysFileMode?: number | null;
}

export const STATUS_HELP = `Usage: probarion-mcp status

Checks whether the MCP server on this machine is ready to pay from its vault, with the settings the server
reads: PROBARION_VAULT_ID, and the keys from PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY when both are set,
else from the keys file PROBARION_KEYS_FILE names, else from ~/.probarion/<vault>/keys.json, else none. One
line per check, each ok, not yet or fail: the keys (and that only you can read their file); the vault is not
frozen; the agent key is an agent key of the vault, limited to spend, with allowance left; the ledger key
is the vault's, limited to anchor; an active mandate is bound to the agent key; the vault's USDC; and the
local ledger file against the vault's latest anchor (the server's single-writer check, run dry: the anchored
entries are this file's, and this server's ledger key signed the ones after them).
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

const entriesWord = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

/** Every check, in order. Read-only. */
export async function statusLines(
  cfg: McpConfig,
  chain: StatusChain,
  ledger: LedgerReader,
  now: Date,
  context: StatusContext = {},
): Promise<StatusLine[]> {
  const lines: StatusLine[] = [];
  const add = (check: string, verdict: Verdict, detail: string, next: string | null = null) => {
    lines.push({ check, verdict, detail, next });
  };
  const self = context.self ?? "probarion-mcp";
  const { network, vault } = cfg;
  const initFirst = `run ${self} init --vault ${vault}`;
  const again = `run ${self} status again; if it fails again, check NEAR_RPC_URLS`;
  const addAgent = (pk: string) =>
    ownerStep(
      network,
      vault,
      AGENT_TAB,
      "pastes the agent and ledger public keys",
      `signs the transaction that probarion agent add --vault ${vault} --pk ${pk} prints`,
    );
  // The console's Agent (MCP) tab sets a ledger key only on a vault with no anchor yet (it keeps an anchored ledger
  // to the key that anchored it), so the tab is offered for the ledger key only then.
  const setLedger = (pk: string) => {
    const cli = `signs the transaction that probarion ledger set-key --vault ${vault} --pk ${pk} prints`;
    return noAnchorYet
      ? ownerStep(network, vault, AGENT_TAB, "pastes the agent and ledger public keys", cli)
      : `the vault's owner ${cli}`;
  };
  const forkNext =
    "point PROBARION_LEDGER_PATH at the ledger file the vault's anchors cover, if it is on this machine, or give this server a vault of its own";
  /** The tail another key signed is anchored by that key first; the owner sets this server's key after. */
  const anchorFirst = (other: string, ours: string) =>
    `anchor those entries with ${other} first (the server that holds it anchors its ledger at the end of its next request_spend), then ${setLedger(ours)}`;

  // The keys.
  if (cfg.keysSource === "none") {
    add("keys", "not yet", "no keys found, so the server would run read-only", initFirst);
  } else if (cfg.keysSource === "env") {
    add("keys", "ok", "from PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY");
  } else {
    const file = cfg.keysSource.slice("file:".length);
    const mode = context.keysFileMode ?? null;
    if (mode !== null && (mode & 0o077) !== 0) {
      add(
        "keys",
        "fail",
        `the keys file ${file} holds the two secret keys, and other users of this machine can read it (mode ${(mode & 0o777).toString(8).padStart(4, "0")})`,
        `chmod 600 ${shellWord(file) ?? file}. If someone else may have read it, make new keys: move it away, run ${self} init --vault ${vault} again, and have the owner add the new public keys`,
      );
    } else {
      add("keys", "ok", `from the keys file ${file}`);
    }
  }

  // The vault. Its config is the first read: when it cannot be had, nothing else on chain is asked.
  const config = await settle(() => chain.getConfig());
  if (!config.ok) {
    add(
      "vault",
      "fail",
      `get_config could not be read: ${config.error}`,
      `check PROBARION_VAULT_ID (a vault on ${network}) and NEAR_RPC_URLS`,
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
      ownerStep(
        network,
        vault,
        OVERVIEW_TAB,
        "unfreezes it",
        `signs the transaction that probarion vault unfreeze --vault ${vault} prints`,
      ),
    );
  } else {
    add("vault", "ok", "not frozen");
  }

  // The latest anchor and the local ledger, read before the ledger key's line, whose advice depends on them.
  const latest = await settle(() => chain.latestAnchor());
  const entries = await settle(() => ledger.all());
  const read: { latest: AnchorView | null; entries: readonly LedgerEntryLite[] } | null =
    latest.ok && entries.ok ? { latest: latest.value, entries: entries.value } : null;
  // Whether the anchored entries are this file's (LEDGER_FORK_RISK when not), with no signer check yet.
  const fork = read === null ? null : singleWriterProblem(read.entries, read.latest, null);
  const noAnchorYet = read !== null && read.latest === null;
  const unanchored =
    read === null || fork !== null ? [] : read.entries.slice(read.latest?.count ?? 0);

  // The agent key, as the vault sees it.
  const agentPk = cfg.agentPublicKey;
  if (agentPk === null) {
    add("agent key", "not yet", "no agent key", initFirst);
  } else {
    const readd = `the vault's owner signs the transactions that probarion agent remove --vault ${vault} --pk ${agentPk} and then probarion agent add --vault ${vault} --pk ${agentPk} print, which give it a function-call key for spend only`;
    const agents = await settle(() => chain.listAgents());
    if (!agents.ok) {
      add("agent key", "fail", `list_agents could not be read: ${agents.error}`, again);
    } else if (!agents.value.some((a) => a.public_key === agentPk)) {
      add(
        "agent key",
        "not yet",
        `${agentPk} is not an agent key of the vault yet`,
        addAgent(agentPk),
      );
    } else {
      const key = await settle(() => chain.accessKey(agentPk));
      if (!key.ok) {
        add("agent key", "fail", `its access key could not be read: ${key.error}`, again);
      } else {
        const v = scopedKey(key.value, vault, "spend");
        add(
          "agent key",
          v.verdict,
          `${agentPk} is an agent key of the vault: ${v.detail}`,
          v.verdict === "ok" ? null : readd,
        );
      }
    }
  }

  // The ledger key, as the vault's config names it.
  const ledgerPk = cfg.ledgerPublicKey;
  const vaultLedgerKey = config.value.ledger_key;
  if (ledgerPk === null) {
    add("ledger key", "not yet", "no ledger key", initFirst);
  } else if (vaultLedgerKey === null) {
    add("ledger key", "not yet", "the vault has no ledger key yet", setLedger(ledgerPk));
  } else if (vaultLedgerKey !== ledgerPk) {
    const signedByIt = unanchored.filter((e) => e.signer === vaultLedgerKey).length;
    if (fork !== null) {
      // Another process anchors this vault from its own ledger: a new ledger key here would not make it ready.
      add(
        "ledger key",
        "fail",
        `the vault's ledger key is another key, ${vaultLedgerKey}, and the ledger its anchors cover is not this machine's ledger file (the ledger line says why): another process holds that key. Setting ${ledgerPk} would delete it, and this server still could not pay`,
        forkNext,
      );
    } else if (signedByIt > 0) {
      add(
        "ledger key",
        "not yet",
        `the vault's ledger key is another key, ${vaultLedgerKey}, which signed ${entriesWord(signedByIt)} of this ledger after the vault's last anchor. Setting ${ledgerPk} deletes that key, so those entries must be anchored with it first`,
        anchorFirst(vaultLedgerKey, ledgerPk),
      );
    } else {
      add(
        "ledger key",
        "not yet",
        `the vault's ledger key is another key, ${vaultLedgerKey}. Setting ${ledgerPk} replaces it: the vault deletes the other key${read === null ? ", so make sure every entry it signed is anchored first" : ", and this ledger file has no entry after the last anchor that it signed"}`,
        setLedger(ledgerPk),
      );
    }
  } else {
    const key = await settle(() => chain.accessKey(ledgerPk));
    if (!key.ok) {
      add("ledger key", "fail", `its access key could not be read: ${key.error}`, again);
    } else {
      const v = scopedKey(key.value, vault, "anchor");
      add(
        "ledger key",
        v.verdict,
        `${ledgerPk} is the vault's ledger key: ${v.detail}`,
        v.verdict === "ok"
          ? null
          : `the vault's owner replaces the ledger key with a new one, which also deletes this one: ${self} init --vault ${vault} --keys-file <a new path> makes new keys for this server, and probarion ledger set-key --vault ${vault} --pk <its ledger public key> prints the owner's transaction`,
      );
    }
  }

  // The mandates bound to the agent key.
  if (agentPk === null) {
    add("mandates", "not yet", "no agent key to bind a mandate to", initFirst);
  } else {
    const mandates = await settle(() => chain.listMandates());
    if (!mandates.ok) {
      add("mandates", "fail", `list_mandates could not be read: ${mandates.error}`, again);
    } else {
      const ready = mandates.value.filter((m) => usable(m, now, agentPk));
      const bound = mandates.value.filter((m) => m.agent_pk === agentPk).length;
      if (ready.length === 0) {
        add(
          "mandates",
          "not yet",
          `no active mandate is bound to the agent key (the vault has ${mandates.value.length}, ${bound} of them for this key, none with a use and room left before its expiry)`,
          ownerStep(
            network,
            vault,
            MANDATES_TAB,
            "signs a mandate for the agent key",
            `signs the transaction that probarion mandate create --vault ${vault} --agent-pk ${agentPk}, with the mandate's payee, caps, uses, expiry, approval threshold, purpose and label, prints`,
          ),
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
  const usdc = config.value.usdc;
  const balance = await settle(() => chain.tokenBalance(usdc));
  if (!balance.ok) {
    add("USDC", "fail", `ft_balance_of could not be read: ${balance.error}`, again);
  } else if (typeof balance.value !== "string" || !/^\d+$/.test(balance.value)) {
    add("USDC", "fail", "ft_balance_of did not answer an amount", again);
  } else if (BigInt(balance.value) === 0n) {
    add(
      "USDC",
      "not yet",
      "the vault holds no USDC",
      ownerStep(
        network,
        vault,
        TOPUP_TAB,
        "tops it up",
        `sends USDC to ${vault} from their wallet: a storage_deposit for the vault (registration only) and an ft_transfer to it, both on ${usdc}`,
      ),
    );
  } else {
    add("USDC", "ok", `${formatUsdc(balance.value)} USDC in the vault`);
  }

  // The local ledger against the latest anchor: the server's single-writer check before a spend, run dry.
  if (!latest.ok) {
    add("ledger", "fail", `list_anchors could not be read: ${latest.error}`, again);
  } else if (!entries.ok || read === null) {
    add(
      "ledger",
      "fail",
      `${cfg.ledgerPath} could not be read: ${entries.ok ? "unknown error" : entries.error}`,
      `restore ${cfg.ledgerPath} from a backup, or point PROBARION_LEDGER_PATH at the ledger file this server writes: the server refuses to pay while it cannot read its ledger`,
    );
  } else {
    const n = read.entries.length;
    const held = `${cfg.ledgerPath} holds ${entriesWord(n)}`;
    const mismatch = fork ?? singleWriterProblem(read.entries, read.latest, ledgerPk);
    if (mismatch === null) {
      const a = read.latest;
      add(
        "ledger",
        "ok",
        a === null || a.count === 0
          ? `${held}, and the vault has no anchor yet`
          : `${held}; the vault's latest anchor (seq ${a.seq}) covers ${a.count} of them, with the same root`,
      );
    } else if (mismatch.code === "LEDGER_FORK_RISK") {
      add("ledger", "fail", `${held}. ${safeMessage(mismatch)}`, forkNext);
    } else {
      // Another ledger key signed entries after the last anchor. When it is the vault's ledger key of the moment,
      // anchoring them is a step to take; any other key must first be set back as the vault's ledger key.
      const foreign = unanchored.filter((e) => e.signer !== ledgerPk);
      const byVaultKey =
        vaultLedgerKey !== null &&
        vaultLedgerKey !== ledgerPk &&
        foreign.every((e) => e.signer === vaultLedgerKey);
      const signer = signerShown(foreign[0]?.signer);
      add(
        "ledger",
        byVaultKey ? "not yet" : "fail",
        `${held}. ${safeMessage(mismatch)}`,
        byVaultKey && vaultLedgerKey !== null && ledgerPk !== null
          ? anchorFirst(vaultLedgerKey, ledgerPk)
          : `the vault's owner sets the key that signed them back as the vault's ledger key (probarion ledger set-key --vault ${vault} --pk ${signer.startsWith("ed25519:") ? signer : "<that key>"}), the server that holds it anchors them at the end of its next request_spend, and then the owner sets this server's ledger key again`,
      );
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
      `probarion-mcp status: unknown argument ${argumentShown(args[0] ?? "", 1)}\n\n${STATUS_HELP}`,
    );
    return 2;
  }
  const self = io.self ?? "probarion-mcp";
  let cfg: McpConfig;
  try {
    cfg = loadConfig(io.env, io.home, io.readKeysFile ?? readKeysFileFromDisk, self);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err.write(`probarion-mcp status: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const chain = (io.chain ?? sdkStatusChain)(cfg);
  const ledger = io.ledger?.(cfg.ledgerPath) ?? new FileLedgerStore(cfg.ledgerPath);
  const platform = io.platform ?? process.platform;
  const keysFile = cfg.keysSource.startsWith("file:") ? cfg.keysSource.slice("file:".length) : null;
  const modeOf = io.keysFileMode ?? ((p: string) => keysFileModeOnDisk(p, platform));
  const lines = await statusLines(cfg, chain, ledger, (io.now ?? (() => new Date()))(), {
    self,
    keysFileMode: keysFile === null ? null : modeOf(keysFile),
  });

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
  // Something wrong comes before a step still to take: a vault that cannot be read is named before the keys.
  const first =
    lines.find((l) => l.verdict === "fail" && l.next !== null) ??
    lines.find((l) => l.verdict === "not yet" && l.next !== null);
  if (first !== undefined && first.next !== null) say(`Next (${first.check}): ${first.next}.`);
  return 1;
}
