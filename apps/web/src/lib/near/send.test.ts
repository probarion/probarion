import { describe, expect, it } from "vitest";
import type { ConfirmRequest, TxResult } from "./outcome";
import { type SendDeps, type SendWallet, sendWalletTx } from "./send";
import { sendNearTx } from "./transfer";
import { approveTx, freezeTx, fundVaultUsdcTx, toPrepared, type WalletTx, withdrawTx } from "./tx";

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
  baseline?: () => Promise<number | null>;
  /** The view's phase callback; by default it records what it was told, and `null` leaves it out. */
  onPhase?: SendDeps["onPhase"] | null;
}) {
  const calls = {
    sign: 0,
    accounts: 0,
    baseline: 0,
    /** What happened, in order: "baseline", "sign". */
    order: [] as string[],
    confirm: [] as ConfirmRequest[],
    params: [] as unknown[],
    /** The wallet asked, the view told, the chain asked, in order: "sign", "phase:confirm", "confirm". */
    steps: [] as string[],
  };
  const wallet: SendWallet = {
    async getAccounts() {
      calls.accounts++;
      if (opts.accountsFail) throw new Error("wallet iframe closed");
      return (opts.accounts ?? [OWNER]).map((accountId) => ({ accountId }));
    },
    async signAndSendTransaction(p) {
      calls.sign++;
      calls.order.push("sign");
      calls.steps.push("sign");
      calls.params.push(p);
      return (opts.signs ?? (async () => ({ transaction: { hash: HASH, signer_id: OWNER } })))();
    },
  };
  const deps: SendDeps = {
    network: "testnet",
    getWallet: opts.getWallet ?? (async () => wallet),
    baseline: async () => {
      calls.baseline++;
      calls.order.push("baseline");
      return opts.baseline ? opts.baseline() : 777;
    },
    confirm: async (request) => {
      calls.confirm.push(request);
      calls.steps.push("confirm");
      return opts.confirm
        ? opts.confirm(request)
        : { status: "ok", txHash: request.hash, code: null, error: null };
    },
  };
  if (opts.onPhase !== null) {
    deps.onPhase = opts.onPhase ?? ((phase) => calls.steps.push(`phase:${phase}`));
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
    expect(calls.confirm).toEqual([
      { hash: HASH, signerId: OWNER, tx: toPrepared(tx), baselineHeight: 777 },
    ]);
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
    const sent = calls.confirm[0]?.tx;
    expect(sent?.actions.map((a) => (a.type === "FunctionCall" ? a.methodName : a.type))).toEqual([
      "storage_deposit",
      "ft_transfer",
    ]);
    expect(sent?.receiverId).toBe("usdc.near");
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
      expect(calls.confirm[0]).toMatchObject({ hash: HASH, signerId: "other.near" });
    });

    it("falls back to the expected signer, then to the connected account, for the lookup", async () => {
      const a = setup({ signs: async () => ({ transaction: { hash: HASH } }) });
      await sendWalletTx(a.deps, freezeTx(VAULT), OWNER);
      expect(a.calls.confirm[0]?.signerId).toBe(OWNER);
      const b = setup({
        accounts: ["solo.near"],
        signs: async () => ({ transaction: { hash: HASH } }),
      });
      await sendWalletTx(b.deps, freezeTx(VAULT));
      expect(b.calls.confirm[0]?.signerId).toBe("solo.near");
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
        confirm: async (request) => ok(request.hash),
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
    expect(calls.confirm).toEqual([
      { hash: HASH, signerId: OWNER, tx: toPrepared(tx), baselineHeight: 777 },
    ]);
    expect(calls.confirm[0]?.tx.actions).toEqual([{ type: "Transfer", deposit: HALF }]);
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
    expect(calls.confirm[0]?.tx.actions).toEqual(toPrepared(both).actions);
  });
});

