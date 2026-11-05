import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { FT_STORAGE_DEPOSIT } from "@/lib/near/tx";
import {
  baseCardNotAllowed,
  baseCardNotConfigured,
  deadlineText,
  FUNDING_NOTICE,
  registerDepositText,
  testnetBaseText,
} from "./copy";

// The sentences the top-up page shows, held to the files they come from: if a contract, a runbook or a network
// address changes, these fail until the sentence is true again.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("the testnet text on the Base card", () => {
  const text = testnetBaseText(NETWORKS.testnet);

  it("names the stand-in for Intents and the Base test token from the network table", () => {
    expect(text).toContain(NETWORKS.testnet.intents);
    expect(text).toContain(NETWORKS.testnet.allowedAssets.base);
    expect(NETWORKS.testnet.intents).toBe("intents-stub.probarion.testnet");
    expect(NETWORKS.testnet.allowedAssets.base).toBe("base-usdc.probarion.testnet");
  });

  it("says only what the repository says: Intents has no testnet, the stub stands in, nothing leaves NEAR", () => {
    const stub = read("contracts", "intents-stub", "README.md");
    expect(stub).toContain("where Intents does not exist");
    expect(stub).toContain("Nothing leaves NEAR");
    const runbook = read("docs", "runbooks", "testnet.md");
    expect(runbook).toContain("Intents has no testnet");
    expect(runbook).toContain("`base-usdc`");
    expect(runbook).toMatch(/`usdc`, `base-usdc`, `sol-usdc` \(all `test-ft`\)/);
    expect(read("docs", "runbooks", "web-deploy.md")).toContain(
      "1Click top-up quotes (mainnet only)",
    );
    expect(text).toMatch(/exist on mainnet only/);
    expect(text).toMatch(/nothing leaves NEAR/);
  });

  it("does not promise a Base balance, a bridge or a payout", () => {
    expect(text).not.toMatch(/pays? Base payees/i);
    expect(text).not.toMatch(/bridge|real|value|interfaces/i);
  });
});

describe("the other sentences of the page", () => {
  it("says nothing about a page that is not built", () => {
    for (const s of [
      FUNDING_NOTICE.mainnet,
      FUNDING_NOTICE.testnet,
      baseCardNotConfigured,
      baseCardNotAllowed,
    ]) {
      expect(s).not.toMatch(/\/security|see \//i);
    }
  });

  it("calls testnet tokens test tokens, and claims no real money there", () => {
    expect(FUNDING_NOTICE.testnet).toMatch(/test tokens/);
    expect(FUNDING_NOTICE.testnet).not.toMatch(/real money/i);
    expect(FUNDING_NOTICE.mainnet).toMatch(/real money|your wallet/);
  });

  it("says the owner signs and Probarion does not", () => {
    for (const s of Object.values(FUNDING_NOTICE)) {
      expect(s).toMatch(/you sign/i);
      expect(s).toMatch(/Probarion never signs for you/);
    }
  });

  it("states the NEAR attached to register the deposit address from the transaction builder's own figure", () => {
    expect(FT_STORAGE_DEPOSIT).toBe("1250000000000000000000");
    expect(registerDepositText).toContain("0.00125 NEAR");
  });

  it("writes a deadline as a UTC date and minute", () => {
    expect(deadlineText("2026-11-08T10:30:00.000Z")).toBe("2026-11-08 10:30 UTC");
    expect(deadlineText("2026-11-08T10:30:59Z")).toBe("2026-11-08 10:30 UTC");
  });
});
