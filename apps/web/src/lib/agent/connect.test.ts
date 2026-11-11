import { formatPublicKey, formatSignature } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { addAgentTx, setLedgerKeyTx } from "@/lib/near/tx";
import {
  agentEligibility,
  agentList,
  checkPastedPair,
  cleanAgentLabel,
  clientConfigs,
  focusAgent,
  initLines,
  KEY_ERRORS,
  ledgerEligibility,
  looksLikeSecret,
  MAX_AGENTS,
  MCP_ON_NPM,
  type OutsideKey,
  parsePastedKey,
  type StatusInput,
  serverCommand,
  shortKey,
  statusCommand,
  statusRows,
  stepsLeft,
  type VaultKeyFacts,
} from "./connect";

// The Agent (MCP) tab's rules, shared by the browser and the two server actions: what a pasted key is, whether each
// key may go on the vault, and the lines the page shows. A vault has one ledger, so the ledger key is withheld from a
// vault whose ledger another writer keeps.

/** A well-formed public key, from one repeated byte (no real key is in this file). */
const pk = (n: number) => formatPublicKey(new Uint8Array(32).fill(n));
/** Something shaped like a NEAR secret key: `ed25519:` and 64 bytes of base58. */
const SECRET = formatSignature(new Uint8Array(64).fill(7));
const SECRET_BODY = SECRET.slice("ed25519:".length);

const AGENT = pk(1);
const LEDGER = pk(2);
const OTHER = pk(3);
const HOSTED = pk(4);

const EMPTY: VaultKeyFacts = {
  agents: [],
  ledgerKey: null,
  firstAnchorSigner: null,
  hostedKeys: [],
  hostedLedgerActive: false,
  hostedLedgerEntries: 0,
};
const facts = (over: Partial<VaultKeyFacts> = {}): VaultKeyFacts => ({ ...EMPTY, ...over });

describe("parsePastedKey", () => {
  it("takes a public key, with the spaces around it dropped", () => {
    expect(parsePastedKey(AGENT)).toEqual({ ok: true, key: AGENT });
    expect(parsePastedKey(`  ${AGENT}\n`)).toEqual({ ok: true, key: AGENT });
  });

  it.each([
    ["no prefix", AGENT.slice("ed25519:".length)],
    ["another curve", AGENT.replace("ed25519:", "secp256k1:")],
    ["too short", AGENT.slice(0, 30)],
    ["not base58", `ed25519:${"0".repeat(44)}`],
    ["a word", "hello"],
  ])("refuses %s as not a public key", (_name, raw) => {
    expect(parsePastedKey(raw)).toEqual({
      ok: false,
      error: KEY_ERRORS.notPublic,
      secret: false,
      empty: false,
    });
  });

  it("asks for the key when nothing was pasted", () => {
    expect(parsePastedKey("   ")).toMatchObject({
      ok: false,
      error: KEY_ERRORS.empty,
      empty: true,
    });
  });

  it("refuses anything but text", () => {
    expect(parsePastedKey(undefined)).toMatchObject({ ok: false, error: KEY_ERRORS.notPublic });
    expect(parsePastedKey({ key: AGENT })).toMatchObject({
      ok: false,
      error: KEY_ERRORS.notPublic,
    });
  });

  it.each([
    ["a secret key", SECRET],
    ["a secret key without its prefix", SECRET_BODY],
    ["a keys file", JSON.stringify({ agent: { public_key: AGENT, secret_key: SECRET } })],
  ])("recognises %s as a secret, and the error repeats none of it", (_name, raw) => {
    const r = parsePastedKey(raw);
    expect(r).toEqual({ ok: false, error: KEY_ERRORS.secret, secret: true, empty: false });
    expect(JSON.stringify(r)).not.toContain(SECRET_BODY.slice(10, 40));
    expect(looksLikeSecret(raw)).toBe(true);
  });

  it("does not take a public key for a secret", () => {
    expect(looksLikeSecret(AGENT)).toBe(false);
    expect(looksLikeSecret(`${AGENT} ${LEDGER}`)).toBe(false);
  });
});

