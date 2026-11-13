// The #mainnet section's question to the mainnet contract (lib/site/mainnet-ask.ts, MainnetAsk.tsx) and the dated line
// of the later online run under S2's verify. A click sends one view and names a verdict only from the contract's
// answer; the mandate's facts are held to the committed snapshot, the later run's to its output file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MainnetAsk, MainnetVerifyBlock } from "@/components/site/MainnetAsk";
import { explorerAccountUrl } from "@/lib/config";
import {
  BOARD_LINKS,
  LINKS,
  LIVE_CHECK,
  MAINNET_ASK,
  MAINNET_PAYOUT,
  MAINNET_VERIFY,
  STATUS,
} from "@/lib/site/facts";
import {
  ASK_AGENT_PK,
  ASK_AMOUNTS,
  ASK_MANDATE,
  ASK_PAYEE,
  ASK_RPC,
  ASK_VAULT,
  type AskAnswer,
  type AskShown,
  askHeadline,
  askMainnet,
  askSentence,
  askSource,
} from "@/lib/site/mainnet-ask";
import { PAYOUTS } from "@/lib/site/mainnet-payout-data";
import { verifyView } from "@/lib/site/mainnet-payout-section";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const text = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const S2 = ["docs", "evidence", "mainnet-v0", "s2-2026-11-13"];

