// `run demo` offline: the SDK's test double chain on 127.0.0.1, no network (test/setup/no-network.ts refuses
// any other host), and a time line under the 2-minute limit.
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_LIMIT_MS, DemoUsageError, runDemo } from "../src/demo.js";
import type { Receipt } from "../src/receipts.js";

describe("run demo, offline", () => {
  it("makes one negotiated sale with its payout, walks away from one counter, is refused once, in under 2 minutes", async () => {
    const lines: string[] = [];
    const summary = await runDemo({ env: {}, out: (l) => lines.push(l) });
    try {
      const text = lines.join("\n");
      expect(summary).toMatchObject({
        mode: "offline",
        ok: true,
        spendRequests: 2,
        payoutUnits: "10000",
      });
      expect(summary.results.map((r) => r.kind)).toEqual(["paid", "walked_away", "refused"]);
      expect(summary.results[1]).toMatchObject({ answer: { status: 409, reason: "below_floor" } });
      expect(summary.results[2]).toMatchObject({
        spend: { status: "refused_by_code", code: "mandate.uses_exhausted" },
        contract: { ok: false, code: "UsesExhausted" },
      });
      expect(text).toContain("countered once at 0.01, taken as quote");
      expect(text).toContain("data check passed");
      expect(text).toContain("409 below_floor. Walked away: no payment was asked for.");
      expect(text).toContain("Payout: near:vendor.testnet got 0.01 USDC");
      expect(text).toContain("All three calls ended as expected.");
      // The floors are not printed: 0.009 for /forecast and 0.03 for /premium.
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
        tx: null,
        test_double: true,
        data_check: { ok: true },
      });
    } finally {
      rmSync(dirname(summary.receiptsPath), { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a half-set environment instead of guessing the network", async () => {
    await expect(
      runDemo({ env: { PROBARION_VAULT_ID: "x.vaults.probarion.testnet" }, out: () => {} }),
    ).rejects.toThrow(DemoUsageError);
    await expect(
      runDemo({
        env: {
          PROBARION_VAULT_ID: "x.vaults.probarion.near",
          PROBARION_AGENT_KEY: "ed25519:x",
          PROBARION_LEDGER_KEY: "ed25519:y",
        },
        out: () => {},
      }),
    ).rejects.toThrow(/testnet only/);
  });
});