describe("agentEligibility", () => {
  it.each<[string, Partial<VaultKeyFacts>, ReturnType<typeof agentEligibility>]>([
    ["adds a new key to an empty vault", {}, { kind: "add" }],
    [
      "is done when the key is already listed, with its label",
      { agents: [{ public_key: AGENT, label: "mcp-claude" }] },
      { kind: "on_vault", label: "mcp-claude" },
    ],
    [
      "refuses a key Probarion made for hosted Payables",
      { hostedKeys: [AGENT] },
      { kind: "blocked", reason: "hosted", error: KEY_ERRORS.hosted },
    ],
    [
      "refuses the vault's ledger key (the contract refuses a key that is both)",
      { ledgerKey: AGENT },
      { kind: "blocked", reason: "is_ledger_key", error: KEY_ERRORS.agentIsLedger },
    ],
    [
      "refuses a 17th key",
      {
        agents: Array.from({ length: MAX_AGENTS }, (_, i) => ({
          public_key: pk(100 + i),
          label: "x",
        })),
      },
      { kind: "blocked", reason: "full", error: KEY_ERRORS.full },
    ],
  ])("%s", (_name, over, expected) => {
    expect(agentEligibility(facts(over), AGENT)).toEqual(expected);
  });

  it("still adds a 16th key, and a key already listed on a full vault is done, not refused", () => {
    const fifteen = Array.from({ length: MAX_AGENTS - 1 }, (_, i) => ({
      public_key: pk(100 + i),
      label: "x",
    }));
    expect(agentEligibility(facts({ agents: fifteen }), AGENT)).toEqual({ kind: "add" });
    const full = [...fifteen, { public_key: AGENT, label: "mine" }];
    expect(agentEligibility(facts({ agents: full }), AGENT)).toEqual({
      kind: "on_vault",
      label: "mine",
    });
    expect(MAX_AGENTS).toBe(16);
  });
});

describe("ledgerEligibility", () => {
  it.each<[string, Partial<VaultKeyFacts>, ReturnType<typeof ledgerEligibility>]>([
    ["sets the key on a vault with no ledger key and no anchor", {}, { kind: "set" }],
    ["is done when the key is already the vault's", { ledgerKey: LEDGER }, { kind: "same" }],
    [
      "is done when the key is the vault's and signed its anchors",
      { ledgerKey: LEDGER, firstAnchorSigner: LEDGER },
      { kind: "same" },
    ],
    [
      "replaces another ledger key that never anchored",
      { ledgerKey: OTHER },
      { kind: "replace", current: OTHER },
    ],
    [
      "withholds the key from a vault anchored by another key",
      { ledgerKey: OTHER, firstAnchorSigner: OTHER },
      { kind: "blocked", reason: "anchors" },
    ],
    [
      "withholds it when the anchors were signed by an older key, even if the vault names this one now",
      { ledgerKey: LEDGER, firstAnchorSigner: OTHER },
      { kind: "blocked", reason: "anchors" },
    ],
    [
      "withholds it from a vault whose hosted ledger has entries",
      { hostedLedgerEntries: 12 },
      { kind: "blocked", reason: "hosted_entries" },
    ],
    [
      "withholds it while hosted Payables holds an active ledger key",
      { hostedLedgerActive: true },
      { kind: "blocked", reason: "hosted_active" },
    ],
    [
      "withholds it when the vault's ledger key is one Probarion made",
      { ledgerKey: HOSTED, hostedKeys: [HOSTED] },
      { kind: "blocked", reason: "hosted_key" },
    ],
    [
      "refuses a key Probarion made",
      { hostedKeys: [LEDGER] },
      { kind: "error", error: KEY_ERRORS.hosted },
    ],
    [
      "refuses a key that is on the vault as an agent key",
      { agents: [{ public_key: LEDGER, label: "x" }] },
      { kind: "error", error: KEY_ERRORS.ledgerIsAgent },
    ],
  ])("%s", (_name, over, expected) => {
    expect(ledgerEligibility(facts(over), LEDGER)).toEqual(expected);
  });
});