/** A fetch that answers every call with `answer` and counts the calls. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const view = (value: unknown, height = 224408070) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "landing",
      result: {
        result: [...new TextEncoder().encode(JSON.stringify(value))],
        block_height: height,
        logs: [],
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
const argsOf = (body: unknown) =>
  JSON.parse(atob((body as { params: { args_base64: string } }).params.args_base64)) as {
    request: { mandate_id: number; amount: string };
    signer_pk: string;
  };

describe("the mainnet question's facts", () => {
  it("asks the deployment record's mainnet vault", () => {
    const mainnet = JSON.parse(text("contracts", "deployments", "mainnet.json")) as {
      vault_v0: { account_id: string };
    };
    expect(ASK_VAULT).toBe(mainnet.vault_v0.account_id);
    expect(ASK_VAULT).toBe("v0.probarion.near");
  });

  it("holds mandate 1's payee, key and limit to the committed snapshot of 2026-11-13", () => {
    const snap = JSON.parse(text(...S2, "snapshot-2026-11-13.json")) as {
      vault: string;
      network: string;
      chain: {
        mandates: {
          id: number;
          payee: { type: string; account_id?: string };
          agent_pk: string;
          max_per_payment: string;
          approval_above: string | null;
        }[];
      };
    };
    expect([snap.vault, snap.network]).toEqual([ASK_VAULT, "mainnet"]);
    const m = snap.chain.mandates.find((x) => x.id === ASK_MANDATE);
    expect(m?.payee).toEqual({ type: "near", account_id: ASK_PAYEE });
    expect(m?.agent_pk).toBe(ASK_AGENT_PK);
    expect(m?.max_per_payment).toBe("1000000");
    // 1 USDC is the limit and does not go to an approver; 2 USDC is over it.
    expect(m?.approval_above).toBe("1000000");
    expect(ASK_AMOUNTS).toEqual(["1", "2"]);
    expect(MAINNET_ASK.lede).toContain(
      "Mandate 1 of `v0.probarion.near` pays `probarion-duong.near`, the owner's own NEAR account, at most 1 USDC a payment.",
    );
    const owner = JSON.parse(text("contracts", "deployments", "mainnet.json")) as {
      owner_wallets: { near: string[] };
    };
    expect(owner.owner_wallets.near).toContain(ASK_PAYEE);
  });

  it("names one RPC host, and the vault's explorer page", () => {
    expect(ASK_RPC).toBe("https://rpc.mainnet.fastnear.com");
    const html = renderToStaticMarkup(createElement(MainnetAsk));
    expect(html).toContain(`href="${explorerAccountUrl("mainnet", ASK_VAULT)}"`);
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(
      "RPC rpc.mainnet.fastnear.com, one request a click",
    );
  });
});

describe("askMainnet", () => {
  it("sends one check_spend view of mandate 1 to the one host, signed as nothing", async () => {
    const f = fakeFetch(() => view({ ok: true, code: null, would_hold: false }));
    const a = await askMainnet("1", { fetch: f.fetch });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(ASK_RPC);
    const body = f.calls[0]?.body as { method: string; params: Record<string, unknown> };
    expect(body.method).toBe("query");
    expect(body.params).toMatchObject({
      request_type: "call_function",
      account_id: ASK_VAULT,
      method_name: "check_spend",
    });
    const args = argsOf(body);
    expect(args.request).toMatchObject({ mandate_id: 1, amount: "1000000" });
    expect(args.signer_pk).toBe(ASK_AGENT_PK);
    expect(a).toMatchObject({
      amount: "1",
      verdict: { ok: true, code: null, wouldHold: false },
      blockHeight: 224408070,
    });
  });

  it("reads 1 USDC as allow and 2 USDC as block OverPerPayment, as the chain answered on 2026-11-13", async () => {
    const allow = await askMainnet("1", {
      fetch: fakeFetch(() => view({ ok: true, code: null, would_hold: false })).fetch,
    });
    const block = await askMainnet("2", {
      fetch: fakeFetch(() => view({ ok: false, code: "OverPerPayment", would_hold: false })).fetch,
    });
    const copy = MAINNET_ASK;
    expect(askHeadline({ kind: "answer", answer: allow }, copy)).toEqual({
      text: "Allow",
      tone: "pay",
    });
    expect(askSentence({ kind: "answer", answer: allow }, copy, LIVE_CHECK.codes)).toBe(
      "Inside mandate 1. 1 USDC would go to probarion-duong.near, the payee the owner signed.",
    );
    expect(askHeadline({ kind: "answer", answer: block }, copy)).toEqual({
      text: "Block: OverPerPayment",
      tone: "refuse",
    });
    expect(askSentence({ kind: "answer", answer: block }, copy, LIVE_CHECK.codes)).toBe(
      LIVE_CHECK.codes.OverPerPayment,
    );
  });

  it("throws on every failure, after one request: no answer, an HTTP error, an RPC error, a body that is no verdict", async () => {
    const failures: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("busy", { status: 503 }),
      () => new Response("not json", { status: 200 }),
      () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32000 } }), {
          status: 200,
        }),
      () => view({ ok: "yes" }),
      () => view(["not", "a", "verdict"]),
    ];
    for (const [i, answer] of failures.entries()) {
      const f = fakeFetch(answer);
      await expect(askMainnet("2", { fetch: f.fetch }), String(i)).rejects.toThrow();
      expect(f.calls, String(i)).toHaveLength(1);
    }
  });

  it("gives up after its timeout, with one request", async () => {
    const f = fakeFetch(() => new Promise<Response>(() => {}));
    const slow = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      void f.fetch(input, init);
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }) as typeof globalThis.fetch;
    await expect(askMainnet("1", { fetch: slow, timeoutMs: 20 })).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
});

describe("what the question shows, by state", () => {
  const answer: AskAnswer = {
    amount: "2",
    verdict: { ok: false, code: "OverPerPayment", wouldHold: false },
    raw: { ok: false, code: "OverPerPayment", would_hold: false },
    blockHeight: 224408071,
    at: "2026-11-13T19:35:48.120Z",
  };

  it("names no verdict while resting, asking or after a failure", () => {
    const words = [MAINNET_ASK.verdictPay, "Block", MAINNET_ASK.verdictHold];
    for (const shown of [
      { kind: "rest" },
      { kind: "asking", amount: "1" },
      { kind: "failed", amount: "2" },
    ] satisfies AskShown[]) {
      const head = askHeadline(shown, MAINNET_ASK);
      expect(head.tone, shown.kind).toBe("none");
      for (const w of words) expect(head.text, shown.kind).not.toContain(w);
      expect(askSentence(shown, MAINNET_ASK, LIVE_CHECK.codes), shown.kind).toBe("");
      expect(askSource(shown, MAINNET_ASK).raw, shown.kind).toBeNull();
    }
    expect(askHeadline({ kind: "failed", amount: "1" }, MAINNET_ASK).text).toBe(
      "Could not read the chain, try again.",
    );
    expect(askHeadline({ kind: "asking", amount: "1" }, MAINNET_ASK).text).toBe(
      "Asking v0.probarion.near",
    );
  });

  it("says where an answer came from, its time in UTC and its raw answer as the contract gave it", () => {
    expect(askSource({ kind: "answer", answer }, MAINNET_ASK)).toEqual({
      lead: "Answer from v0.probarion.near at block 224408071, 19:35:48 UTC. Raw: ",
      raw: '{"ok":false,"code":"OverPerPayment","would_hold":false}',
      tail: "",
    });
  });

  it("renders its panel hidden until the script runs, with the two amounts in a named group", () => {
    const html = renderToStaticMarkup(createElement(MainnetAsk));
    expect(html).toMatch(/<div class="[^"]*askPanel[^"]*" hidden="">/);
    expect(html).toContain(`aria-label="${MAINNET_ASK.amountsLabel}"`);
    expect([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual([
      "1 USDC",
      "2 USDC",
    ]);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(
      `<noscript><p class="${/class="([^"]*askNote[^"]*)"/.exec(html)?.[1]}">`,
    );
  });

  it("keeps the copy rules: no dash, no absolute claim, no test tokens", () => {
    const strings: string[] = Object.values(MAINNET_ASK);
    for (const s of [...strings, MAINNET_VERIFY.title, MAINNET_VERIFY.note]) {
      expect(s, s).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
      expect(s, s).not.toMatch(/\b(first|only|unhackable|never)\b/i);
      expect(s, s).not.toMatch(/test USDC|test tokens?/i);
    }
  });
});

describe("the no-clone verify block", () => {
  it("renders nothing until lane F02's lines are in", () => {
    expect(MAINNET_VERIFY.lines).toEqual([]);
    expect(renderToStaticMarkup(createElement(MainnetVerifyBlock))).toBe("");
    expect(renderToStaticMarkup(createElement(MainnetAsk))).not.toContain(MAINNET_VERIFY.title);
  });

  it("gives each line its own copy button, named by its number", () => {
    const lines = ["mkdir v0 && cd v0", "npx probarion verify v0.probarion.near"];
    const html = renderToStaticMarkup(createElement(MainnetVerifyBlock, { lines }));
    expect(html).toContain(MAINNET_VERIFY.title);
    expect([...html.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1])).toEqual([
      "mkdir v0 &amp;&amp; cd v0",
      "npx probarion verify v0.probarion.near",
    ]);
    expect(html).toContain('aria-label="Copy line 1"');
    expect(html).toContain('aria-label="Copy line 2"');
  });
});

describe("the later online run under S2's verify (2026-11-13, 17:52 UTC)", () => {
  const online = text(...S2, "verify-online-2026-11-13.txt");
  const later = MAINNET_PAYOUT.verify.later;
  const said = later.parts.map((p) => (typeof p === "string" ? p : p.label)).join("");

  it("links its output, the same file the status board links", () => {
    const link = later.parts.find((p) => typeof p !== "string");
    expect(typeof link === "object" ? link.href : "?").toBe(BOARD_LINKS.mainnetVerifyOnline);
    expect(LINKS.mainnetVerifyOnline).toBe(
      `${LINKS.github}/blob/main/docs/evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt`,
    );
  });

  it("says what the output says: read-only, 17:52 UTC, O1 and O2 passed on 3 attested decisions, not pinned", () => {
    expect(said).toContain(
      "A later read-only run with `--online`, at 17:52 UTC on 2026-11-13, passed O1 and O2 on the vault's 3 attested decisions.",
    );
    expect(said).toContain("The TEE measurement is not pinned");
    expect(online).toContain("generated 2026-11-13T17:52:06.618Z");
    expect(online).toContain(`entries ${later.entries},`);
    expect(online).toContain("3 attested decisions pass A1");
    expect(online).toContain("online: 3 DCAP-genuine TDX quotes bound to this request (O1");
    expect(online).toContain("verified by NRAS (O2)");
    expect(online).toContain("measurement not pinned");
    expect(online).toContain("RESULT: PASS");
  });

  it("stands under S2's verify alone, the run that read the vault's 6 entries", () => {
    const byId = Object.fromEntries(PAYOUTS.map((p) => [p.id, verifyView(p, PAYOUTS).later]));
    expect(byId["spend-3"]).toEqual([...later.parts]);
    expect(byId["spend-2"]).toBeNull();
  });

  it("makes the status board's pill true on both networks", () => {
    const row = STATUS.rows.find((r) => r.id === "attested-model-run");
    expect(row?.pill).toBe("Checked online on testnet and mainnet, image not pinned");
  });
});
