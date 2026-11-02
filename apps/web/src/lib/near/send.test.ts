import { describe, expect, it } from "vitest";
import type { TxResult } from "./outcome";
import { type SendDeps, type SendWallet, sendWalletTx } from "./send";
import { sendNearTx } from "./transfer";
import { approveTx, freezeTx, fundVaultUsdcTx, type WalletTx, withdrawTx } from "./tx";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const VAULT = "acme.vaults.probarion.near";
const OWNER = "owner.near";
const APPROVER = "cfo.near";

type Confirm = SendDeps["confirm"];

function setup(opts: {
  accounts?: string[];
  signs?: () => Promise<unknown>;
  confirm?: Confirm;
  getWallet?: () => Promise<SendWallet>;
  accountsFail?: boolean;
}) {
  const calls = {
    sign: 0,
    accounts: 0,
    confirm: [] as Parameters<Confirm>[],
    params: [] as unknown[],
  };
  const wallet: SendWallet = {
    async getAccounts() {
      calls.accounts++;
      if (opts.accountsFail) throw new Error("wallet iframe closed");
      return (opts.accounts ?? [OWNER]).map((accountId) => ({ accountId }));
    },
    async signAndSendTransaction(p) {
      calls.sign++;
      calls.params.push(p);
      return (opts.signs ?? (async () => ({ transaction: { hash: HASH, signer_id: OWNER } })))();
    },
  };
  const deps: SendDeps = {
    network: "testnet",
    getWallet: opts.getWallet ?? (async () => wallet),
    confirm:
      opts.confirm ??
      (async (hash, signer, method, receiver) => {
        calls.confirm.push([hash, signer, method, receiver]);
        return { status: "ok", txHash: hash, code: null, error: null };
      }),
  };
  if (opts.confirm !== undefined) {
    const inner = opts.confirm;
    deps.confirm = async (...args) => {
      calls.confirm.push(args);
      return inner(...args);
    };
  }
  return { deps, calls, wallet };
}

const ok = (hash = HASH): TxResult => ({ status: "ok", txHash: hash, code: null, error: null });