describe("checkPastedPair", () => {
  const form = (agent: string, ledger: string, label = "mcp-claude") => ({ agent, ledger, label });

  it("accepts two different public keys for an empty vault", () => {
    expect(checkPastedPair(EMPTY, form(AGENT, LEDGER))).toEqual({
      ok: true,
      agentKey: AGENT,
      ledgerKey: LEDGER,
      label: "mcp-claude",
      agent: { kind: "add" },
      ledger: { kind: "set" },
    });
  });

  it("refuses the same key twice, under the ledger field", () => {
    expect(checkPastedPair(EMPTY, form(AGENT, AGENT))).toEqual({
      ok: false,
      agentError: null,
      ledgerError: KEY_ERRORS.same,
      labelError: null,
      secret: false,
    });
  });

  it("flags a pasted secret, so the page sends nothing", () => {
    const r = checkPastedPair(EMPTY, form(AGENT, SECRET));
    expect(r).toMatchObject({ ok: false, ledgerError: KEY_ERRORS.secret, secret: true });
    expect(JSON.stringify(r)).not.toContain(SECRET_BODY.slice(10, 40));
  });

  it("says what is wrong with each field at once", () => {
    expect(checkPastedPair(EMPTY, form("", "nope", "x".repeat(65)))).toMatchObject({
      ok: false,
      agentError: KEY_ERRORS.empty,
      ledgerError: KEY_ERRORS.notPublic,
      labelError: expect.any(String),
    });
  });

  it("refuses a key as the label: the label is public on the vault (list_agents)", () => {
    // A secret pasted into a field cut at 64 characters: ed25519: and 56 base58 characters, which narrow its seed
    // to a couple of candidates.
    const cut = SECRET.slice(0, 64);
    for (const raw of [
      cut,
      SECRET,
      SECRET_BODY,
      cut.slice("ed25519:".length),
      AGENT,
      `my ${AGENT}`,
    ]) {
      const r = checkPastedPair(EMPTY, form(AGENT, LEDGER, raw));
      expect(r).toMatchObject({ ok: false, labelError: KEY_ERRORS.labelIsKey });
      expect(JSON.stringify(r)).not.toContain(SECRET_BODY.slice(10, 40));
      expect(cleanAgentLabel(raw)).toEqual({ ok: false, error: KEY_ERRORS.labelIsKey });
    }
    // A whole secret in the label is flagged as one, like a secret in a key field.
    expect(checkPastedPair(EMPTY, form(AGENT, LEDGER, SECRET))).toMatchObject({ secret: true });
    // Names stay names, a long one included.
    for (const name of [
      "mcp-claude",
      "Claude Code on my laptop",
      "research-bot.vaults.probarion.testnet",
    ]) {
      expect(cleanAgentLabel(name)).toEqual({ ok: true, value: name });
    }
    // Too long, and no key in it: the byte limit says so.
    expect(cleanAgentLabel("a-".repeat(40))).toEqual({
      ok: false,
      error: "The label is at most 64 bytes.",
    });
  });

  it("names a blank label mcp", () => {
    expect(checkPastedPair(EMPTY, form(AGENT, LEDGER, "  "))).toMatchObject({
      ok: true,
      label: "mcp",
    });
  });

  it("puts the vault's answers under the fields: a hosted agent key, a ledger key on the vault as an agent key", () => {
    expect(checkPastedPair(facts({ hostedKeys: [AGENT] }), form(AGENT, LEDGER))).toMatchObject({
      ok: false,
      agentError: KEY_ERRORS.hosted,
      ledgerError: null,
    });
    const agents = [{ public_key: LEDGER, label: "x" }];
    expect(checkPastedPair(facts({ agents }), form(AGENT, LEDGER))).toMatchObject({
      ok: false,
      agentError: null,
      ledgerError: KEY_ERRORS.ledgerIsAgent,
    });
  });

  it("passes a vault that keeps its ledger elsewhere, so the agent key can still be added", () => {
    expect(checkPastedPair(facts({ hostedLedgerEntries: 3 }), form(AGENT, LEDGER))).toMatchObject({
      ok: true,
      agent: { kind: "add" },
      ledger: { kind: "blocked", reason: "hosted_entries" },
    });
  });

  it("passes keys already on the vault as done", () => {
    const done = facts({ agents: [{ public_key: AGENT, label: "mcp-claude" }], ledgerKey: LEDGER });
    expect(checkPastedPair(done, form(AGENT, LEDGER))).toMatchObject({
      ok: true,
      agent: { kind: "on_vault", label: "mcp-claude" },
      ledger: { kind: "same" },
    });
  });
});

