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

import { checkPastedPair, KEY_ERRORS } from "@/lib/agent/connect";
import {
  CheckedPanel,
  ConnectAgentPanel,
  type ConnectAgentPanelProps,
  checkStatus,
  firstErrorField,
} from "./ConnectAgentPanel";

const VAULT = "research-bot.vaults.probarion.testnet";
const AGENT = formatPublicKey(new Uint8Array(32).fill(21));
const LEDGER = formatPublicKey(new Uint8Array(32).fill(22));
const OTHER_LEDGER = formatPublicKey(new Uint8Array(32).fill(23));
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

  it("numbers the steps in gold-ink, the small-text gold that reads at 7:1 on a console page", () => {
    const html = render();
    expect(html).toMatch(/<span class="[^"]*text-gold-ink[^"]*">Step 1 of 6<\/span>/);
    // Not gold-small (5.9:1 on paper): every text colour on a console page reads at 7:1 (console-kit.test.ts).
    expect(html).not.toMatch(/text-gold-small[^"]*">Step \d of 6/);
  });

  it("runs the check from a form, so Enter works, and announces each result in a status region mounted with the page", () => {
    const html = render();
    expect(html).toMatch(
      /<form[^>]*novalidate=""[^>]*>[\s\S]*<button type="submit"[^>]*>Check these keys<\/button>/i,
    );
    expect(html).toMatch(/<p role="status" class="sr-only"><\/p>/);
    // The label field is not cut: a long paste reaches the check whole.
    expect(html).not.toMatch(/maxlength/i);
  });

  it("names each Copy button for a screen reader", () => {
    const html = render();
    const names = [...html.matchAll(/<button[^>]*aria-label="(Copy[^"]*)"/g)].map((m) => m[1]);
    expect(names).toContain("Copy the commands that make the keys");
    expect(names).toContain("Copy the Claude Code command");
    expect(names).toContain("Copy the Claude Code Windows command");
    expect(names).toContain("Copy the Claude Desktop settings");
    expect(names).toContain("Copy the status command");
    expect(new Set(names).size).toBe(names.length);
  });

  it("labels both outputs as rough, and prints the lines init and status print", () => {
    const html = render();
    expect(html).not.toContain(">What it prints<");
    expect(html.match(/What it prints, roughly/g)).toHaveLength(2);
    const out = blocks(html).join("\n");
    expect(out).toContain(`probarion-mcp init: vault ${VAULT} on testnet`);
    expect(out).toContain("agent public key:  ed25519:...");
    expect(out).toContain("ledger public key: ed25519:...");
    expect(out).toContain(`probarion-mcp status: vault ${VAULT} on testnet.`);
    expect(out).toContain("  ok       keys        from the keys file");
    expect(out).toContain("  not yet  ledger key  the vault has no ledger key yet");
    expect(out).toContain("Not ready: 2 not yet.\nNext (ledger key): ...");
    expect(out).not.toContain("steps left");
  });

  it("says the keys file is owner-only on macOS and Linux, and not on Windows", () => {
    const html = render();
    expect(html).toContain("On macOS and Linux only you can read that file (mode 0600).");
    expect(html).toContain(
      "On Windows its folder's permissions apply, so keep that folder private.",
    );
    expect(html).not.toContain("a file only you can read");
  });

  it("gives PowerShell its own init line when the vault's name does not say its network", () => {
    const html = render({ vault: "vault.example", network: "mainnet", testUsdc: false });
    const code = blocks(html).join("\n");
    expect(code).toContain(
      "NEAR_NETWORK=mainnet node packages/mcp/dist/bin.js init --vault vault.example",
    );
    expect(code).toContain(
      "PROBARION_VAULT_ID=vault.example NEAR_NETWORK=mainnet node packages/mcp/dist/bin.js status",
    );
    expect(html).toContain(
      'In Windows PowerShell, the last line is <code class="mono wrap-anywhere">$env:NEAR_NETWORK = "mainnet"; node packages/mcp/dist/bin.js init --vault vault.example</code>.',
    );
    // A vault whose name says its network: the same lines work in PowerShell.
    expect(render()).toContain("On Windows the same lines work in PowerShell.");
  });
});

