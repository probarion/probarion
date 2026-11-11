// `probarion-mcp status`: one line per check, each ok, not yet or fail, read through a fake chain; exit 0 when
// ready, 1 when not, 2 for a configuration error. One run goes through the SDK's readers to the fake RPC server.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AccessKeyInfo,
  AgentView,
  AnchorView,
  MandateView,
  VaultConfig,
} from "@probarion/core";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/cli.js";
import type { LedgerEntryLite, LedgerReader } from "../src/guard.js";
import { keysFileModeOnDisk, runStatus, STATUS_HELP, type StatusChain } from "../src/status.js";
import { shellWord } from "../src/words.js";
import {
  AGENT,
  capture,
  expectNoSecret,
  keysFileText,
  LEDGER,
  OTHER,
  tempDir,
} from "./keys-helpers.js";

const VAULT = "acme.vaults.probarion.testnet";
const NOW = new Date("2026-11-11T08:00:00.000Z");
const NEAR = 10n ** 24n;

const scoped = (method: string, allowance: string | null = (NEAR / 2n).toString()) => ({
  receiver_id: VAULT,
  method_names: [method],
  allowance,
});

const MANDATE: MandateView = {
  id: 3,
  payee: { type: "near", account_id: "vendor.testnet" },
  purpose_hash: "e".repeat(64),
  max_per_payment: "100000000",
  max_total: "1000000000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: "1798761600000000000", // 2027-01-01
  approval_above: "50000000",
  agent_pk: AGENT.publicKey,
  label: "hosting",
  status: "active",
  created_at_ns: "1793491200000000000",
};

const CONFIG: VaultConfig = {
  owner: "owner.testnet",
  approvers: [],
  usdc: "usdc.fakes.testnet",
  intents: "intents.testnet",
  allowed_assets: [],
  daily_backstop: "500000000",
  held_ttl_ns: "259200000000000",
  frozen: false,
  factory: null,
  version: "0.1.0",
  ledger_key: LEDGER.publicKey,
};

interface World {
  agents: AgentView[] | Error;
  config: VaultConfig | Error;
  keys: Record<string, AccessKeyInfo["permission"]>;
  mandates: MandateView[] | Error;
  balance: string | Error;
  anchor: AnchorView | null | Error;
  ledger: LedgerEntryLite[] | Error;
}

/** Ledger entries with these links, signed by `signer` (by default the keys file's ledger key). */
const signed = (links: string[], signer = LEDGER.publicKey): LedgerEntryLite[] =>
  links.map((link) => ({ link, signer }));

/** A vault where every check passes; `over` changes one part of it. */
function world(over: Partial<World> = {}): World {
  return {
    agents: [{ public_key: AGENT.publicKey, label: "agent", added_at_ns: "1" }],
    config: CONFIG,
    keys: { [AGENT.publicKey]: scoped("spend"), [LEDGER.publicKey]: scoped("anchor") },
    mandates: [MANDATE],
    balance: "12500000",
    anchor: { seq: 2, root: "l1", count: 2, at_ns: "1", ledger_key: LEDGER.publicKey },
    ledger: signed(["l0", "l1", "l2"]),
    ...over,
  };
}

const answer = async <T>(v: T | Error): Promise<T> => {
  if (v instanceof Error) throw v;
  return v;
};

function fakeChain(w: World): StatusChain {
  return {
    listAgents: () => answer(w.agents),
    getConfig: () => answer(w.config),
    accessKey: async (pk) => {
      const permission = w.keys[pk];
      return permission === undefined ? null : { public_key: pk, permission };
    },
    listMandates: () => answer(w.mandates),
    tokenBalance: () => answer(w.balance),
    latestAnchor: () => answer(w.anchor),
  };
}

/** A home with the default keys file of `vault` in it, holding AGENT and LEDGER. */
function homeWithKeys(vault = VAULT, network: "mainnet" | "testnet" = "testnet"): string {
  const home = tempDir("probarion-status-home-");
  mkdirSync(join(home, ".probarion", vault), { recursive: true });
  // Mode 0600, as init writes it: where the OS has mode bits, status fails a keys file others can read.
  writeFileSync(join(home, ".probarion", vault, "keys.json"), keysFileText(vault, network), {
    mode: 0o600,
  });
  return home;
}

interface Run {
  code: number;
  out: string;
  err: string;
  line(check: string): string;
}