describe("agentList", () => {
  it("reads list_agents, keeping labels as text", () => {
    expect(
      agentList([{ public_key: AGENT, label: "a", added_at_ns: "1" }, { public_key: LEDGER }]),
    ).toEqual([
      { public_key: AGENT, label: "a" },
      { public_key: LEDGER, label: "" },
    ]);
  });

  it("is null for anything that is not a list of keys", () => {
    expect(agentList(null)).toBeNull();
    expect(agentList("x")).toBeNull();
    expect(agentList([{ label: "no key" }])).toBeNull();
    expect(agentList([null])).toBeNull();
  });
});

describe("the transactions the two actions return", () => {
  it("have the same shape for a testnet vault and a .near vault: only the receiver differs", () => {
    for (const vault of ["acme.vaults.probarion.testnet", "acme.vaults.probarion.near"]) {
      const add = addAgentTx(vault, AGENT, "1000000000000000000000000", "mcp-claude");
      const set = setLedgerKeyTx(vault, LEDGER, "250000000000000000000000");
      expect(add.receiverId).toBe(vault);
      expect(set.receiverId).toBe(vault);
      expect(add.actions).toHaveLength(1);
      expect(set.actions).toHaveLength(1);
      expect(JSON.stringify(add.actions)).toContain('"add_agent"');
      expect(JSON.stringify(set.actions)).toContain('"set_ledger_key"');
    }
    const strip = (t: { receiverId: string }) => JSON.stringify({ ...t, receiverId: "" });
    expect(strip(addAgentTx("a.testnet", AGENT, "1", "l"))).toBe(
      strip(addAgentTx("a.near", AGENT, "1", "l")),
    );
    expect(strip(setLedgerKeyTx("a.testnet", LEDGER, "1"))).toBe(
      strip(setLedgerKeyTx("a.near", LEDGER, "1")),
    );
  });
});

