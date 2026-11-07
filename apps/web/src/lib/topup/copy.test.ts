import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { FT_STORAGE_DEPOSIT } from "@/lib/near/tx";
import { PRIVACY_PAGE } from "@/lib/site/ops-copy";
import {
  baseCardNotAllowed,
  baseCardNotConfigured,
  DEPOSIT_SENT_DETAIL,
  deadlineText,
  describeDeposit,
  FUNDING_NOTICE,
  faucetAccountText,
  faucetCapText,
  faucetCopy,
  faucetUsedText,
  ONLY_ON_MAINNET,
  registerDepositText,
  testnetBaseText,
  UNCONFIRMED_DEPOSIT_NOTE,
  waitText,
} from "./copy";
import { FAUCET_USDC } from "./faucet";

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

  it("writes the 'mainnet only' sentence in one place, and the testnet card builds on it", () => {
    expect(ONLY_ON_MAINNET).toBe("NEAR Intents and 1Click exist on mainnet only");
    expect(testnetBaseText(NETWORKS.testnet).startsWith(`${ONLY_ON_MAINNET}, so`)).toBe(true);
  });

  it("does not say the swap is done when the NEAR transfer has landed", () => {
    expect(describeDeposit({ status: "ok", txHash: "h", code: null, error: null })).toEqual({
      detail: DEPOSIT_SENT_DETAIL,
    });
    expect(DEPOSIT_SENT_DETAIL).toContain("The NEAR transfer to the deposit address went through.");
    expect(DEPOSIT_SENT_DETAIL).toContain("1Click's step");
    expect(DEPOSIT_SENT_DETAIL).toContain("may not be done yet");
    expect(DEPOSIT_SENT_DETAIL).not.toMatch(/complete|credited|received/i);
  });

  it("tells an unconfirmed deposit from the next quote's, keeping the default words", () => {
    const r = {
      status: "unknown",
      txHash: "h",
      code: "TxOutcomeUnknown",
      error: "no answer",
    } as const;
    expect(describeDeposit(r)).toEqual({
      detail: `TxOutcomeUnknown: no answer ${UNCONFIRMED_DEPOSIT_NOTE}`,
    });
    expect(describeDeposit({ ...r, code: null, error: null })).toEqual({
      detail: UNCONFIRMED_DEPOSIT_NOTE,
    });
    expect(UNCONFIRMED_DEPOSIT_NOTE).toBe(
      "An earlier top-up deposit from this vault is not confirmed. Check it on the explorer before you sign another.",
    );
  });

  it("keeps the default words for a refused or unsent deposit", () => {
    expect(
      describeDeposit({ status: "failed", txHash: "h", code: "x", error: "y" }),
    ).toBeUndefined();
    expect(
      describeDeposit({ status: "failed", txHash: null, code: null, error: "z" }),
    ).toBeUndefined();
  });

  it("writes a deadline as a UTC date and minute", () => {
    expect(deadlineText("2026-11-08T10:30:00.000Z")).toBe("2026-11-08 10:30 UTC");
    expect(deadlineText("2026-11-08T10:30:59Z")).toBe("2026-11-08 10:30 UTC");
  });
});

describe("the testnet faucet's words", () => {
  const copy = faucetCopy(FAUCET_USDC);

  it("says what the audit asked: the fixed amount, test tokens with no value, once a day per vault", () => {
    expect(copy.title).toBe("Add 25 test USDC to this vault");
    expect(copy.note).toBe("Test tokens from the Probarion team, no value. Once a day per vault.");
    expect(copy.button).toBe("Add test USDC");
    expect(copy.done).toBe("Added 25 test USDC to the vault.");
  });

  it("says who signs the mint, so the card's notice that Probarion never signs for you stays true", () => {
    expect(copy.signer).toContain("The Probarion team's key signs this mint, not your wallet");
    expect(copy.signer).toContain("only mint the test token");
    expect(FUNDING_NOTICE.testnet).toMatch(/You sign each top-up in your own wallet/);
  });

  it("claims no real money, and names a contact that exists", () => {
    for (const s of Object.values(copy)) expect(s).not.toMatch(/real money|\$|USD\b/);
    expect(copy.fallback).toContain("@probarionhq");
    expect(copy.unavailable).toContain("@probarionhq");
    expect(read("README.md")).toContain("https://x.com/probarionhq");
  });

  it("says how long to wait in hours, or in minutes under an hour", () => {
    expect(waitText(5 * 3600 - 10)).toBe("about 5 h");
    expect(waitText(3600)).toBe("about 1 h");
    expect(waitText(1799)).toBe("about 30 min");
    expect(waitText(1)).toBe("about 1 min");
    expect(faucetUsedText(7200)).toBe(
      "This vault already got its test USDC today. Try again in about 2 h.",
    );
    expect(faucetAccountText(60, 3)).toBe(
      "Your account already added test USDC to 3 vaults today. Try again in about 1 min.",
    );
    expect(faucetCapText(60)).toBe(
      "Today's test USDC for all vaults is given out. Try again in about 1 min.",
    );
  });

  it("is on /privacy and in the runbooks: the counters, the public mint and the key", () => {
    const operations = PRIVACY_PAGE.sections.find((s) => s.id === "operations");
    const text = operations?.paragraphs.join(" ") ?? "";
    expect(text).toContain(
      "the Add test USDC button counts its mints per vault, per owner account and for all vaults together, each for one UTC day",
    );
    expect(text).toContain("public on chain");
    const runbook = read("docs", "RUNBOOK.md");
    expect(runbook).toContain("## Testnet faucet");
    expect(runbook).toContain("`faucet:testnet:vault:<vault>:<YYYY-MM-DD>`");
    expect(runbook).toContain("`faucet:testnet:account:<account>:<YYYY-MM-DD>`");
    expect(runbook).toContain("faucet.key_not_mint_only");
    expect(runbook).toContain("--function-names 'mint'");
    expect(runbook).toContain("--contract-account-id usdc.probarion.testnet");
    expect(read("docs", "runbooks", "web-deploy.md")).toContain("`TESTNET_FAUCET_KEY`");
  });
});
