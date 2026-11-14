// The #mainnet section's question to the mainnet contract (lib/site/mainnet-ask.ts, MainnetAsk.tsx), the no-clone verify
// beside it, its commands folded under its title, the hero's link that starts a payout's check there, and the dated line of the later online run under S2's
// verify. A click sends one view and names a verdict only from the contract's answer; the mandate's facts are held to the
// committed snapshot, the later run's to its output file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MainnetAsk, MainnetVerify, MainnetVerifyBlock } from "@/components/site/MainnetAsk";
import { MainnetPayout } from "@/components/site/MainnetPayout";
import mn from "@/components/site/mainnet.module.css";
import { explorerAccountUrl } from "@/lib/config";
import {
  BOARD_LINKS,
  HERO,
  LINKS,
  LIVE_CHECK,
  MAINNET_ASK,
  MAINNET_PAYOUT,
  MAINNET_VERIFY,
  SAMPLES_MAINNET,
  STATUS,
} from "@/lib/site/facts";
import { heroMainnet } from "@/lib/site/hero-mainnet";
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
import { PAYOUTS, RECORDED_RUNS } from "@/lib/site/mainnet-payout-data";
import { newestFirst, verifyView } from "@/lib/site/mainnet-payout-section";
import { onMainnetRead, requestMainnetRead } from "@/lib/site/mainnet-read";

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
    const amounts = /<fieldset[^>]*>([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? "";
    expect([...amounts.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual([
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
    const V = MAINNET_VERIFY;
    const verify = [V.title, V.intro, V.fold, V.expected, V.caveat, V.evidence.label];
    for (const s of [...strings, ...verify, ...V.blocks.map((b) => b.label)]) {
      expect(s, s).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
      // "read-only" is a plain fact, not an absolute claim.
      expect(s, s).not.toMatch(/\b(first|unhackable|never)\b|(?<!read-)\bonly\b/i);
      expect(s, s).not.toMatch(/test USDC|test tokens?/i);
    }
  });
});

/** Markup text as a browser shows it: the entities React writes, decoded. */
const decoded = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("the no-clone verify block", () => {
  const html = renderToStaticMarkup(createElement(MainnetVerifyBlock));
  const [bash, ps] = MAINNET_VERIFY.blocks;
  const served = join(ROOT, "apps", "web", "public", "samples", "mainnet");
  const evidence = join(ROOT, "docs", "evidence", "mainnet-v0", "no-clone-verify-2026-11-14.txt");

  it("shows the Bash block, then the PowerShell one, each with one copy button named for its shell", () => {
    const blocks = [...html.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
      decoded(m[1] ?? ""),
    );
    expect(blocks).toEqual([bash?.lines.join("\n"), ps?.lines.join("\n")]);
    expect(html).toContain('aria-label="Copy the Bash commands"');
    expect(html).toContain('aria-label="Copy the PowerShell commands"');
    expect(renderToStaticMarkup(createElement(MainnetVerify))).toContain(MAINNET_VERIFY.title);
    // The question holds none of them: the verify is its own group beside it.
    expect(renderToStaticMarkup(createElement(MainnetAsk))).not.toContain(MAINNET_VERIFY.title);
  });

  it("downloads the three files verify reads from this site, then runs probarion 0.1.1 on mainnet", () => {
    expect(SAMPLES_MAINNET).toBe("https://probarion.xyz/samples/mainnet");
    expect(bash?.lines).toEqual([
      "mkdir -p probarion-mainnet && cd probarion-mainnet",
      "B=https://probarion.xyz/samples/mainnet",
      'curl -fsS --create-dirs -o ledger.jsonl "$B/ledger.jsonl" -o mainnet-proof.json "$B/mainnet-proof.json" \\',
      '  -o evidence/v0-decision-m001.json "$B/evidence/v0-decision-m001.json"',
      "npx -y probarion@0.1.1 verify --network mainnet --vault v0.probarion.near \\",
      "  --ledger ledger.jsonl --evidence evidence --proof mainnet-proof.json",
    ]);
    // PowerShell 5.1: curl.exe (curl is another command there), npx.cmd (a Restricted policy blocks npx.ps1), no &&.
    expect(ps?.lines).toEqual([
      "mkdir -Force probarion-mainnet | Out-Null",
      "cd probarion-mainnet",
      '$B = "https://probarion.xyz/samples/mainnet"',
      'curl.exe -fsS --create-dirs -o ledger.jsonl "$B/ledger.jsonl" -o mainnet-proof.json "$B/mainnet-proof.json" -o evidence/v0-decision-m001.json "$B/evidence/v0-decision-m001.json"',
      "npx.cmd -y probarion@0.1.1 verify --network mainnet --vault v0.probarion.near --ledger ledger.jsonl --evidence evidence --proof mainnet-proof.json",
    ]);
    for (const b of MAINNET_VERIFY.blocks) {
      const all = b.lines.join(" ");
      for (const file of MAINNET_VERIFY.files) expect(all).toContain(`-o ${file} "$B/${file}"`);
      // 0.1.1 has no --invoice, and the block runs offline: what it does not check is said under it.
      expect(all).not.toContain("--invoice");
      expect(all).not.toContain("--online");
    }
    expect(MAINNET_VERIFY.expected).toContain("A8 not run");
    expect(MAINNET_VERIFY.caveat).toBe(
      "Without `--online`, check e does not verify the TEE quotes (O1 and O2), and the TEE measurement is not pinned.",
    );
    expect(MAINNET_VERIFY.evidence.href).toBe(
      `${LINKS.github}/blob/main/docs/evidence/mainnet-v0/no-clone-verify-2026-11-14.txt`,
    );
  });

  // The served copies and their recorded runs come in with the samples (apps/web/public/samples/mainnet). Until they are
  // in this checkout there is nothing to hold the block to, and vitest reports this test as skipped.
  it.runIf(existsSync(served))("matches the served files and the recorded runs", () => {
    for (const file of MAINNET_VERIFY.files)
      expect(existsSync(join(served, ...file.split("/"))), file).toBe(true);
    const runs = readFileSync(evidence, "utf8");
    // Every line but the one that names the host: the runs fetched the same bytes from a local copy.
    for (const b of MAINNET_VERIFY.blocks)
      for (const line of b.lines.filter((l) => !l.includes(SAMPLES_MAINNET)))
        expect(runs, line).toContain(line.trim());
    expect(runs).toMatch(/i\s+factory-version\s+SKIP\s+not a factory vault/);
    expect(runs).toContain("8 passed, 0 failed, 0 unproven, 1 skipped");
    expect(runs).toContain("RESULT: PASS");
    expect(runs).toContain("A8 not run");
    expect(runs).toContain("2026-11-13T19:02:25Z Git Bash");
    expect(runs).toContain("Windows PowerShell 5.1");
  });
});

describe("the question beside the verify, after the payouts", () => {
  const html = renderToStaticMarkup(createElement(MainnetPayout));
  const V = MAINNET_VERIFY;
  const groupOf = (title: string) =>
    new RegExp(`<section[^>]*aria-labelledby="${title}"[^>]*>[\\s\\S]*?</section>`).exec(
      html,
    )?.[0] ?? "";
  const ask = groupOf("mainnet-ask-title");
  const verify = groupOf("mainnet-verify-title");
  /** Text between elements: each tag is a space, as between a heading and its paragraph. */
  const words = (h: string) =>
    decoded(h.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  /** Text inside one paragraph: its code and its links read in line, so a tag is dropped. */
  const said = (h: string) =>
    decoded(h.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();

  it("puts the two in one pair, the question first, after the last payout and before the earlier line", () => {
    const pair = html.indexOf(`<div class="${mn.pair}">`);
    expect(pair).toBeGreaterThan(0);
    expect(html.indexOf(ask)).toBeGreaterThan(pair);
    expect(html.indexOf(verify)).toBeGreaterThan(html.indexOf(ask));
    // After every payout's article, so the newest stone and the folds come first.
    expect(pair).toBeGreaterThan(html.lastIndexOf("</article>"));
    expect(html.indexOf(`<p class="${mn.earlierLine}">`)).toBeGreaterThan(html.indexOf(verify));
    // Each is named by its own h3, one level under the section's h2.
    expect(ask).toMatch(/<h3 class="[^"]*" id="mainnet-ask-title">Ask the mainnet contract<\/h3>/);
    expect(verify).toMatch(
      /<h3 class="[^"]*" id="mainnet-verify-title">Verify the vault yourself<\/h3>/,
    );
  });

  it("keeps the question open: its amounts, its answer and its facts sit in no fold", () => {
    expect(ask).not.toContain("<details");
    expect(said(ask)).toContain(MAINNET_ASK.lede.replace(/`/g, ""));
    expect(ask).toContain(`aria-label="${MAINNET_ASK.amountsLabel}"`);
    expect(ask).toContain('aria-live="polite"');
  });

  it("shows the verify's title and what it does, and folds its commands in a closed drawer under them", () => {
    const drawer = verify.indexOf(`<details class="${mn.drawer}">`);
    expect(drawer).toBeGreaterThan(0);
    // One drawer, with no open attribute: it starts closed and opens with no script.
    expect(verify.match(/<details\b[^>]*>/g)).toEqual([`<details class="${mn.drawer}">`]);
    expect(words(verify.slice(0, drawer))).toBe(`${V.title} ${V.intro}`);
    const summary = verify.slice(drawer, verify.indexOf("</summary>"));
    expect(words(summary)).toBe(`${V.fold} ↓`);
    expect(summary).toMatch(/<span class="[^"]*" aria-hidden="true">↓<\/span>/);
    // In the drawer: both blocks with their copy buttons, then what the run prints and its recorded runs.
    const body = verify.slice(verify.indexOf("</summary>"));
    const blocks = [...body.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)];
    expect(blocks.map((m) => decoded(m[1] ?? ""))).toEqual(V.blocks.map((b) => b.lines.join("\n")));
    expect(body).toContain('aria-label="Copy the Bash commands"');
    expect(body).toContain('aria-label="Copy the PowerShell commands"');
    expect(said(body)).toContain(V.expected.replace(/`/g, ""));
    expect(body).toContain(`href="${V.evidence.href}"`);
    expect(V.fold).toBe("The commands, for Bash and PowerShell 5.1");
  });

  it("sets the two side by side from 961px, and stacks them, the question first, at 960px and under", () => {
    const css = readFileSync(
      join(ROOT, "apps", "web", "src", "components", "site", "mainnet.module.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf("\n.pair {");
    expect(css.slice(at, css.indexOf("}", at))).toMatch(
      /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/,
    );
    const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
    expect(narrow.slice(0, narrow.indexOf("\n}"))).toMatch(
      /\n {2}\.pair \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    // No other width changes the pair.
    expect(css.match(/\.pair \{/g)).toHaveLength(2);
  });
});

describe("the hero's Read the chain now", () => {
  it("asks only the stone of its payout to read, until that stone stops listening", () => {
    vi.stubGlobal("window", new EventTarget());
    try {
      const runs: string[] = [];
      const stop3 = onMainnetRead("spend-3", () => runs.push("spend-3"));
      const stop2 = onMainnetRead("spend-2", () => runs.push("spend-2"));
      requestMainnetRead("spend-3");
      expect(runs).toEqual(["spend-3"]);
      stop3();
      requestMainnetRead("spend-3");
      expect(runs).toEqual(["spend-3"]);
      requestMainnetRead("spend-2");
      expect(runs).toEqual(["spend-3", "spend-2"]);
      stop2();
      requestMainnetRead("spend-2");
      expect(runs).toEqual(["spend-3", "spend-2"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the payout #mainnet shows first and open, with its own check", () => {
    const id = heroMainnet()?.payoutId;
    expect(id).toBe("spend-3");
    // The newest run is the open one: a folded payout's check would run out of sight.
    expect(newestFirst(RECORDED_RUNS)[0]?.payout.id).toBe(id);
    const html = renderToStaticMarkup(createElement(MainnetPayout));
    expect(html).toMatch(/^<section[^>]*id="mainnet"/);
    expect(html).toContain(`id="${id}-title"`);
    expect(HERO.s2.read.href).toBe("#mainnet");
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