describe("step 3 before anything is pasted", () => {
  const ledger: OutsideKey = {
    public_key: LEDGER,
    label: "",
    access: { state: "scoped", allowanceYocto: "250000000000000000000000" },
  };
  /** The step 3 card's HTML, from its heading to step 4's. */
  const step3 = (html: string) =>
    html.slice(html.indexOf("Step 3 of 6"), html.indexOf("Step 4 of 6"));

  it("says what the chain shows, as step 6 does, for keys already on the vault", () => {
    const facts = {
      ...EMPTY,
      agents: [{ public_key: AGENT, label: "mcp-claude" }],
      ledgerKey: LEDGER,
    };
    const s3 = step3(render({ facts, outsideAgents: [outside], outsideLedger: ledger }));
    expect(s3.match(/on the vault<\/span>/g)).toHaveLength(2);
    expect(s3).not.toContain("not yet");
    expect(s3).not.toContain("Check the keys in step 2 first.");
    expect(s3).toContain(`key ${AGENT.slice(0, 14)}...${AGENT.slice(-6)}, label "mcp-claude"`);
    expect(s3).toContain(`key ${LEDGER.slice(0, 14)}...${LEDGER.slice(-6)},`);
    expect(h.buttons).toEqual([]);
  });

  it("keeps asking for the check for a key that is not on the vault yet", () => {
    const facts = { ...EMPTY, agents: [{ public_key: AGENT, label: "mcp-claude" }] };
    const s3 = step3(render({ facts, outsideAgents: [outside] }));
    expect(s3.match(/on the vault<\/span>/g)).toHaveLength(1);
    expect(s3.match(/not yet<\/span>/g)).toHaveLength(1);
    expect(s3.match(/Check the keys in step 2 first\./g)).toHaveLength(1);
  });

  it("does not call a ledger key whose access key is not limited to anchor() on the vault", () => {
    const facts = { ...EMPTY, ledgerKey: LEDGER };
    const s3 = step3(
      render({ facts, outsideLedger: { ...ledger, access: { state: "wrong_scope" } } }),
    );
    expect(s3).not.toContain("on the vault</span>");
  });
});

describe("the result of Check these keys", () => {
  const form = (label = "mcp-claude") => ({ agent: AGENT, ledger: LEDGER, label });

  it("sends the focus to the first field whose check failed, in the page's order", () => {
    expect(firstErrorField(checkPastedPair(EMPTY, { agent: "", ledger: "x", label: "" }))).toBe(
      "agent",
    );
    expect(
      firstErrorField(checkPastedPair(EMPTY, { agent: AGENT, ledger: AGENT, label: "" })),
    ).toBe("ledger");
    expect(firstErrorField(checkPastedPair(EMPTY, form(LEDGER)))).toBe("label");
    expect(firstErrorField(checkPastedPair(EMPTY, form()))).toBeNull();
  });

  it("announces the panel's title, or the first error, and never what was pasted", () => {
    expect(checkStatus(null)).toBe("");
    expect(checkStatus(checkPastedPair(EMPTY, form()))).toBe(
      "This agent can own this vault's ledger",
    );
    expect(checkStatus(checkPastedPair(EMPTY, { ...form(), ledger: AGENT }))).toBe(KEY_ERRORS.same);
    expect(checkStatus(checkPastedPair({ ...EMPTY, hostedLedgerEntries: 2 }, form()))).toBe(
      "This vault already keeps its ledger elsewhere",
    );
    expect(checkStatus(checkPastedPair({ ...EMPTY, ledgerKey: OTHER_LEDGER }, form()))).toBe(
      "The vault has another ledger key, never used",
    );
    expect(checkStatus(checkPastedPair(EMPTY, form(AGENT)))).toBe(KEY_ERRORS.labelIsKey);
  });

  const blockedFacts = { ...EMPTY, hostedLedgerEntries: 2 };
  const panel = (network: "testnet" | "mainnet") => {
    const ok = checkPastedPair(blockedFacts, form());
    if (!ok.ok) throw new Error("the check should pass");
    return renderToStaticMarkup(
      createElement(CheckedPanel, { ok, facts: blockedFacts, network, replaceButton: null }),
    ).replaceAll("&#x27;", "'");
  };

  it("offers a vault of the agent's own in one wallet prompt on testnet", () => {
    const html = panel("testnet");
    expect(html).toContain("Give the agent a vault of its own: it takes one wallet prompt.");
    expect(html).toContain("Create a vault for this agent");
    expect(html).toContain("Why one ledger per vault");
  });

  it("says on mainnet that a vault cannot be created there yet, and links no create page", () => {
    const html = panel("mainnet");
    expect(html).toContain(
      "The agent needs a vault of its own. Vaults cannot be created on mainnet yet: its factory is not deployed.",
    );
    expect(html).not.toContain("one wallet prompt");
    expect(html).not.toContain("Create a vault for this agent");
    expect(html).toContain("Why one ledger per vault");
  });

  it("is not a live region itself: the status region speaks for it", () => {
    expect(panel("testnet")).not.toContain("aria-live");
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