describe("the lines the page shows", () => {
  const VAULT = "research-bot.vaults.probarion.testnet";

  it("shows the npx forms by default, since @probarion/mcp 0.1.1 is on npm", () => {
    expect(MCP_ON_NPM).toBe(true);
    expect(serverCommand()).toBe("npx -y @probarion/mcp@0.1.1");
    expect(initLines(VAULT, "testnet")).toEqual(initLines(VAULT, "testnet", true));
    expect(statusCommand(VAULT, "testnet")).toEqual(statusCommand(VAULT, "testnet", true));
    expect(clientConfigs(VAULT, "testnet")).toEqual(clientConfigs(VAULT, "testnet", true));
  });

  it("makes the keys with one npx line once the server is on npm", () => {
    expect(initLines(VAULT, "testnet", true)).toEqual({
      lines: [`npx -y @probarion/mcp@0.1.1 init --vault ${VAULT}`],
      powershell: null,
    });
  });

  it("builds the server from a clone, one command per line, until then", () => {
    expect(initLines(VAULT, "testnet", false)).toEqual({
      lines: [
        "git clone https://github.com/probarion/probarion",
        "cd probarion",
        "pnpm install --frozen-lockfile",
        'pnpm --filter "@probarion/mcp..." run build',
        `node packages/mcp/dist/bin.js init --vault ${VAULT}`,
      ],
      powershell: null,
    });
  });

  it("runs status with the vault in its environment, in a POSIX shell and in PowerShell", () => {
    expect(statusCommand(VAULT, "testnet", true)).toEqual({
      posix: `PROBARION_VAULT_ID=${VAULT} npx -y @probarion/mcp@0.1.1 status`,
      powershell: `$env:PROBARION_VAULT_ID = "${VAULT}"; npx -y @probarion/mcp@0.1.1 status`,
    });
    expect(statusCommand(VAULT, "testnet", false).posix).toBe(
      `PROBARION_VAULT_ID=${VAULT} node packages/mcp/dist/bin.js status`,
    );
  });

  it("sets NEAR_NETWORK for init and status too, under the client settings' rule", () => {
    // init and status refuse a vault id that does not say its network unless NEAR_NETWORK is set.
    for (const onNpm of [true, false]) {
      const run = onNpm ? "npx -y @probarion/mcp@0.1.1" : "node packages/mcp/dist/bin.js";
      const init = initLines("vault.example", "mainnet", onNpm);
      expect(init.lines.at(-1)).toBe(`NEAR_NETWORK=mainnet ${run} init --vault vault.example`);
      expect(init.powershell).toBe(
        `$env:NEAR_NETWORK = "mainnet"; ${run} init --vault vault.example`,
      );
      expect(statusCommand("vault.example", "mainnet", onNpm)).toEqual({
        posix: `PROBARION_VAULT_ID=vault.example NEAR_NETWORK=mainnet ${run} status`,
        powershell: `$env:PROBARION_VAULT_ID = "vault.example"; $env:NEAR_NETWORK = "mainnet"; ${run} status`,
      });
      // A .near or .testnet vault says its network itself.
      for (const [vault, network] of [
        [VAULT, "testnet"],
        ["acme.vaults.probarion.near", "mainnet"],
      ] as const) {
        expect(initLines(vault, network, onNpm).lines.join("\n")).not.toContain("NEAR_NETWORK");
        expect(initLines(vault, network, onNpm).powershell).toBeNull();
        expect(JSON.stringify(statusCommand(vault, network, onNpm))).not.toContain("NEAR_NETWORK");
      }
    }
  });

  it("gives every client a Windows form, in both states of MCP_ON_NPM", () => {
    for (const onNpm of [true, false]) {
      for (const c of clientConfigs(VAULT, "testnet", onNpm)) {
        expect(c.windows, `${c.label} onNpm=${onNpm}`).not.toBeNull();
      }
    }
    // npx is a batch file on Windows: Cursor and Codex start it through cmd /c too (packages/mcp/README.md).
    const npx = clientConfigs(VAULT, "testnet", true);
    expect(npx[2]?.windows).toBe(npx[1]?.windows);
    expect(npx[2]?.windows).toBe(
      'On Windows: `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@probarion/mcp@0.1.1"]`.',
    );
    expect(npx[3]?.windows).toBe(
      'On Windows: `command = "cmd"` and `args = ["/c", "npx", "-y", "@probarion/mcp@0.1.1"]`.',
    );
    // From a clone, node starts as it is: only the path's slashes change.
    const clone = clientConfigs(VAULT, "testnet", false);
    expect(clone[2]?.windows).toBe(clone[1]?.windows);
    expect(clone[3]?.windows).toContain("C:/path/to/probarion/packages/mcp/dist/bin.js");
  });

  it("gives the four clients, with the mockup's npx forms", () => {
    const c = clientConfigs(VAULT, "testnet", true);
    expect(c.map((x) => x.label)).toEqual(["Claude Code", "Claude Desktop", "Cursor", "Codex"]);
    expect(c[0]?.code).toBe(
      [
        "claude mcp add probarion \\",
        `  -e PROBARION_VAULT_ID=${VAULT} \\`,
        "  -- npx -y @probarion/mcp@0.1.1",
      ].join("\n"),
    );
    expect(c[0]?.windowsCode).toBe(
      `claude mcp add probarion -e PROBARION_VAULT_ID=${VAULT} -- cmd /c npx -y @probarion/mcp@0.1.1`,
    );
    const json = [
      "{",
      '  "mcpServers": {',
      '    "probarion": {',
      '      "command": "npx",',
      '      "args": ["-y", "@probarion/mcp@0.1.1"],',
      `      "env": { "PROBARION_VAULT_ID": "${VAULT}" }`,
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(c[1]?.code).toBe(json);
    expect(c[2]?.code).toBe(json);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        probarion: {
          command: "npx",
          args: ["-y", "@probarion/mcp@0.1.1"],
          env: { PROBARION_VAULT_ID: VAULT },
        },
      },
    });
    expect(c[1]?.windows).toBe(
      'On Windows: `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@probarion/mcp@0.1.1"]`.',
    );
    expect(c[3]?.code).toBe(
      [
        "[mcp_servers.probarion]",
        'command = "npx"',
        'args = ["-y", "@probarion/mcp@0.1.1"]',
        `env = { PROBARION_VAULT_ID = "${VAULT}" }`,
      ].join("\n"),
    );
  });

  it("points every client at the clone's built server while it is not on npm, with a path to fill in", () => {
    const c = clientConfigs(VAULT, "testnet", false);
    for (const x of c) {
      expect(x.code).toContain("/path/to/probarion/packages/mcp/dist/bin.js");
      expect(x.code).not.toContain("npx");
    }
    expect(JSON.parse(c[1]?.code ?? "")).toEqual({
      mcpServers: {
        probarion: {
          command: "node",
          args: ["/path/to/probarion/packages/mcp/dist/bin.js"],
          env: { PROBARION_VAULT_ID: VAULT },
        },
      },
    });
    expect(c[0]?.windowsCode).toBe(
      `claude mcp add probarion -e PROBARION_VAULT_ID=${VAULT} -- node C:/path/to/probarion/packages/mcp/dist/bin.js`,
    );
  });

  it("carries only the vault id: no key, no secret, no other setting", () => {
    for (const onNpm of [true, false]) {
      for (const vault of [VAULT, "acme.vaults.probarion.near"]) {
        for (const x of clientConfigs(
          vault,
          vault.endsWith(".near") ? "mainnet" : "testnet",
          onNpm,
        )) {
          const all = [x.code, x.windowsCode ?? "", x.where ?? "", x.windows ?? ""].join("\n");
          expect(all).toContain(`PROBARION_VAULT_ID`);
          expect(all).not.toMatch(/PROBARION_(AGENT|LEDGER)_KEY|NEAR_NETWORK|ed25519:/);
        }
      }
    }
  });

  it("adds NEAR_NETWORK only for a vault whose name does not say its network", () => {
    const c = clientConfigs("vault.example", "mainnet", true);
    expect(c[0]?.code).toContain("-e NEAR_NETWORK=mainnet");
    expect(JSON.parse(c[1]?.code ?? "").mcpServers.probarion.env).toEqual({
      PROBARION_VAULT_ID: "vault.example",
      NEAR_NETWORK: "mainnet",
    });
  });

  it("shortens a key to its prefix, six characters, and the last six", () => {
    expect(shortKey(AGENT)).toBe(`${AGENT.slice(0, 14)}...${AGENT.slice(-6)}`);
    expect(shortKey("short")).toBe("short");
  });
});

