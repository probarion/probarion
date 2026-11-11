import { formatPublicKey } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutsideKey, VaultKeyFacts } from "@/lib/agent/connect";
import { removeAgentTx, type WalletTx } from "@/lib/near/tx";

// The Agent (MCP) tab's client part, rendered as the server sends it: the owner's six steps or a viewer's status card,
// the two states of MCP_ON_NPM, and the one property that matters most: no snippet carries a key or a secret, only the
// vault id.

type Captured = {
  label: string;
  tx?: WalletTx;
  confirm?: string;
  confirmTone?: string;
  lockKey?: string;
};
const h = vi.hoisted(() => ({ buttons: [] as Captured[] }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: Captured) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));

import { ConnectAgentPanel, type ConnectAgentPanelProps } from "./ConnectAgentPanel";

const VAULT = "research-bot.vaults.probarion.testnet";
const AGENT = formatPublicKey(new Uint8Array(32).fill(21));
const EMPTY: VaultKeyFacts = {
  agents: [],
  ledgerKey: null,
  firstAnchorSigner: null,
  hostedKeys: [],
  hostedLedgerActive: false,
  hostedLedgerEntries: 0,
};
const outside: OutsideKey = {
  public_key: AGENT,
  label: "mcp-claude",
  access: { state: "scoped", allowanceYocto: "1000000000000000000000000" },
};

function props(over: Partial<ConnectAgentPanelProps> = {}): ConnectAgentPanelProps {
  return {
    vault: VAULT,
    network: "testnet",
    signer: "acme.testnet",
    isOwner: true,
    canAct: true,
    facts: EMPTY,
    outsideAgents: [],
    outsideLedger: null,
    activeMandateKeys: [],
    usdc: "0",
    freeNear: "410000000000000000000000",
    allowances: {
      agentYocto: "1000000000000000000000000",
      ledgerYocto: "250000000000000000000000",
    },
    testUsdc: true,
    onNpm: false,
    removeTxs: {},
    outOfNearCodes: [],
    addAgent: async () => ({ error: "not in this test" }),
    setLedgerKey: async () => ({ error: "not in this test" }),
    ...over,
  };
}
const render = (over: Partial<ConnectAgentPanelProps> = {}) =>
  renderToStaticMarkup(createElement(ConnectAgentPanel, props(over)))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');
/** The text of every code block and output block. */
const blocks = (html: string) =>
  [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]+>/g, ""),
  );

beforeEach(() => {
  h.buttons.length = 0;
});

