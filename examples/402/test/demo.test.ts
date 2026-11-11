// `run demo` offline: the SDK's test double chain on 127.0.0.1, no network (test/setup/no-network.ts refuses
// any other host), and a time line under the 2-minute limit. Offline is the default whatever the environment
// holds; testnet needs --testnet.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_LIMIT_MS, DemoUsageError, runDemo, testnetFlag } from "../src/demo.js";
import {
  DEFAULT_RECEIPTS_PATH,
  fromCallerDir,
  ledgerLine,
  ledgerPathOf,
  receiptsPathOf,
} from "../src/mcp-stdio.js";
import type { Receipt } from "../src/receipts.js";

const KEYS = {
  PROBARION_VAULT_ID: "x.vaults.probarion.testnet",
  PROBARION_AGENT_KEY: "ed25519:x",
  PROBARION_LEDGER_KEY: "ed25519:y",
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("run demo, offline", () => {
  it("walks away from one counter, makes one negotiated sale with its payout, is refused once, in under 2 minutes", async () => {
    const lines: string[] = [];
    const summary = await runDemo({ env: {}, out: (l) => lines.push(l) });
    dirs.push(dirname(summary.receiptsPath));
    const text = lines.join("\n");
    expect(summary).toMatchObject({
      mode: "offline",
      ok: true,
      spendRequests: 2,
      payoutUnits: "10000",
    });
    expect(summary.results.map((r) => r.kind)).toEqual(["walked_away", "paid", "refused"]);
    expect(summary.results[0]).toMatchObject({
      deal: { mandateProblem: null },
      answer: { status: 409, reason: "below_floor" },
    });
    expect(summary.results[1]).toMatchObject({
      deal: { countered: true, listUnits: "12000", priceUnits: "10000" },
    });
    expect(summary.results[2]).toMatchObject({
      priceUsdc: "0.01",
      deal: { countered: false, mandateProblem: "has no payment left" },
      spend: { status: "refused_by_code", code: "mandate.uses_exhausted" },
      contract: { ok: false, code: "UsesExhausted" },
    });
    expect(text).toContain(
      "#1 402 for 0.05 USDC, above the mandate's 0.01: countered once at 0.01",
    );
    expect(text).toContain("409 below_floor. Walked away: no payment was asked for.");
    expect(text).toContain(
      "#2 402 for 0.012 USDC, above the mandate's 0.01: countered once at 0.01, taken as quote",
    );
    expect(text).toContain("data check passed");
    expect(text).toContain(
      "#3 402 for 0.01 USDC (mandate 1 has no payment left) -> refused_by_code",
    );
    expect(text).toContain("request_spend was called 2 times: for calls 2 and 3");
    expect(text).toContain("Payout: near:vendor.testnet got 0.01 USDC");
    expect(text).toContain("All three calls ended as expected.");
    expect(text).not.toContain("not used");
    // The floors are not printed: 0.03 for /premium and 0.009 for /forecast.
    expect(text).not.toMatch(/0\.009\b|\b0\.03\b/);

    const time = /^Demo finished in ([0-9.]+) s \(limit 120 s\)\.$/m.exec(text);
    expect(time).not.toBeNull();
    expect(Number(time?.[1]) * 1000).toBeLessThan(DEMO_LIMIT_MS);
    expect(summary.elapsedMs).toBeLessThan(DEMO_LIMIT_MS);

    const receipts = readFileSync(summary.receiptsPath, "utf8").trimEnd().split("\n");
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0] ?? "") as Receipt).toMatchObject({
      countered: true,
      list_price_usdc: "0.012",
      paid_usdc: "0.01",
      spend_id: 1,
      request_status: "paid",
      tx: null,
      test_double: true,
      data_check: { ok: true },
    });
  }, 120_000);

  it("stays offline with keys and RECEIPTS_PATH in the environment, says so, and writes no receipt there", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "probarion-402-demo-test-"));
    dirs.push(elsewhere);
    const receiptsEnv = join(elsewhere, "receipts.jsonl");
    const lines: string[] = [];
    const summary = await runDemo({
      env: { ...KEYS, RECEIPTS_PATH: receiptsEnv },
      out: (l) => lines.push(l),
    });
    dirs.push(dirname(summary.receiptsPath));
    expect(summary).toMatchObject({ mode: "offline", ok: true, spendRequests: 2 });
    expect(lines).toContain(
      "PROBARION_VAULT_ID, PROBARION_AGENT_KEY, PROBARION_LEDGER_KEY, RECEIPTS_PATH are set and not used: this run is offline, and its receipts go to a temp folder. Add --testnet to run on testnet.",
    );
    expect(summary.receiptsPath).not.toBe(receiptsEnv);
    expect(existsSync(summary.receiptsPath)).toBe(true);
    expect(existsSync(receiptsEnv)).toBe(false);
  }, 120_000);

  it("is not ok past the time limit, even when the three calls end as expected", async () => {
    let t = 0;
    const lines: string[] = [];
    const summary = await runDemo({
      env: {},
      out: (l) => lines.push(l),
      // The first read is the start, the second the end: 200 s apart.
      clock: () => {
        const now = t;
        t += 200_000;
        return now;
      },
    });
    dirs.push(dirname(summary.receiptsPath));
    expect(summary.results.map((r) => r.kind)).toEqual(["walked_away", "paid", "refused"]);
    expect(summary).toMatchObject({ ok: false, elapsedMs: 200_000 });
    expect(lines).toContain("All three calls ended as expected.");
    expect(lines).toContain(
      "Demo finished in 200.0 s (limit 120 s): over the limit, so NOT as expected.",
    );
  }, 120_000);
});

