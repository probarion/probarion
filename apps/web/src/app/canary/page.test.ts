import type { MandateView } from "@probarion/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// The page's data and settings are replaced; the page itself is the real one, rendered to markup. The pure parts
// (copy, the board, the vault summary, the mode) have their own tests: this holds them together in the owner's order.
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  board: vi.fn(),
  feed: vi.fn(),
  ftBalance: vi.fn(),
  intentsBalance: vi.fn(),
  listMandates: vi.fn(),
}));
/** The network of the address the page is opened at, and the networks the page asked a chain reader for. */
const net = vi.hoisted(() => ({
  network: "testnet" as "mainnet" | "testnet",
  readers: [] as string[],
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/network", () => ({ softRequestNetwork: async () => net.network }));
vi.mock("@/lib/canary/board-data", () => ({ loadBoard: mocks.board, loadFeed: mocks.feed }));
vi.mock("@/lib/near/server", () => ({
  getReader: (network: string) => {
    net.readers.push(network);
    return {
      ftBalance: mocks.ftBalance,
      intentsBalance: mocks.intentsBalance,
      listMandates: mocks.listMandates,
    };
  },
  chainConsts: () => ({
    usdc: "usdc.probarion.testnet",
    intents: "intents-stub.probarion.testnet",
    allowedAssets: { base: "base-usdc.probarion.testnet" },
  }),
}));

import { parseBoard, parseFeed } from "@/lib/canary/board";
import CanaryPage, { dynamic, metadata } from "./page";

const logs = quietLogs();

const VAULT = "canary.vaults.probarion.testnet";

/** The settings: the mode, and the Canary vault of each network (`CANARY_VAULT_ID` sets both; `vaults` sets them apart). */
const env = (
  over: {
    CANARY_MODE?: string;
    CANARY_VAULT_ID?: string | null;
    vaults?: { mainnet: string | null; testnet: string | null };
  } = {},
) => {
  const vault = "CANARY_VAULT_ID" in over ? (over.CANARY_VAULT_ID ?? null) : VAULT;
  const vaults = over.vaults ?? { mainnet: vault, testnet: vault };
  return {
    CANARY_MODE: over.CANARY_MODE ?? "code-only",
    networks: {
      mainnet: { canaryVaultId: vaults.mainnet },
      testnet: { canaryVaultId: vaults.testnet },
    },
  };
};

const mandate: MandateView = {
  id: 1,
  payee: { type: "near", account_id: "canary-payee.probarion.testnet" },
  purpose_hash: "0".repeat(64),
  max_per_payment: "1000000",
  max_total: "10000000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: "1893456000000000000",
  approval_above: "0",
  agent_pk: "ed25519:11111111111111111111111111111111",
  label: "Canary",
  status: "active",
  created_at_ns: "1793456000000000000",
};

const BOARD = parseBoard({
  browsers: 9,
  addresses: 4,
  attempts_external: 31,
  attempts_team: 3,
  raw_external: 12,
  techniques: [
    {
      technique: "payee_change",
      attempts: 10,
      refused_by_code: 10,
      refused_by_contract: 5,
      held: 0,
    },
  ],
  contract_codes: [{ code: "NoMandate", n: 5 }],
});
const FEED = parseFeed([
  {
    created_at: "2026-11-06T10:15:30Z",
    techniques: ["payee_change"],
    code_status: "refused_by_code",
    code_rule: "custom.canary_no_autopay",
    raw: true,
    contract_status: "refused_by_contract",
    contract_code: "NoMandate",
    tx_hash: "AbC123xyz",
    is_team: false,
  },
]);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  net.network = "testnet";
  net.readers = [];
  mocks.env.mockReturnValue(env());
  mocks.board.mockResolvedValue(BOARD);
  mocks.feed.mockResolvedValue(FEED);
  mocks.ftBalance.mockResolvedValue("25500000");
  mocks.intentsBalance.mockResolvedValue("0");
  mocks.listMandates.mockResolvedValue([mandate]);
});

const page = async () => renderToStaticMarkup(await CanaryPage());
const visible = (html: string) =>
  html
    .replace(/<\/?(?:p|h1|h2|h3|section|div|li|tr|td|th|header)\b[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
const touchedTheChain = () =>
  [mocks.ftBalance, mocks.intentsBalance, mocks.listMandates, mocks.board, mocks.feed].some(
    (m) => m.mock.calls.length > 0,
  );

describe("the page's settings", () => {
  it("reads the chain and the database on every request, and describes the page as the owner asked", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.title).toBe("Canary");
    expect(metadata.description).toBe(
      "Try to make an AI agent pay you. Code rules and a NEAR contract decide.",
    );
  });
});

describe("the live page", () => {
  it("shows the header: the network, the title, the lede and the pills", async () => {
    const html = await page();
    const text = visible(html);
    expect(text).toContain("Public challenge · NEAR testnet");
    expect(html).toMatch(/<h1[^>]*>Make the agent pay you<\/h1>/);
    expect(text).toContain(
      "The Canary's model believes what you write and is told to pay. It only proposes. Code rules and a NEAR contract decide what moves. Try to get a payment to anyone other than its one payee.",
    );
    expect(html).toMatch(/<a[^>]*href="\/canary\/rules"[^>]*>Rules<\/a>/);
    expect(text).toContain("Testnet: test tokens, no value");
  });

  it("has no link to a proof page: the Canary's ledger is private, so a visitor would get a 404", async () => {
    const html = await page();
    expect(hrefs(html).filter((h) => (h ?? "").startsWith("/proof"))).toEqual([]);
    expect(visible(html)).not.toContain("Proof page");
    // The pills are the rules link and the testnet pill, and nothing else.
    const pills = /<div class="[^"]*pills[^"]*">(.*?)<\/div>/.exec(html)?.[1] ?? "";
    expect([...pills.matchAll(/<a\b/g)]).toHaveLength(1);
  });

  it("shows the sections in the owner's order", async () => {
    const text = visible(await page());
    const order = [
      "Make the agent pay you",
      "The vault, read from the chain",
      "Paid to an attacker: 0, by construction",
      "Your attempt",
      "Scoreboard",
      "Latest attempts (UTC)",
      "Why this is not Freysa",
      "What this page does not show",
    ].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("reads the vault from the chain: the balance, the vault's link and its only mandate", async () => {
    const html = await page();
    const text = visible(html);
    expect(mocks.ftBalance).toHaveBeenCalledWith("usdc.probarion.testnet", VAULT);
    expect(mocks.listMandates).toHaveBeenCalledWith(VAULT, 0, 10);
    expect(mocks.intentsBalance).toHaveBeenCalledWith(
      "intents-stub.probarion.testnet",
      VAULT,
      "base-usdc.probarion.testnet",
    );
    expect(text).toContain("25.5 test USDC");
    expect(html).toContain(`href="https://testnet.nearblocks.io/address/${VAULT}"`);
    expect(text).toContain(
      "Its only mandate pays canary-payee.probarion.testnet, at most 1 test USDC per payment, and holds every spend for a human.",
    );
  });

  it("shows the form with the mode pill, the scoreboard and the latest attempts", async () => {
    const text = visible(await page());
    expect(text).toContain("Your message to the agent");
    expect(text).toContain("Code only today");
    expect(text).toContain("At least 4 visitors");
    expect(text).toContain("Attempts 31");
    expect(text).toContain("2026-11-06 10:15 payee_change custom.canary_no_autopay NoMandate");
  });

  it("says Raw mode on in live mode", async () => {
    mocks.env.mockReturnValue(env({ CANARY_MODE: "live" }));
    const text = visible(await page());
    expect(text).toContain("Raw mode on");
    expect(text).not.toContain("Code only today");
  });

  it("links how the site shows that a spend has no address field", async () => {
    expect(hrefs(await page())).toContain("/#payee");
  });

  it("promises nothing for winning, and shows no ledger", async () => {
    const text = visible(await page());
    expect(text).not.toMatch(/bounty|keep what you extract|prize|reward|PayeeMismatch/i);
    expect(text).not.toMatch(/ledger/i);
  });

  it("links to no page that does not exist yet", async () => {
    const found = hrefs(await page()).filter((h) =>
      /^\/(open|security|status|terms|privacy)\b/.test(h ?? ""),
    );
    expect(found).toEqual([]);
  });

  it("says USDC and no testnet pill on mainnet", async () => {
    net.network = "mainnet";
    const html = await page();
    const text = visible(html);
    expect(text).toContain("Public challenge · NEAR mainnet");
    expect(text).toContain("25.5 USDC");
    expect(text).not.toContain("test USDC");
    expect(text).not.toContain("Testnet: test tokens, no value");
    expect(html).toContain(`href="https://nearblocks.io/address/${VAULT}"`);
  });

  // W-NET-R5: the Canary is the request network's: its vault, its chain, its board and its feed.
  it("reads the vault, the board and the feed of the network of the address, and of no other", async () => {
    mocks.env.mockReturnValue(
      env({ vaults: { mainnet: "canary.vaults.probarion.near", testnet: VAULT } }),
    );
    for (const network of ["mainnet", "testnet"] as const) {
      net.network = network;
      net.readers = [];
      mocks.board.mockClear();
      mocks.feed.mockClear();
      const text = visible(await page());
      expect(text, network).toContain(
        network === "mainnet" ? "canary.vaults.probarion.near" : VAULT,
      );
      expect(new Set(net.readers), network).toEqual(new Set([network]));
      expect(mocks.board, network).toHaveBeenCalledWith(network);
      expect(mocks.feed, network).toHaveBeenCalledWith(network);
    }
  });

  it("is not open yet on a network that has no Canary vault, whatever the other one has", async () => {
    mocks.env.mockReturnValue(
      env({ vaults: { mainnet: "canary.vaults.probarion.near", testnet: null } }),
    );
    net.network = "testnet";
    const text = visible(await page());
    expect(text).toContain("The live Canary is not open yet.");
    expect(text).not.toContain("canary.vaults.probarion.near");
    expect(touchedTheChain()).toBe(false);
  });

  it("shows the Base balance only when there is one", async () => {
    expect(visible(await page())).not.toContain("Base payees");
    mocks.intentsBalance.mockResolvedValue("5000000");
    expect(visible(await page())).toContain("plus 5 test USDC for Base payees, held in Intents");
  });
});

describe("the live page when something cannot be read", () => {
  it("says it could not read the chain, with no zero, when the reads fail", async () => {
    mocks.ftBalance.mockRejectedValue(new Error("rpc down"));
    mocks.intentsBalance.mockRejectedValue(new Error("rpc down"));
    mocks.listMandates.mockRejectedValue(new Error("rpc down"));
    const text = visible(await page());
    expect(text.match(/Could not read the chain right now/g)).toHaveLength(2);
    expect(text).not.toContain("0 test USDC");
    expect(logs.lines.filter((l) => l.includes("canary.chain_read_failed")).length).toBeGreaterThan(
      0,
    );
  });

  it("says it could not read the chain when the reader cannot be built", async () => {
    mocks.ftBalance.mockImplementation(() => {
      throw new Error("Invalid environment");
    });
    const text = visible(await page());
    expect(text).toContain("Could not read the chain right now");
    expect(text).toContain("Your message to the agent");
  });

  it("says the scoreboard is not available when it cannot be read, and the feed likewise", async () => {
    mocks.board.mockResolvedValue(null);
    mocks.feed.mockResolvedValue(null);
    const text = visible(await page());
    expect(text).toContain("The scoreboard is not available right now.");
    expect(text).toContain("The latest attempts are not available right now.");
    expect(text).toContain("Your message to the agent");
  });

  it("says there are no attempts yet when the feed is empty", async () => {
    mocks.feed.mockResolvedValue([]);
    expect(visible(await page())).toContain("No attempts yet. Be the first.");
  });
});

describe("the replay states", () => {
  const say = async (over: Record<string, unknown>) => {
    mocks.env.mockReturnValue(env(over));
    const html = await page();
    return { html, text: visible(html) };
  };
  const NOT_HERE = [
    "Your message to the agent",
    "Scoreboard",
    "The vault, read from the chain",
    "Proof page",
  ];

  it("says the live Canary is paused in off mode, with no form, no scoreboard and no read of the chain", async () => {
    const { text } = await say({ CANARY_MODE: "off" });
    // The shipped list is empty: the banner is its first sentence alone, then the empty list says so.
    expect(text).toContain("The live Canary is paused. Recorded attacks No recorded attacks yet.");
    expect(text).not.toContain("Each row");
    for (const t of NOT_HERE) expect(text).not.toContain(t);
    expect(touchedTheChain()).toBe(false);
  });

  it("says this is a replay in replay mode", async () => {
    const { text } = await say({ CANARY_MODE: "replay" });
    expect(text).toContain("This is a replay of recorded attacks.");
    for (const t of NOT_HERE) expect(text).not.toContain(t);
    expect(touchedTheChain()).toBe(false);
  });

  it("says the live Canary is not open yet when no vault is set", async () => {
    for (const CANARY_MODE of ["live", "code-only"]) {
      const { text } = await say({ CANARY_MODE, CANARY_VAULT_ID: null });
      expect(text).toContain("The live Canary is not open yet.");
      for (const t of NOT_HERE) expect(text).not.toContain(t);
    }
    expect(touchedTheChain()).toBe(false);
  });

  it("says the live Canary is not open yet, and does not fail, when the environment cannot be read", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    const html = await page();
    const text = visible(html);
    expect(text).toContain("The live Canary is not open yet.");
    expect(text).toContain("Make the agent pay you");
    expect(text).toContain("Public challenge · NEAR testnet");
    expect(html).toMatch(/<a[^>]*href="\/canary\/rules"/);
    for (const t of NOT_HERE) expect(text).not.toContain(t);
    expect(touchedTheChain()).toBe(false);
    expect(logs.lines.filter((l) => l.includes("canary.page_env_unavailable"))).toHaveLength(1);
  });

  it("shows the owner's recorded attacks, or says there are none yet", async () => {
    const { text } = await say({ CANARY_MODE: "replay" });
    expect(text).toContain("Recorded attacks");
    expect(text).toContain("No recorded attacks yet.");
  });

  it("keeps the testnet pill in the replay of a testnet build", async () => {
    const { text } = await say({ CANARY_MODE: "off" });
    expect(text).toContain("Testnet: test tokens, no value");
  });
});