describe("sendWalletTx: W-T6-R2", () => {
  it("confirms against the expected signer, not the one the wallet says it used", async () => {
    const { deps, calls } = setup({
      accounts: [OWNER],
      signs: async () => ({ transaction: { hash: HASH, signer_id: "stranger.near" } }),
    });
    await sendWalletTx(deps, freezeTx(VAULT), OWNER);
    expect(calls.confirm[0]?.signerId).toBe(OWNER);
  });

  it("without an expected signer, the wallet's word (or its first account) is used and the server still checks it", async () => {
    const { deps, calls } = setup({
      accounts: [OWNER],
      signs: async () => ({ transaction: { hash: HASH, signer_id: "other.near" } }),
    });
    await sendWalletTx(deps, freezeTx(VAULT));
    expect(calls.confirm[0]?.signerId).toBe("other.near");
  });

  it("sends the server the transaction that was shown, action by action, as it went to the wallet", async () => {
    const tx = fundVaultUsdcTx("usdc.near", VAULT, "25000000");
    const { deps, calls } = setup({});
    await sendWalletTx(deps, tx, OWNER);
    const request = calls.confirm[0];
    expect(request?.tx).toEqual(toPrepared(tx));
    expect(request?.tx.actions).toEqual([
      {
        type: "FunctionCall",
        methodName: "storage_deposit",
        args: { account_id: VAULT, registration_only: true },
        deposit: "1250000000000000000000",
        gas: "30000000000000",
      },
      {
        type: "FunctionCall",
        methodName: "ft_transfer",
        args: { receiver_id: VAULT, amount: "25000000", memo: "probarion:fund" },
        deposit: "1",
        gas: "30000000000000",
      },
    ]);
    // what the wallet was asked to sign is the same list
    const asked = calls.params[0] as { actions: WalletTx["actions"] };
    expect(toPrepared({ ...tx, actions: asked.actions })).toEqual(request?.tx);
  });

  describe("the height when the send began", () => {
    it("is read once, before the wallet is asked, and sent with the hash", async () => {
      const { deps, calls } = setup({ baseline: async () => 4242 });
      await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(calls.baseline).toBe(1);
      expect(calls.order).toEqual(["baseline", "sign"]);
      expect(calls.confirm[0]?.baselineHeight).toBe(4242);
    });

    it("is not read at all when the send never reaches the wallet", async () => {
      const { deps, calls } = setup({ accounts: ["stranger.near"] });
      await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(calls.baseline).toBe(0);
    });

    it.each([
      ["a server that cannot say", async () => null],
      ["a server that throws", async () => Promise.reject(new Error("rate limited"))],
      ["a height of 0", async () => 0],
      ["a negative height", async () => -3],
      ["a fractional height", async () => 1.5],
      ["a height as text", async () => "100" as unknown as number],
      ["NaN", async () => Number.NaN],
      ["an unsafe integer", async () => 2 ** 60],
    ])(
      "%s: the owner can still sign (a freeze must not wait on this), but the server is told there is no baseline",
      async (_name, baseline) => {
        const { deps, calls } = setup({ baseline });
        const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
        expect(calls.sign).toBe(1);
        expect(calls.confirm[0]?.baselineHeight).toBeNull();
        expect(r.txHash).toBe(HASH);
      },
    );

    it("a failing baseline read does not leave an unhandled rejection behind when the wallet is cancelled", async () => {
      const unhandled: unknown[] = [];
      const on = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", on);
      const { deps } = setup({
        baseline: async () => Promise.reject(new Error("boom")),
        signs: async () => Promise.reject(new Error("User rejected the request")),
      });
      await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.off("unhandledRejection", on);
      expect(unhandled).toEqual([]);
    });

    it("a baseline that never comes does not stop the wallet from being asked", async () => {
      const { deps, calls } = setup({
        baseline: () => new Promise<number | null>(() => undefined),
        signs: async () => Promise.reject(new Error("User rejected the request")),
      });
      const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
      expect(calls.sign).toBe(1);
      expect(r).toMatchObject({ status: "unknown", txHash: null });
    });
  });
});