describe("sendWalletTx", () => {
  it("asks the wallet once, then asks the chain, and returns what the chain says", async () => {
    const { deps, calls } = setup({});
    const tx = freezeTx(VAULT);
    const r = await sendWalletTx(deps, tx, OWNER);
    expect(r).toEqual(ok());
    expect(calls.sign).toBe(1);
    expect(calls.confirm).toEqual([[HASH, OWNER, "freeze", VAULT]]);
    expect(calls.params).toEqual([
      { network: "testnet", receiverId: VAULT, actions: tx.actions, signerId: OWNER },
    ]);
  });

  it("omits signerId when the caller names none", async () => {
    const { deps, calls } = setup({});
    await sendWalletTx(deps, freezeTx(VAULT));
    expect(calls.params[0]).not.toHaveProperty("signerId");
  });

  it("uses the LAST action's method, so a funding transaction is read as ft_transfer", async () => {
    const { deps, calls } = setup({});
    await sendWalletTx(deps, fundVaultUsdcTx("usdc.near", VAULT, "5"), OWNER);
    expect(calls.confirm[0]?.[2]).toBe("ft_transfer");
    expect(calls.confirm[0]?.[3]).toBe("usdc.near");
  });

  describe("the wallet's own answer is never believed", () => {
    it.each([
      ["a success", { status: { SuccessValue: "" } }],
      ["a failure", { status: { Failure: { ActionError: { kind: "x" } } } }],
      ["a paid approve", { status: { SuccessValue: "eyJzdGF0dXMiOiJwYWlkIn0=" } }],
      ["nothing", {}],
    ])("%s from the wallet: the result is what the chain says", async (_name, claim) => {
      const failedOnChain: TxResult = {
        status: "failed",
        txHash: HASH,
        code: "NotApprover",
        error: "panic",
      };
      const { deps } = setup({
        signs: async () => ({ ...claim, transaction: { hash: HASH, signer_id: APPROVER } }),
        confirm: async () => failedOnChain,
        accounts: [APPROVER],
      });
      expect(await sendWalletTx(deps, approveTx(VAULT, 4), APPROVER)).toEqual(failedOnChain);
    });

    it("takes only the hash and the signer from the wallet's outcome", async () => {
      const { deps, calls } = setup({
        accounts: [OWNER, "other.near"],
        signs: async () => ({ transaction: { hash: HASH, signer_id: "other.near" } }),
      });
      await sendWalletTx(deps, freezeTx(VAULT));
      expect(calls.confirm[0]).toEqual([HASH, "other.near", "freeze", VAULT]);
    });

    it("falls back to the expected signer, then to the connected account, for the lookup", async () => {
      const a = setup({ signs: async () => ({ transaction: { hash: HASH } }) });
      await sendWalletTx(a.deps, freezeTx(VAULT), OWNER);
      expect(a.calls.confirm[0]?.[1]).toBe(OWNER);
      const b = setup({
        accounts: ["solo.near"],
        signs: async () => ({ transaction: { hash: HASH } }),
      });
      await sendWalletTx(b.deps, freezeTx(VAULT));
      expect(b.calls.confirm[0]?.[1]).toBe("solo.near");
    });

    it("the result carries the hash it was asked about, even if the server's answer names another", async () => {
      const other = HASH.replace("9", "8");
      const { deps } = setup({ confirm: async () => ok(other) });
      expect((await sendWalletTx(deps, freezeTx(VAULT), OWNER)).txHash).toBe(HASH);
    });

    it("a server answer that is not a result is unconfirmed, never ok", async () => {
      for (const junk of [null, undefined, "ok", 5, {}, { status: "success" }, { status: "OK" }]) {
        const { deps } = setup({ confirm: async () => junk as unknown as TxResult });
        const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
        expect(r.status, JSON.stringify(junk)).toBe("unknown");
        expect(r.txHash).toBe(HASH);
      }
    });

    it("a confirmation that throws is unknown with the hash, and the wallet was not asked again", async () => {
      const { deps, calls } = setup({
        confirm: async () => {
          throw new Error("server action failed");
        },
      });
      const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(r).toMatchObject({ status: "unknown", txHash: HASH });
      expect(r.error).toMatch(/confirm on the explorer/);
      expect(calls.sign).toBe(1);
    });
  });

  describe("no hash: not confirmed, because a cancel and a sent transaction look the same", () => {
    it.each([
      ["a cancel", async () => Promise.reject(new Error("User rejected the request"))],
      ["a closed wallet", async () => Promise.reject(new Error("User closed the window"))],
      ["an outcome with no transaction", async () => ({ status: { SuccessValue: "" } })],
      ["an empty answer", async () => undefined],
      ["a null answer", async () => null],
    ])("%s", async (_name, signs) => {
      const { deps, calls } = setup({ signs });
      const r = await sendWalletTx(deps, withdrawTx(VAULT, "5"), OWNER);
      expect(r).toMatchObject({ status: "unknown", txHash: null });
      expect(calls.sign).toBe(1);
      expect(calls.confirm).toEqual([]);
    });

    it("keeps the wallet's words for the owner", async () => {
      const { deps } = setup({
        signs: async () => Promise.reject(new Error("User rejected the request")),
      });
      expect((await sendWalletTx(deps, freezeTx(VAULT), OWNER)).error).toBe(
        "User rejected the request",
      );
    });

    it("a hash that is not base58 is no hash", async () => {
      const { deps, calls } = setup({
        signs: async () => ({ transaction: { hash: "not-a-hash", signer_id: OWNER } }),
      });
      expect(await sendWalletTx(deps, freezeTx(VAULT), OWNER)).toMatchObject({
        status: "unknown",
        txHash: null,
      });
      expect(calls.confirm).toEqual([]);
    });
  });

  describe("a wallet error that carries a hash is checked on chain, not trusted", () => {
    it("asks the chain about the transaction the error names", async () => {
      const { deps, calls } = setup({
        signs: async () =>
          Promise.reject(Object.assign(new Error("Exceeded 60 seconds"), { txHash: HASH })),
        confirm: async (hash) => ({ status: "ok", txHash: hash, code: null, error: null }),
      });
      const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(r).toEqual(ok());
      expect(calls.sign).toBe(1);
      expect(calls.confirm).toHaveLength(1);
    });

    it("a timeout with no hash is not confirmed", async () => {
      const { deps, calls } = setup({
        signs: async () =>
          Promise.reject(new Error("Exceeded 60 seconds waiting for the transaction")),
      });
      expect(await sendWalletTx(deps, freezeTx(VAULT), OWNER)).toMatchObject({
        status: "unknown",
        txHash: null,
      });
      expect(calls.sign).toBe(1);
    });
  });

  describe("never signs twice", () => {
    it.each([
      ["a resolved outcome", async () => ({ transaction: { hash: HASH, signer_id: OWNER } })],
      ["a cancel", async () => Promise.reject(new Error("User rejected"))],
      ["a timeout", async () => Promise.reject(new Error("TIMEOUT_ERROR"))],
      [
        "a hash on an error",
        async () => Promise.reject(Object.assign(new Error("x"), { txHash: HASH })),
      ],
      ["nothing", async () => undefined],
      [
        "a synchronous throw",
        () => {
          throw new Error("PROBARION:RequiresOneYocto");
        },
      ],
    ])("asks the wallet exactly once after %s", async (_name, signs) => {
      const { deps, calls } = setup({ signs: signs as () => Promise<unknown> });
      await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(calls.sign).toBe(1);
    });

    it("asks the chain at most once, and never throws", async () => {
      const { deps, calls } = setup({
        confirm: async () => {
          throw new Error("x");
        },
      });
      await expect(sendWalletTx(deps, freezeTx(VAULT), OWNER)).resolves.toBeDefined();
      expect(calls.confirm).toHaveLength(1);
      expect(calls.sign).toBe(1);
    });

    it("a hostile error object cannot make it throw", async () => {
      const hostile = {
        get message(): string {
          throw new Error("boom");
        },
        get cause(): unknown {
          throw new Error("boom");
        },
      };
      const { deps } = setup({ signs: async () => Promise.reject(hostile) });
      await expect(sendWalletTx(deps, freezeTx(VAULT), OWNER)).resolves.toMatchObject({
        status: "unknown",
        txHash: null,
      });
    });
  });

  describe("before anything is signed", () => {
    it("no wallet to talk to: not sent, and nobody was asked to sign", async () => {
      const { deps, calls } = setup({
        getWallet: async () => {
          throw new Error("Wallet is still loading");
        },
      });
      expect(await sendWalletTx(deps, freezeTx(VAULT), OWNER)).toEqual({
        status: "failed",
        txHash: null,
        code: null,
        error: "Wallet is still loading",
      });
      expect(calls.sign).toBe(0);
    });

    it("a wallet connected as someone else (also right after connect): refused before a signature is requested", async () => {
      const { deps, calls } = setup({ accounts: ["stranger.near"] });
      const r = await sendWalletTx(deps, approveTx(VAULT, 4), APPROVER);
      expect(r).toMatchObject({ status: "failed", txHash: null });
      expect(r.error).toBe(`Your wallet is connected as stranger.near; switch to ${APPROVER}.`);
      expect(calls.sign).toBe(0);
      expect(calls.confirm).toEqual([]);
    });

    it("the expected signer may be any of the wallet's accounts", async () => {
      const { deps, calls } = setup({ accounts: ["a.near", APPROVER] });
      await sendWalletTx(deps, approveTx(VAULT, 4), APPROVER);
      expect(calls.sign).toBe(1);
    });

    it("a wallet that cannot list its accounts: not sent", async () => {
      const { deps, calls } = setup({ accountsFail: true });
      const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(r).toMatchObject({ status: "failed", txHash: null });
      expect(r.error).toMatch(/Could not read your wallet's accounts/);
      expect(calls.sign).toBe(0);
    });

    it("no accounts at all, when a signer is expected: refused", async () => {
      const { deps, calls } = setup({ accounts: [] });
      const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(r.error).toMatch(/no account/);
      expect(calls.sign).toBe(0);
    });

    it("a transaction whose last call this console cannot read is never sent", async () => {
      const { deps, calls } = setup({});
      const tx: WalletTx = {
        receiverId: VAULT,
        summary: "spend",
        actions: [
          {
            type: "FunctionCall",
            params: { methodName: "spend", args: {}, gas: "1", deposit: "0" },
          },
        ],
      };
      expect((await sendWalletTx(deps, tx, OWNER)).status).toBe("failed");
      expect((await sendWalletTx(deps, { ...tx, actions: [] }, OWNER)).status).toBe("failed");
      expect(calls.accounts).toBe(0);
      expect(calls.sign).toBe(0);
    });
  });
});

describe("sendWalletTx: a plain NEAR transfer (Send NEAR to this vault)", () => {
  const HALF = "500000000000000000000000";

  it("hands the Transfer action to the wallet unchanged, once, and reads it back as a Transfer", async () => {
    const { deps, calls } = setup({});
    const tx = sendNearTx(VAULT, HALF);
    const r = await sendWalletTx(deps, tx, OWNER);
    expect(r).toEqual(ok());
    expect(calls.sign).toBe(1);
    expect(calls.params).toEqual([
      { network: "testnet", receiverId: VAULT, actions: tx.actions, signerId: OWNER },
    ]);
    expect(calls.params[0]).toHaveProperty("actions", [
      { type: "Transfer", params: { deposit: HALF } },
    ]);
    expect(calls.confirm).toEqual([[HASH, OWNER, "Transfer", VAULT]]);
  });

  it("is checked on chain like any other: the chain's failure is the result", async () => {
    const failed: TxResult = {
      status: "failed",
      txHash: HASH,
      code: null,
      error: "AccountDoesNotExist",
    };
    const { deps } = setup({ confirm: async () => failed });
    expect(await sendWalletTx(deps, sendNearTx(VAULT, HALF), OWNER)).toEqual(failed);
  });

  it("a cancel is not confirmed, and the wallet is asked once", async () => {
    const { deps, calls } = setup({
      signs: async () => Promise.reject(new Error("User rejected the request")),
    });
    expect(await sendWalletTx(deps, sendNearTx(VAULT, HALF), OWNER)).toMatchObject({
      status: "unknown",
      txHash: null,
    });
    expect(calls.sign).toBe(1);
    expect(calls.confirm).toEqual([]);
  });

  it("the signer check applies: a wallet connected as someone else is refused before signing", async () => {
    const { deps, calls } = setup({ accounts: ["stranger.near"] });
    expect((await sendWalletTx(deps, sendNearTx(VAULT, HALF), OWNER)).status).toBe("failed");
    expect(calls.sign).toBe(0);
  });

  it("a transfer followed by a call is read by the call", async () => {
    const { deps, calls } = setup({});
    const transfer = sendNearTx(VAULT, HALF);
    const call = freezeTx(VAULT);
    const both: WalletTx = {
      receiverId: VAULT,
      summary: "both",
      actions: [...transfer.actions, ...call.actions],
    };
    await sendWalletTx(deps, both, OWNER);
    expect(calls.confirm[0]?.[2]).toBe("freeze");
  });
});