describe("run demo --testnet", () => {
  it("reads only --testnet, with or without pnpm's --", () => {
    expect(testnetFlag([])).toBe(false);
    expect(testnetFlag(["--"])).toBe(false);
    expect(testnetFlag(["--testnet"])).toBe(true);
    expect(testnetFlag(["--", "--testnet"])).toBe(true);
    expect(() => testnetFlag(["--mainnet"])).toThrow(DemoUsageError);
    expect(() => testnetFlag(["--testnet", "--testnet"])).toThrow(DemoUsageError);
  });

  it("needs all three keys and a .testnet vault, and refuses before any network", async () => {
    await expect(
      runDemo({
        env: { PROBARION_VAULT_ID: KEYS.PROBARION_VAULT_ID },
        out: () => {},
        testnet: true,
      }),
    ).rejects.toThrow(/Missing: PROBARION_AGENT_KEY, PROBARION_LEDGER_KEY/);
    await expect(
      runDemo({
        env: { ...KEYS, PROBARION_VAULT_ID: "x.vaults.probarion.near" },
        out: () => {},
        testnet: true,
      }),
    ).rejects.toThrow(/testnet only/);
  });

  it("resolves PROBARION_LEDGER_PATH and RECEIPTS_PATH against the folder pnpm was started in", () => {
    const root = resolve(tmpdir(), "probarion-repo-root");
    const env = {
      INIT_CWD: root,
      PROBARION_LEDGER_PATH: "docs/evidence/402-vault/ledger.jsonl",
      RECEIPTS_PATH: "receipts-402.jsonl",
    };
    expect(fromCallerDir(env, "a/b.jsonl")).toBe(join(root, "a", "b.jsonl"));
    expect(ledgerPathOf(env)).toBe(join(root, "docs", "evidence", "402-vault", "ledger.jsonl"));
    expect(receiptsPathOf(env)).toBe(join(root, "receipts-402.jsonl"));
    expect(ledgerLine(env, "v.testnet")).toBe(
      `Ledger file: ${join(root, "docs", "evidence", "402-vault", "ledger.jsonl")}`,
    );
    const absolute = resolve(tmpdir(), "elsewhere", "ledger.jsonl");
    expect(ledgerPathOf({ INIT_CWD: root, PROBARION_LEDGER_PATH: absolute })).toBe(absolute);
    // Unset: the server's default ledger, and the example's own (git-ignored) receipts file.
    expect(ledgerPathOf({ INIT_CWD: root })).toBeNull();
    expect(ledgerLine({}, "v.testnet")).toContain("~/.probarion/v.testnet/ledger.jsonl");
    expect(receiptsPathOf({ INIT_CWD: root })).toBe(DEFAULT_RECEIPTS_PATH);
    expect(DEFAULT_RECEIPTS_PATH).toBe(
      fileURLToPath(new URL("../receipts.jsonl", import.meta.url)),
    );
  });
});
