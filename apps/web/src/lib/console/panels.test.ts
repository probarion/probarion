import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxResult } from "@/lib/near/outcome";
import { approveTx } from "@/lib/near/tx";

// The wallet button is replaced by a stub that records the props it was given, so a test can look
// at what the panel asks the wallet to do and play the wallet's answer back through onResult.

type Captured = {
  label: string;
  expectedSigner?: string;
  prepare?: () => Promise<unknown>;
  onResult?: (r: TxResult) => void | Promise<void>;
  lockKey?: string;
};

const h = vi.hoisted(() => ({
  buttons: [] as Captured[],
  prepareCalls: 0,
  registerCalls: [] as unknown[],
  registerAnswer: { ok: true, vaultId: "" } as unknown,
}));

vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: Captured) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));
vi.mock("@/app/console/actions", () => ({
  prepareCreateVaultAction: async () => {
    h.prepareCalls += 1;
    return { error: "not in this test" };
  },
  registerVaultAction: async (id: unknown) => {
    h.registerCalls.push(id);
    return h.registerAnswer;
  },
}));

import { CreateVaultPanel } from "@/components/console/CreateVaultPanel";
import { VaultTxButton } from "@/components/console/VaultTxButton";
import { SIGNER_OUT_OF_NEAR, VAULT_LOW_SUGGESTION } from "./display";

const NEAR = 10n ** 24n;
const result = (over: Partial<TxResult>): TxResult => ({
  status: "ok",
  txHash: "HashHashHashHashHashHashHashHashHashHashHash",
  code: null,
  error: null,
  ...over,
});

beforeEach(() => {
  h.buttons.length = 0;
  h.prepareCalls = 0;
  h.registerCalls.length = 0;
  h.registerAnswer = { ok: true, vaultId: "" };
});

function renderPanel(owner = "acme.near") {
  const html = renderToStaticMarkup(
    createElement(CreateVaultPanel, {
      factory: "vaults.probarion.near",
      network: "mainnet",
      mode: "global",
      version: 2,
      minDeposit: (NEAR / 2n).toString(),
      defaultDeposit: (NEAR / 2n).toString(),
      owner,
      outOfNearCodes: ["LackBalanceForState", "NotEnoughBalance"],
    }),
  );
  const create = h.buttons.find((b) => b.label === "Create vault in my wallet");
  if (!create) throw new Error("no create button");
  return { html, create };
}

describe("CreateVaultPanel (W-T8-R1 item 1)", () => {
  it("pins the signer to the signed-in account: the factory makes the signer the owner", () => {
    const { create, html } = renderPanel("acme.near");
    expect(create.expectedSigner).toBe("acme.near");
    expect(html).toContain("acme.near");
  });

  it("an unknown outcome never signs again: one registration read, no second prepare", async () => {
    const { create } = renderPanel();
    h.registerAnswer = { ok: false, error: "No vault answers", code: "not_found" };
    await create.onResult?.(result({ status: "unknown", error: "no answer" }));
    expect(h.registerCalls).toHaveLength(1);
    expect(h.prepareCalls).toBe(0);
    expect(h.buttons.filter((b) => b.label === "Create vault in my wallet")).toHaveLength(1);
  });

  it("an ok outcome registers the vault id fixed at signing time", async () => {
    const { create } = renderPanel();
    await create.onResult?.(result({ status: "ok" }));
    expect(h.registerCalls).toEqual([".vaults.probarion.near"]); // the empty name in this render
    expect(h.prepareCalls).toBe(0);
  });

  it("a refused create neither registers nor signs again", async () => {
    const { create } = renderPanel();
    await create.onResult?.(result({ status: "failed", code: "InsufficientDeposit", error: "x" }));
    expect(h.registerCalls).toEqual([]);
    expect(h.prepareCalls).toBe(0);
  });

  it("an out-of-NEAR refusal names the signer first (no vault exists yet to top up)", async () => {
    const { create } = renderPanel();
    const r = result({
      status: "failed",
      code: "NotEnoughBalance",
      error: "vault is out of free NEAR",
    });
    await create.onResult?.(r);
    expect(r.error).toBe(SIGNER_OUT_OF_NEAR);
  });
});

describe("VaultTxButton (W-T8-R1 item 2)", () => {
  const render = (vaultNearLow: boolean) => {
    renderToStaticMarkup(
      createElement(VaultTxButton, {
        label: "Approve",
        network: "mainnet",
        expectedSigner: "cfo.near",
        tx: approveTx("acme.vaults.probarion.near", 7),
        outOfNearCodes: ["LackBalanceForState", "NotEnoughBalance"],
        vaultNearLow,
      }),
    );
    const b = h.buttons.at(-1);
    if (!b) throw new Error("no button");
    return b;
  };

  it("rewords the vault-only SDK text for a console-signed call: the signer first", async () => {
    const b = render(false);
    const r = result({
      status: "failed",
      code: "LackBalanceForState",
      error: "vault is out of free NEAR",
    });
    await b.onResult?.(r);
    expect(r.error).toBe(SIGNER_OUT_OF_NEAR);
    expect(r.error).not.toMatch(/Send NEAR to this vault/);
  });

  it("adds the vault top-up only when the vault's NEAR reads low", async () => {
    const b = render(true);
    const r = result({ status: "failed", code: "NotEnoughBalance", error: "x" });
    await b.onResult?.(r);
    expect(r.error).toBe(`${SIGNER_OUT_OF_NEAR} ${VAULT_LOW_SUGGESTION}`);
  });

  it("leaves every other outcome as the chain worded it", async () => {
    const b = render(true);
    const r = result({ status: "failed", code: "Frozen", error: "PROBARION:Frozen" });
    await b.onResult?.(r);
    expect(r.error).toBe("PROBARION:Frozen");
  });
});