describe("sendWalletTx: the confirm phase, for the button's words only", () => {
  it("tells the view once, after the wallet answered with a hash and before NEAR is asked", async () => {
    let answer: (outcome: unknown) => void = () => undefined;
    const { deps, calls } = setup({
      signs: () => new Promise((resolve) => (answer = resolve)),
    });
    const sent = sendWalletTx(deps, freezeTx(VAULT), OWNER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // the wallet is open: still the wallet's phase
    expect(calls.steps).toEqual(["sign"]);
    answer({ transaction: { hash: HASH, signer_id: OWNER } });
    expect(await sent).toEqual(ok());
    expect(calls.steps).toEqual(["sign", "phase:confirm", "confirm"]);
  });

  it("tells it once also for a wallet error that carries a hash, which is checked on chain", async () => {
    const { deps, calls } = setup({
      signs: async () =>
        Promise.reject(Object.assign(new Error("Exceeded 60 seconds"), { txHash: HASH })),
    });
    await sendWalletTx(deps, freezeTx(VAULT), OWNER);
    expect(calls.steps).toEqual(["sign", "phase:confirm", "confirm"]);
  });

  it.each([
    ["a cancel", async () => Promise.reject(new Error("User rejected the request"))],
    ["a closed wallet", async () => Promise.reject(new Error("Wallet closed"))],
    ["an outcome with no transaction", async () => ({ status: { SuccessValue: "" } })],
    ["an empty answer", async () => undefined],
    ["a hash that is not base58", async () => ({ transaction: { hash: "not-a-hash" } })],
  ])("%s: no hash, so the view is not told and NEAR is not asked", async (_name, signs) => {
    const { deps, calls } = setup({ signs });
    expect(await sendWalletTx(deps, freezeTx(VAULT), OWNER)).toMatchObject({
      status: "unknown",
      txHash: null,
    });
    expect(calls.steps).toEqual(["sign"]);
  });

  it("is not told when the send stops before the wallet is asked", async () => {
    const { deps, calls } = setup({ accounts: ["stranger.near"] });
    expect((await sendWalletTx(deps, freezeTx(VAULT), OWNER)).status).toBe("failed");
    expect(calls.steps).toEqual([]);
  });

  it("a view callback that throws changes nothing: one signature, one chain read, the chain's result", async () => {
    const quiet = setup({ onPhase: null });
    const expected = await sendWalletTx(quiet.deps, freezeTx(VAULT), OWNER);
    let told = 0;
    const { deps, calls } = setup({
      onPhase: () => {
        told++;
        throw new Error("the view broke");
      },
    });
    const r = await sendWalletTx(deps, freezeTx(VAULT), OWNER);
    expect(r).toEqual(expected);
    expect(r).toEqual(ok());
    expect(told).toBe(1);
    expect(calls.sign).toBe(1);
    expect(calls.confirm).toEqual(quiet.calls.confirm);
  });

  it("a view callback that throws does not hide what the chain said, a refusal included", async () => {
    const failed: TxResult = { status: "failed", txHash: HASH, code: "NotOwner", error: "panic" };
    const { deps, calls } = setup({
      confirm: async () => failed,
      onPhase: () => {
        throw new Error("the view broke");
      },
    });
    expect(await sendWalletTx(deps, freezeTx(VAULT), OWNER)).toEqual(failed);
    expect(calls.sign).toBe(1);
    expect(calls.confirm).toHaveLength(1);
  });

  it("works the same without a view callback", async () => {
    const { deps, calls } = setup({ onPhase: null });
    expect(deps.onPhase).toBeUndefined();
    expect(await sendWalletTx(deps, freezeTx(VAULT), OWNER)).toEqual(ok());
    expect(calls.steps).toEqual(["sign", "confirm"]);
  });
});