describe("the status card", () => {
  const outside = (
    public_key: string,
    access: OutsideKey["access"],
    label = "mcp",
  ): OutsideKey => ({
    public_key,
    label,
    access,
  });
  const scoped = (allowanceYocto: string | null) => ({ state: "scoped" as const, allowanceYocto });
  const input = (over: Partial<StatusInput> = {}): StatusInput => ({
    vault: "v.testnet",
    testnet: true,
    facts: EMPTY,
    outsideAgents: [],
    outsideLedger: null,
    activeMandateKeys: [],
    usdc: "0",
    pasted: null,
    ...over,
  });
  const byId = (i: StatusInput) => Object.fromEntries(statusRows(i).map((r) => [r.id, r]));

  it("starts a new vault with every step to do, and its ledger on the agent's machine", () => {
    const rows = byId(input());
    expect(rows.agent).toMatchObject({ text: "None yet", badge: "step 3", tone: "warn" });
    expect(rows.ledger).toMatchObject({ text: "The vault has no ledger key yet", badge: "step 3" });
    expect(rows.mandate).toMatchObject({ text: "None yet", badge: "step 4" });
    expect(rows.usdc).toMatchObject({ text: "None yet", badge: "step 4" });
    expect(rows.history).toMatchObject({ badge: "on your machine", tone: "neutral" });
    expect(stepsLeft(statusRows(input()))).toBe(4);
  });

  it("is ready once both keys are on, a mandate is bound and the vault holds USDC", () => {
    const i = input({
      facts: facts({ agents: [{ public_key: AGENT, label: "mcp" }], ledgerKey: LEDGER }),
      outsideAgents: [outside(AGENT, scoped("1000000000000000000000000"))],
      outsideLedger: outside(LEDGER, scoped("250000000000000000000000"), ""),
      activeMandateKeys: [AGENT],
      usdc: "25000000",
    });
    const rows = byId(i);
    expect(rows.agent).toMatchObject({ badge: "ready", tone: "good" });
    expect(rows.agent?.text).toContain("spend() only, 1.000 NEAR gas left");
    expect(rows.ledger?.text).toContain("anchor() only, 0.250 NEAR gas left");
    expect(rows.mandate).toMatchObject({ text: "1 active mandate", badge: "ready" });
    expect(rows.usdc).toMatchObject({ text: "25.00 test USDC", badge: "ready" });
    expect(stepsLeft(statusRows(i))).toBe(0);
  });

  it("says USDC on mainnet, not test USDC", () => {
    expect(byId(input({ testnet: false, usdc: "1000000" })).usdc?.text).toBe("1.00 USDC");
  });

  it("flags a key with no gas left, an unlimited key, and a key whose access key is not the one the vault adds", () => {
    const row = (access: OutsideKey["access"]) =>
      byId(input({ outsideAgents: [outside(AGENT, access)] })).agent;
    expect(row(scoped("0"))).toMatchObject({ badge: "no gas", tone: "bad" });
    expect(row(scoped(null))).toMatchObject({ badge: "check", tone: "bad" });
    expect(row({ state: "missing" })).toMatchObject({ badge: "check", tone: "bad" });
    expect(row({ state: "wrong_scope" })).toMatchObject({ badge: "check", tone: "bad" });
    expect(row({ state: "unavailable" })).toMatchObject({ badge: "unavailable", tone: "warn" });
  });

  it("speaks of the pasted key, and of the one outside key when nothing was pasted", () => {
    const two = [outside(AGENT, scoped("1")), outside(OTHER, scoped("1"))];
    expect(focusAgent({ outsideAgents: two, pasted: null })).toBeNull();
    expect(focusAgent({ outsideAgents: two, pasted: { agentKey: OTHER, ledgerKey: LEDGER } })).toBe(
      OTHER,
    );
    expect(focusAgent({ outsideAgents: [two[0] as OutsideKey], pasted: null })).toBe(AGENT);
    expect(
      focusAgent({ outsideAgents: two, pasted: { agentKey: pk(9), ledgerKey: LEDGER } }),
    ).toBeNull();
    expect(byId(input({ outsideAgents: two })).agent).toMatchObject({ badge: "2 keys" });
  });

  it("names a hosted ledger key and a pasted ledger key that is not the vault's", () => {
    expect(
      byId(input({ facts: facts({ ledgerKey: HOSTED, hostedKeys: [HOSTED] }) })).ledger,
    ).toMatchObject({ badge: "hosted", tone: "bad" });
    expect(
      byId(
        input({
          facts: facts({ ledgerKey: OTHER }),
          outsideLedger: outside(OTHER, scoped("1"), ""),
          pasted: { agentKey: AGENT, ledgerKey: LEDGER },
        }),
      ).ledger,
    ).toMatchObject({ badge: "step 3", tone: "warn" });
  });

  it("says hosted Payables keeps a hosted ledger, and never reads a failed read as none", () => {
    expect(byId(input({ facts: facts({ hostedLedgerEntries: 1 }) })).history?.text).toBe(
      "Kept by Probarion's hosted Payables (1 entry)",
    );
    const down = byId(input({ activeMandateKeys: null, usdc: null }));
    expect(down.mandate).toMatchObject({ badge: "unavailable" });
    expect(down.usdc).toMatchObject({ badge: "unavailable" });
  });
});