describe("ConnectAgentPanel for the owner", () => {
  it("shows the six steps in order, with the mockup's titles", () => {
    const html = render();
    const titles = [
      "Make the keys on your machine",
      "Paste the two public keys",
      "Sign two calls in your wallet",
      "Give it a mandate",
      "Add it to your MCP client",
      "Check it",
    ];
    let at = -1;
    titles.forEach((t, i) => {
      const here = html.indexOf(`Step ${i + 1} of 6</span>${t}`);
      expect(here, t).toBeGreaterThan(at);
      at = here;
    });
    expect(html).toContain("Check these keys");
    expect(html).toContain("Agent public key");
    expect(html).toContain("Ledger public key");
    expect(html).toContain('value="mcp-claude"');
  });

  it("offers no wallet button before the keys are checked, and never prefills a key", () => {
    const html = render();
    expect(h.buttons).toEqual([]);
    expect(html).toContain("Check the keys in step 2 first.");
    expect(html).not.toMatch(/value="ed25519:/);
  });

  it("builds the server from a clone while MCP_ON_NPM is false", () => {
    const html = render({ onNpm: false });
    const code = blocks(html).join("\n");
    expect(code).toContain("git clone https://github.com/probarion/probarion");
    expect(code).toContain('pnpm --filter "@probarion/mcp..." run build');
    expect(code).toContain(`node packages/mcp/dist/bin.js init --vault ${VAULT}`);
    expect(code).toContain("/path/to/probarion/packages/mcp/dist/bin.js");
    expect(code).not.toContain("npx");
    expect(html).toContain("Use the full path of your clone in place of");
  });

  it("uses the npx forms once MCP_ON_NPM is true", () => {
    const html = render({ onNpm: true });
    const code = blocks(html).join("\n");
    expect(code).toContain(`npx -y @probarion/mcp@0.1.1 init --vault ${VAULT}`);
    expect(code).toContain("-- npx -y @probarion/mcp@0.1.1");
    expect(code).toContain(`PROBARION_VAULT_ID=${VAULT} npx -y @probarion/mcp@0.1.1 status`);
    expect(code).not.toContain("git clone");
    expect(html).not.toContain("Use the full path of your clone");
    expect(html).toContain("It needs Node 24 or later.");
  });

  it("puts no key and no secret in any snippet, in either state: only the vault id", () => {
    for (const onNpm of [true, false]) {
      const facts = { ...EMPTY, agents: [{ public_key: AGENT, label: "mcp-claude" }] };
      const html = render({ onNpm, facts, outsideAgents: [outside] });
      const code = blocks(html);
      expect(code.length).toBeGreaterThan(5);
      const all = code.join("\n");
      expect(all).toContain(`PROBARION_VAULT_ID`);
      expect(all).not.toContain(AGENT);
      expect(all).not.toMatch(/PROBARION_(AGENT|LEDGER)_KEY|secret_key|[1-9A-HJ-NP-Za-km-z]{80,}/);
    }
  });

  it("shows the four MCP clients as tabs, the first one open", () => {
    const html = render();
    const tabs = [
      ...html.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)</g),
    ];
    expect(tabs.map((m) => m[2])).toEqual(["Claude Code", "Claude Desktop", "Cursor", "Codex"]);
    expect(tabs.map((m) => m[1])).toEqual(["true", "false", "false", "false"]);
    expect([...html.matchAll(/role="tabpanel"[^>]*hidden=""/g)]).toHaveLength(3);
  });

  it("links the mandate step, and test USDC on testnet only", () => {
    const testnet = render();
    expect(testnet).toContain(`href="/console/${VAULT}/mandates"`);
    expect(testnet).toContain("Add test USDC");
    expect(render({ testUsdc: false, network: "mainnet" })).not.toContain("Add test USDC");
  });

  it("offers Remove, behind a danger confirm, for the one agent key held outside Probarion", () => {
    const tx = removeAgentTx(VAULT, AGENT);
    const html = render({ outsideAgents: [outside], removeTxs: { [AGENT]: tx } });
    const remove = h.buttons.find((b) => b.label === "Remove this agent key");
    expect(remove?.tx).toEqual(tx);
    expect(remove?.tx?.receiverId).toBe(VAULT);
    expect(remove?.confirmTone).toBe("danger");
    expect(html).toContain("Removing the agent key stops the agent at once.");
    expect(html).toContain('The mandate form already lists this key as "mcp-claude".');
  });

  it("offers no Remove when the owner on chain is someone else", () => {
    render({
      canAct: false,
      outsideAgents: [outside],
      removeTxs: { [AGENT]: removeAgentTx(VAULT, AGENT) },
    });
    expect(h.buttons).toEqual([]);
  });

  it("says how much free NEAR the vault has for the two keys", () => {
    expect(render()).toContain("this vault has 0.41 NEAR free.");
    expect(render({ freeNear: null })).toContain("this vault's free NEAR could not be read.");
  });

  it("renders nothing without the vault's facts (the page says why)", () => {
    expect(render({ facts: null })).toBe("");
  });
});

describe("ConnectAgentPanel for an approver or a viewer", () => {
  it("shows the status card only: no form, no step numbers, no wallet button", () => {
    const html = render({
      isOwner: false,
      canAct: false,
      outsideAgents: [outside],
      removeTxs: { [AGENT]: removeAgentTx(VAULT, AGENT) },
    });
    expect(html).toContain("Only the vault's owner can connect an agent.");
    expect(html).toContain("Check it");
    expect(html).toContain("Agent key on the vault");
    expect(html).not.toContain("Check these keys");
    expect(html).not.toContain("Step 1 of 6");
    expect(html).not.toContain("<input");
    expect(h.buttons).toEqual([]);
  });
});
