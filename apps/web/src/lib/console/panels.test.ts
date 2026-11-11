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
  describe?: (r: TxResult) => { headline?: string; detail?: string | null } | null | undefined;
  lockKey?: string;
};

const h = vi.hoisted(() => ({
  buttons: [] as Captured[],
  prepareCalls: 0,
  registerCalls: [] as unknown[],
  registerAnswer: { ok: true, vaultId: "" } as unknown,
  pushes: [] as string[],
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: (href: string) => h.pushes.push(href) }),
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
  h.pushes.length = 0;
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

  it("wraps a 64-character implicit owner at phone width, in its monospace span", () => {
    const implicit = "35008ecd0f274c7af302e0ecbcfe39211231069c3953cdb228ff5eca1399242b";
    const { html } = renderPanel(implicit);
    expect(html).toMatch(
      new RegExp(`<span class="[^"]*\\bmono\\b[^"]*\\bwrap-anywhere\\b[^"]*">${implicit}</span>`),
    );
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

  it("opens the new vault's page once it is registered (site audit P1-8)", async () => {
    const { create } = renderPanel();
    await create.onResult?.(result({ status: "ok" }));
    expect(h.pushes).toEqual([`/console/${encodeURIComponent(".vaults.probarion.near")}`]);
  });

  it("opens it too after an unknown outcome, when the one registration read finds it", async () => {
    const { create } = renderPanel();
    await create.onResult?.(result({ status: "unknown", error: "no answer" }));
    expect(h.pushes).toHaveLength(1);
  });

  it("stays on the page when the registration fails, so its reason stays on screen", async () => {
    const { create } = renderPanel();
    h.registerAnswer = { ok: false, error: "Not this account's vault.", code: "forbidden" };
    await create.onResult?.(result({ status: "ok" }));
    expect(h.pushes).toEqual([]);
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

  it("rewords the vault-only SDK text for a console-signed call: the signer first", () => {
    const b = render(false);
    const r = result({
      status: "failed",
      code: "LackBalanceForState",
      error: "vault is out of free NEAR",
    });
    const words = b.describe?.(r);
    expect(words?.detail).toBe(SIGNER_OUT_OF_NEAR);
    expect(words?.detail).not.toMatch(/Send NEAR to this vault/);
    // the words are set at display time: the result object itself is not changed
    expect(r.error).toBe("vault is out of free NEAR");
  });

  it("adds the vault top-up only when the vault's NEAR reads low", () => {
    const b = render(true);
    const r = result({ status: "failed", code: "NotEnoughBalance", error: "x" });
    expect(b.describe?.(r)?.detail).toBe(`${SIGNER_OUT_OF_NEAR} ${VAULT_LOW_SUGGESTION}`);
    expect(r.error).toBe("x");
  });

  it("leaves every other outcome as the chain worded it", () => {
    const b = render(true);
    const r = result({ status: "failed", code: "Frozen", error: "PROBARION:Frozen" });
    expect(b.describe?.(r)).toBeUndefined();
    expect(r.error).toBe("PROBARION:Frozen");
  });

  it("rewords a locked send read back after a reload: it never went through onResult", () => {
    const b = render(false);
    const restored = result({
      status: "unknown",
      code: "LackBalanceForState",
      error: "vault is out of free NEAR",
    });
    expect(b.describe?.(restored)?.detail).toBe(SIGNER_OUT_OF_NEAR);
  });

  it("still tells the wrapper about a live result through onResult (for the top-up link)", async () => {
    const b = render(true);
    await expect(
      Promise.resolve(b.onResult?.(result({ status: "failed", code: "NotEnoughBalance" }))),
    ).resolves.toBeUndefined();
  });
});