async function status(
  w: World,
  opts: {
    env?: Record<string, string | undefined>;
    home?: string;
    args?: string[];
    self?: string;
    keysFileMode?: (path: string) => number | null;
  } = {},
): Promise<Run> {
  const out = capture();
  const err = capture();
  const ledger: LedgerReader = { all: () => answer(w.ledger) };
  const code = await runStatus(opts.args ?? [], {
    env: opts.env ?? { PROBARION_VAULT_ID: VAULT },
    home: opts.home ?? homeWithKeys(),
    out: out.stream,
    err: err.stream,
    chain: () => fakeChain(w),
    ledger: () => ledger,
    now: () => NOW,
    ...(opts.self === undefined ? {} : { self: opts.self }),
    ...(opts.keysFileMode === undefined ? {} : { keysFileMode: opts.keysFileMode }),
  });
  const text = out.text();
  for (const t of [text, err.text()]) expectNoSecret(t, [AGENT.secretKey, LEDGER.secretKey]);
  return {
    code,
    out: text,
    err: err.text(),
    line: (check) => text.split("\n").find((l) => l.slice(11, 22).trimEnd() === check) ?? "",
  };
}

describe("probarion-mcp status", () => {
  it("is ready when every check passes: exit 0, one ok line each", async () => {
    const r = await status(world());
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `probarion-mcp status: vault ${VAULT} on testnet. Read-only: nothing is signed or sent.`,
    );
    for (const check of [
      "keys",
      "vault",
      "agent key",
      "ledger key",
      "mandates",
      "USDC",
      "ledger",
    ]) {
      expect(r.line(check), check).toMatch(/^ {2}ok {7}/);
    }
    expect(r.line("keys")).toContain("from the keys file");
    expect(r.line("agent key")).toContain(
      `${AGENT.publicKey} is an agent key of the vault: a function-call key for spend only, 0.5 NEAR of allowance left`,
    );
    expect(r.line("ledger key")).toContain(`${LEDGER.publicKey} is the vault's ledger key`);
    expect(r.line("mandates")).toContain("1 active mandate bound to the agent key (id 3)");
    expect(r.line("USDC")).toContain("12.50 USDC in the vault");
    expect(r.line("ledger")).toContain(
      "holds 3 entries; the vault's latest anchor (seq 2) covers 2 of them, with the same root",
    );
    expect(r.out).toContain(
      `Ready: an MCP client can start the server with only PROBARION_VAULT_ID=${VAULT}.`,
    );
  });

  it("with no keys anywhere is not ready, and says to run init", async () => {
    const r = await status(world(), { home: tempDir("probarion-status-empty-") });
    expect(r.code).toBe(1);
    expect(r.line("keys")).toMatch(/not yet +keys +no keys found/);
    expect(r.line("agent key")).toContain("not yet");
    expect(r.line("ledger key")).toContain("not yet");
    expect(r.line("mandates")).toContain("not yet");
    expect(r.out).toContain(`Next (keys): run probarion-mcp init --vault ${VAULT}.`);
  });

  it("takes the keys from the environment too, and says so", async () => {
    const r = await status(world(), {
      home: tempDir("probarion-status-empty-"),
      env: {
        PROBARION_VAULT_ID: VAULT,
        PROBARION_AGENT_KEY: AGENT.secretKey,
        PROBARION_LEDGER_KEY: LEDGER.secretKey,
      },
    });
    expect(r.code).toBe(0);
    expect(r.line("keys")).toContain("from PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY");
  });

  it("names a keys file elsewhere in the ready line", async () => {
    const dir = tempDir("probarion-status-keys-");
    const file = join(dir, "acme.json");
    writeFileSync(file, keysFileText(VAULT, "testnet"), { mode: 0o600 });
    const r = await status(world(), {
      home: tempDir("probarion-status-empty-"),
      env: { PROBARION_VAULT_ID: VAULT, PROBARION_KEYS_FILE: file },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`PROBARION_VAULT_ID=${VAULT} and PROBARION_KEYS_FILE=${file}.`);
  });

  it("says not yet for an agent key the owner has not added, with the Agent (MCP) tab and the CLI's transaction", async () => {
    const r = await status(world({ agents: [] }));
    expect(r.code).toBe(1);
    expect(r.line("agent key")).toMatch(/^ {2}not yet {2}agent key/);
    expect(r.line("agent key")).toContain(
      `${AGENT.publicKey} is not an agent key of the vault yet`,
    );
    expect(r.out).toContain(
      `Next (agent key): the vault's owner pastes the agent and ledger public keys on the Agent (MCP) tab of the vault's console (https://probarion.xyz/console/${VAULT}/agent), or signs the transaction that probarion agent add --vault ${VAULT} --pk ${AGENT.publicKey} prints.`,
    );
    // A vault with no anchor yet: the tab sets its ledger key too.
    const ledger = await status(
      world({ config: { ...CONFIG, ledger_key: null }, anchor: null, ledger: [] }),
    );
    expect(ledger.out).toContain(
      `Next (ledger key): the vault's owner pastes the agent and ledger public keys on the Agent (MCP) tab of the vault's console (https://probarion.xyz/console/${VAULT}/agent), or signs the transaction that probarion ledger set-key --vault ${VAULT} --pk ${LEDGER.publicKey} prints.`,
    );
  });

  it("gives only the CLI's transaction for the ledger key of a vault that has anchors, which the tab does not change", async () => {
    const r = await status(world({ config: { ...CONFIG, ledger_key: null } }));
    expect(r.out).toContain(
      `Next (ledger key): the vault's owner signs the transaction that probarion ledger set-key --vault ${VAULT} --pk ${LEDGER.publicKey} prints.`,
    );
    expect(r.line("ledger key")).toBeDefined();
    expect(r.out).not.toMatch(/Next \(ledger key\):.*Agent \(MCP\) tab/);
  });

  it("prints its commands the way the binary was started", async () => {
    const r = await status(world(), {
      home: tempDir("probarion-status-empty-"),
      self: "node /src/probarion/packages/mcp/dist/bin.js",
    });
    expect(r.out).toContain(
      `Next (keys): run node /src/probarion/packages/mcp/dist/bin.js init --vault ${VAULT}.`,
    );
  });

  it("fails a keys file that other users can read, and names chmod 600", async () => {
    const home = homeWithKeys();
    const file = join(home, ".probarion", VAULT, "keys.json");
    const loose = await status(world(), { home, keysFileMode: () => 0o644 });
    expect(loose.code).toBe(1);
    expect(loose.line("keys")).toMatch(/^ {2}fail {5}keys/);
    expect(loose.line("keys")).toContain(
      "holds the two secret keys, and other users of this machine can read it (mode 0644)",
    );
    expect(loose.out).toContain(`Next (keys): chmod 600 ${shellWord(file) ?? file}.`);
    const tight = await status(world(), { home, keysFileMode: () => 0o600 });
    expect(tight.code).toBe(0);
    // Windows has no mode bits to read: the keys line is ok there.
    expect(keysFileModeOnDisk(file, "win32")).toBeNull();
  });

  it("fails an agent key that is full-access, scoped to another method or receiver, used up, or missing", async () => {
    const cases: [AccessKeyInfo["permission"] | undefined, string][] = [
      ["FullAccess", "full-access key of the vault account"],
      [scoped("anchor"), "not limited to spend on the vault"],
      [{ ...scoped("spend"), receiver_id: "other.testnet" }, "not limited to spend on the vault"],
      [{ ...scoped("spend"), method_names: [] }, "not limited to spend on the vault"],
      [{ ...scoped("spend"), method_names: ["spend", "anchor"] }, "not limited to spend"],
      [scoped("spend", "0"), "its allowance is used up"],
      [undefined, "the vault account has no such access key"],
    ];
    for (const [permission, want] of cases) {
      const keys: World["keys"] = { [LEDGER.publicKey]: scoped("anchor") };
      if (permission !== undefined) keys[AGENT.publicKey] = permission;
      const r = await status(world({ keys }));
      expect(r.code, want).toBe(1);
      expect(r.line("agent key"), want).toMatch(/^ {2}fail {5}agent key/);
      expect(r.line("agent key"), want).toContain(want);
    }
    const unlimited = await status(
      world({
        keys: { [AGENT.publicKey]: scoped("spend", null), [LEDGER.publicKey]: scoped("anchor") },
      }),
    );
    expect(unlimited.line("agent key")).toContain("ok");
    expect(unlimited.line("agent key")).toContain("with no allowance cap");
  });

  it("fails the agent key when list_agents cannot be read, without an RPC URL's path", async () => {
    const r = await status(
      world({ agents: new Error("fetch failed: https://rpc.example/secret-path?key=abc") }),
    );
    expect(r.line("agent key")).toMatch(/fail +agent key +list_agents could not be read/);
    expect(r.out).not.toContain("secret-path");
  });

  it("says not yet for a vault with no ledger key or another one, and fails a ledger key not limited to anchor", async () => {
    const none = await status(world({ config: { ...CONFIG, ledger_key: null } }));
    expect(none.code).toBe(1);
    expect(none.line("ledger key")).toMatch(/not yet +ledger key +the vault has no ledger key yet/);
    const other = await status(world({ config: { ...CONFIG, ledger_key: OTHER.publicKey } }));
    expect(other.line("ledger key")).toContain(
      `the vault's ledger key is another key, ${OTHER.publicKey}`,
    );
    expect(other.line("ledger key")).toContain("not yet");
    const wide = await status(
      world({ keys: { [AGENT.publicKey]: scoped("spend"), [LEDGER.publicKey]: scoped("spend") } }),
    );
    expect(wide.line("ledger key")).toMatch(/fail +ledger key/);
    expect(wide.line("ledger key")).toContain("not limited to anchor on the vault");
  });

  it("says not yet for a frozen vault, with the console's Overview", async () => {
    const r = await status(world({ config: { ...CONFIG, frozen: true } }));
    expect(r.code).toBe(1);
    expect(r.line("vault")).toMatch(/not yet +vault +the vault is frozen/);
    expect(r.out).toContain(
      `Next (vault): the vault's owner unfreezes it on the Overview tab of the vault's console (https://probarion.xyz/console/${VAULT}), or signs the transaction that probarion vault unfreeze --vault ${VAULT} prints.`,
    );
  });

  it("fails every chain check when the vault's config cannot be read, and asks nothing more", async () => {
    let asked = 0;
    const w = world({ config: new Error("account does not exist") });
    const chain = fakeChain(w);
    const counting: StatusChain = {
      ...chain,
      listAgents: () => {
        asked += 1;
        return chain.listAgents();
      },
      listMandates: () => {
        asked += 1;
        return chain.listMandates();
      },
    };
    const out = capture();
    const code = await runStatus([], {
      env: { PROBARION_VAULT_ID: VAULT },
      home: homeWithKeys(),
      out: out.stream,
      err: capture().stream,
      chain: () => counting,
      ledger: () => ({ all: async () => [] }),
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/fail +vault +get_config could not be read: account does not exist/);
    expect(out.text().match(/not checked: the vault could not be read/g)).toHaveLength(5);
    expect(asked).toBe(0);
    expect(out.text()).toContain(
      "Next (vault): check PROBARION_VAULT_ID (a vault on testnet) and NEAR_RPC_URLS.",
    );
  });

  it("says not yet when no active mandate with room is bound to the agent key, with the Mandates tab", async () => {
    const cases: [string, MandateView[]][] = [
      ["no mandate", []],
      ["another agent's", [{ ...MANDATE, agent_pk: OTHER.publicKey }]],
      ["revoked", [{ ...MANDATE, status: "revoked" }]],
      ["exhausted", [{ ...MANDATE, status: "exhausted" }]],
      ["expired", [{ ...MANDATE, expires_at_ns: "1700000000000000000" }]],
      ["no use left", [{ ...MANDATE, uses: 10 }]],
      ["no room left", [{ ...MANDATE, spent: "900000000", reserved: "100000000" }]],
      ["unreadable", [{ ...MANDATE, max_total: "lots" }]],
    ];
    for (const [why, mandates] of cases) {
      const r = await status(world({ mandates }));
      expect(r.code, why).toBe(1);
      expect(r.line("mandates"), why).toMatch(/not yet +mandates +no active mandate is bound/);
      expect(r.out, why).toContain(`https://probarion.xyz/console/${VAULT}/mandates`);
    }
    const two = await status(world({ mandates: [MANDATE, { ...MANDATE, id: 4 }] }));
    expect(two.line("mandates")).toContain("2 active mandates bound to the agent key (ids 3, 4)");
    const broken = await status(world({ mandates: new Error("timeout") }));
    expect(broken.line("mandates")).toMatch(/fail +mandates +list_mandates could not be read/);
  });

  it("says not yet for a vault with no USDC, with the Top-up tab, and fails an unreadable balance", async () => {
    const empty = await status(world({ balance: "0" }));
    expect(empty.code).toBe(1);
    expect(empty.line("USDC")).toMatch(/not yet +USDC +the vault holds no USDC/);
    expect(empty.out).toContain(`https://probarion.xyz/console/${VAULT}/topup`);
    const odd = await status(world({ balance: "-1" }));
    expect(odd.line("USDC")).toMatch(/fail +USDC +ft_balance_of did not answer an amount/);
    const down = await status(world({ balance: new Error("down") }));
    expect(down.line("USDC")).toMatch(/fail +USDC +ft_balance_of could not be read/);
  });

  it("fails the ledger when the latest anchor is not in the local file (the guard, run dry)", async () => {
    const short = await status(world({ ledger: signed(["l0"]) }));
    expect(short.code).toBe(1);
    expect(short.line("ledger")).toMatch(
      /fail +ledger +.*holds 1 entry\. LEDGER_FORK_RISK: anchor 2 covers 2 entries but the local ledger has 1/,
    );
    expect(short.out).toContain("Nothing was sent.");
    const forked = await status(world({ ledger: signed(["l0", "x1"]) }));
    expect(forked.line("ledger")).toContain(
      "LEDGER_FORK_RISK: anchor 2 does not match local entry 1",
    );
    const fresh = await status(world({ anchor: null, ledger: [] }));
    expect(fresh.code).toBe(0);
    expect(fresh.line("ledger")).toContain("holds 0 entries, and the vault has no anchor yet");
    const torn = await status(world({ ledger: new Error("line 3 is a torn write") }));
    expect(torn.line("ledger")).toMatch(
      /fail +ledger +.* could not be read: line 3 is a torn write/,
    );
    const anchors = await status(world({ anchor: new Error("down") }));
    expect(anchors.line("ledger")).toMatch(/fail +ledger +list_anchors could not be read/);
  });

  it("names a next step for a ledger fork and for a ledger or anchors it cannot read", async () => {
    const short = await status(world({ ledger: signed(["l0"]) }));
    expect(short.out).toContain(
      "Next (ledger): point PROBARION_LEDGER_PATH at the ledger file the vault's anchors cover, if it is on this machine, or give this server a vault of its own.",
    );
    const torn = await status(world({ ledger: new Error("line 3 is a torn write") }));
    expect(torn.out).toMatch(
      /Next \(ledger\): restore .* from a backup, or point PROBARION_LEDGER_PATH/,
    );
    const anchors = await status(world({ anchor: new Error("down") }));
    expect(anchors.out).toContain(
      "Next (ledger): run probarion-mcp status again; if it fails again, check NEAR_RPC_URLS.",
    );
  });

  it("fails a ledger whose entries after the last anchor another ledger key signed (a keys file swapped)", async () => {
    // The vault's ledger key is this keys file's; the old key signed every entry, two of them anchored.
    const r = await status(
      world({
        anchor: { seq: 1, root: "l1", count: 2, at_ns: "1", ledger_key: OTHER.publicKey },
        ledger: signed(["l0", "l1", "l2", "l3", "l4"], OTHER.publicKey),
      }),
    );
    expect(r.code).toBe(1);
    expect(r.line("ledger key")).toMatch(/^ {2}ok/);
    expect(r.line("ledger")).toMatch(
      /^ {2}fail {5}ledger +.*holds 5 entries\. LEDGER_KEY_MISMATCH: /,
    );
    expect(r.line("ledger")).toContain(
      "3 of the 3 unanchored entries in the local ledger (after anchor 1) are signed by another ledger key",
    );
    expect(r.out).not.toContain("Ready");
    expect(r.out).toContain(
      `Next (ledger): the vault's owner sets the key that signed them back as the vault's ledger key (probarion ledger set-key --vault ${VAULT} --pk ${OTHER.publicKey})`,
    );
    // Entries the anchors cover may be another key's: only the tail must be this server's.
    const rotated = await status(
      world({
        anchor: { seq: 1, root: "l1", count: 2, at_ns: "1", ledger_key: OTHER.publicKey },
        ledger: [...signed(["l0", "l1"], OTHER.publicKey), ...signed(["l2"])],
      }),
    );
    expect(rotated.code).toBe(0);
    // With no anchor at all, every entry must be this server's.
    const fresh = await status(world({ anchor: null, ledger: signed(["l0"], OTHER.publicKey) }));
    expect(fresh.line("ledger")).toContain("(the vault has no anchor yet)");
    expect(fresh.code).toBe(1);
  });

  it("before a ledger key rotation, says to anchor the entries the vault's current key signed", async () => {
    const r = await status(
      world({
        config: { ...CONFIG, ledger_key: OTHER.publicKey },
        keys: { [AGENT.publicKey]: scoped("spend"), [OTHER.publicKey]: scoped("anchor") },
        anchor: { seq: 2, root: "l1", count: 2, at_ns: "1", ledger_key: OTHER.publicKey },
        ledger: signed(["l0", "l1", "l2"], OTHER.publicKey),
      }),
    );
    expect(r.code).toBe(1);
    expect(r.line("ledger key")).toMatch(/^ {2}not yet/);
    expect(r.line("ledger key")).toContain(
      `the vault's ledger key is another key, ${OTHER.publicKey}, which signed 1 entry of this ledger after the vault's last anchor`,
    );
    expect(r.line("ledger")).toMatch(/^ {2}not yet {2}ledger +.*LEDGER_KEY_MISMATCH/);
    expect(r.out).toContain(
      `Next (ledger key): anchor those entries with ${OTHER.publicKey} first (the server that holds it anchors its ledger at the end of its next request_spend), then the vault's owner signs the transaction that probarion ledger set-key --vault ${VAULT} --pk ${LEDGER.publicKey} prints`,
    );
  });

  it("does not advise a new ledger key for a vault another process anchors from its own ledger", async () => {
    const r = await status(
      world({
        config: { ...CONFIG, ledger_key: OTHER.publicKey },
        anchor: { seq: 7, root: "x9", count: 10, at_ns: "1", ledger_key: OTHER.publicKey },
        ledger: [],
      }),
    );
    expect(r.code).toBe(1);
    expect(r.line("ledger key")).toMatch(/^ {2}fail {5}ledger key/);
    expect(r.line("ledger key")).toContain(
      "the ledger its anchors cover is not this machine's ledger file",
    );
    expect(r.line("ledger")).toContain(
      "LEDGER_FORK_RISK: anchor 7 covers 10 entries but the local ledger has 0",
    );
    expect(r.out).not.toContain("probarion ledger set-key");
    expect(r.out).toContain(
      "Next (ledger key): point PROBARION_LEDGER_PATH at the ledger file the vault's anchors cover",
    );
  });

  it("names a vault it cannot read as the next step, before the keys", async () => {
    const r = await status(world({ config: new Error("UNKNOWN_ACCOUNT") }), {
      home: tempDir("probarion-status-empty-"),
    });
    expect(r.line("keys")).toMatch(/not yet +keys/);
    expect(r.out).toContain(
      "Next (vault): check PROBARION_VAULT_ID (a vault on testnet) and NEAR_RPC_URLS.",
    );
    expect(r.out).not.toContain("Next (keys)");
  });

  it("names a next step for an agent key that is not limited to spend", async () => {
    const r = await status(
      world({ keys: { [AGENT.publicKey]: "FullAccess", [LEDGER.publicKey]: scoped("anchor") } }),
    );
    expect(r.out).toContain(
      `Next (agent key): the vault's owner signs the transactions that probarion agent remove --vault ${VAULT} --pk ${AGENT.publicKey} and then probarion agent add --vault ${VAULT} --pk ${AGENT.publicKey} print`,
    );
  });

  it("on mainnet gives the CLI's transactions and says the console does not serve mainnet yet", async () => {
    const vault = "acme.vaults.probarion.near";
    const opts = { env: { PROBARION_VAULT_ID: vault }, home: homeWithKeys(vault, "mainnet") };
    const mainnetConfig = { ...CONFIG, usdc: "usdc.example.near" };
    const mainnetKeys = {
      [AGENT.publicKey]: { ...scoped("spend"), receiver_id: vault },
      [LEDGER.publicKey]: { ...scoped("anchor"), receiver_id: vault },
    };
    const world_ = (over: Partial<World>) =>
      world({ config: mainnetConfig, keys: mainnetKeys, ...over });
    expect((await status(world_({}), opts)).code).toBe(0);
    const keys = await status(world_({ agents: [] }), opts);
    expect(keys.code).toBe(1);
    expect(keys.out).toContain(`vault ${vault} on mainnet`);
    expect(keys.out).toContain(
      `Next (agent key): the vault's owner signs the transaction that probarion agent add --vault ${vault} --pk ${AGENT.publicKey} prints (the console does not serve mainnet yet).`,
    );
    const frozen = await status(world_({ config: { ...mainnetConfig, frozen: true } }), opts);
    expect(frozen.out).toContain(
      `Next (vault): the vault's owner signs the transaction that probarion vault unfreeze --vault ${vault} prints (the console does not serve mainnet yet).`,
    );
    const mandates = await status(world_({ mandates: [] }), opts);
    expect(mandates.out).toContain(
      `Next (mandates): the vault's owner signs the transaction that probarion mandate create --vault ${vault} --agent-pk ${AGENT.publicKey}`,
    );
    const empty = await status(world_({ balance: "0" }), opts);
    expect(empty.out).toContain(
      `Next (USDC): the vault's owner sends USDC to ${vault} from their wallet: a storage_deposit for the vault (registration only) and an ft_transfer to it, both on usdc.example.near (the console does not serve mainnet yet).`,
    );
    for (const r of [keys, frozen, mandates, empty]) {
      expect(r.out).not.toMatch(/https?:\/\//);
      expect(r.out).not.toContain("site that serves mainnet");
    }
  });

  it("exits 2 on a configuration error, naming it on stderr with nothing on stdout", async () => {
    for (const env of [
      {},
      { PROBARION_VAULT_ID: "../x.testnet" },
      { PROBARION_VAULT_ID: VAULT, PROBARION_AGENT_KEY: AGENT.secretKey },
      { PROBARION_VAULT_ID: VAULT, PROBARION_KEYS_FILE: "/no/such/keys.json" },
    ]) {
      const r = await status(world(), { env, home: tempDir("probarion-status-empty-") });
      expect(r.code, JSON.stringify(Object.keys(env))).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toContain("probarion-mcp status: invalid configuration");
    }
    const bad = await status(world(), { args: ["--vault", VAULT] });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown argument");
    expect((await status(world(), { args: ["--help"] })).out).toBe(STATUS_HELP);
  });
});

describe("probarion-mcp status over the SDK's readers", () => {
  it("is reached through the binary's arguments", async () => {
    const out = capture();
    const code = await runCommand(["status", "--help"], {
      env: {},
      out: out.stream,
      err: capture().stream,
    });
    expect(code).toBe(0);
    expect(out.text()).toBe(STATUS_HELP);
  });

  let rpc: FakeRpcServer | undefined;
  afterEach(async () => {
    await rpc?.close();
    rpc = undefined;
  });

  it("reads the scenario vault through RpcClient and VaultClient and finds it ready", async () => {
    const chain = createScenarioChain();
    chain.ftBalances[chain.config.usdc] = { [SCENARIO_VAULT]: "5000000" };
    rpc = await startFakeRpcServer(chain);
    const home = tempDir("probarion-status-sdk-");
    mkdirSync(join(home, ".probarion", SCENARIO_VAULT), { recursive: true });
    writeFileSync(
      join(home, ".probarion", SCENARIO_VAULT, "keys.json"),
      keysFileText(SCENARIO_VAULT, "testnet", {}, TEST_KEYS.agent, TEST_KEYS.ledger),
      { mode: 0o600 },
    );
    const out = capture();
    const err = capture();
    // No chain or ledger seam: the SDK's readers over the fake RPC server, and the ledger file in the home.
    const code = await runStatus([], {
      env: { PROBARION_VAULT_ID: SCENARIO_VAULT, NEAR_RPC_URLS: rpc.url },
      out: out.stream,
      err: err.stream,
      home,
      now: () => new Date(Number(SCENARIO_NOW / 1_000_000n)),
    });
    expect(err.text()).toBe("");
    expect(out.text()).toContain("ok       agent key");
    expect(out.text()).toContain("ok       ledger key");
    expect(out.text()).toContain("2 active mandates bound to the agent key (ids 1, 2)");
    expect(out.text()).toContain("5.00 USDC in the vault");
    expect(out.text()).toContain("holds 0 entries, and the vault has no anchor yet");
    expect(code).toBe(0);
    expectNoSecret(out.text(), [TEST_KEYS.agent.secretKey, TEST_KEYS.ledger.secretKey]);
    // Only view calls: no transaction was sent.
    expect(rpc.methods.every((m) => m === "query")).toBe(true);
  });
});
