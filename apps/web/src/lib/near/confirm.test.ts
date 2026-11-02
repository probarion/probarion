import { OUT_OF_GAS_NEAR_DETAIL, OUT_OF_NEAR_DETAIL } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import trees from "../../../test/fixtures/testnet-spend-trees.json";
import { confirmTx, type RpcLike } from "./confirm";
import type { TxResult } from "./outcome";

// Real `tx` RPC results from the testnet smoke run (contracts/deployments/testnet.json): three spends,
// signed by the vault itself with the agent key. `approve` runs the same payout and callback chain, so
// its tree has the same shape; the tests turn these into approve transactions and break them the ways
// the contracts can break (the receipt chains are in contracts/vault/src/{held,spend}.rs).

// biome-ignore lint/suspicious/noExplicitAny: raw RPC JSON, taken apart and broken on purpose
type Json = Record<string, any>;
const clone = <T>(x: T): T => structuredClone(x);
const real = trees as unknown as { paid: Json; burned: Json; noMandate: Json };

const VAULT = "v0.probarion.testnet";
const APPROVER = "cfo.testnet";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const failure = (text: string) => ({
  Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: text } } } },
});
const panic = (code: string) => failure(`Smart contract panicked: PROBARION:${code}`);

function asCall(tree: Json, method: string, signer: string, receiver: string): Json {
  const t = clone(tree);
  t.transaction.signer_id = signer;
  t.transaction.receiver_id = receiver;
  t.transaction.actions = [
    { FunctionCall: { method_name: method, args: "e30=", gas: 150000000000000, deposit: "1" } },
  ];
  t.transaction_outcome.outcome.executor_id = signer;
  return t;
}
const asApprove = (tree: Json) => asCall(tree, "approve", APPROVER, VAULT);
const hashOf = (t: Json): string => t.transaction.hash;

function rpcReturning(result: unknown) {
  const calls: { method: string; params: unknown }[] = [];
  const rpc: RpcLike = {
    async call(method, params) {
      calls.push({ method, params });
      if (result instanceof Error) throw result;
      return result as never;
    },
  };
  return { rpc, calls };
}

async function confirm(
  tree: Json,
  method: string,
  over: { signer?: string; receiver?: string; hash?: string } = {},
): Promise<TxResult> {
  const { rpc } = rpcReturning(tree);
  return confirmTx(
    over.hash ?? hashOf(tree),
    over.signer ?? tree.transaction.signer_id,
    method,
    over.receiver ?? tree.transaction.receiver_id,
    rpc,
  );
}

describe("confirmTx on real receipt trees", () => {
  it("approve whose payout and callback both ran: ok", async () => {
    const t = asApprove(real.paid);
    expect(JSON.parse(Buffer.from(t.status.SuccessValue, "base64").toString())).toEqual({
      spend_id: 1,
      status: "paid",
    });
    expect(await confirm(t, "approve")).toEqual({
      status: "ok",
      txHash: hashOf(t),
      code: null,
      error: null,
    });
  });

  it("approve of an Intents payee, burned: ok", async () => {
    const t = asApprove(real.burned);
    expect(JSON.parse(Buffer.from(t.status.SuccessValue, "base64").toString()).status).toBe(
      "burned",
    );
    expect((await confirm(t, "approve")).status).toBe("ok");
  });

  it("asks the node for the final status of exactly this transaction", async () => {
    const t = asApprove(real.paid);
    const { rpc, calls } = rpcReturning(t);
    await confirmTx(hashOf(t), APPROVER, "approve", VAULT, rpc);
    expect(calls).toEqual([
      {
        method: "tx",
        params: { tx_hash: hashOf(t), sender_account_id: APPROVER, wait_until: "FINAL" },
      },
    ]);
  });

  it("the payout failed (ft_transfer panicked, on_transfer returned failed): failed, reservation released", async () => {
    const t = asApprove(real.paid);
    const [, transfer, , callback] = t.receipts_outcome;
    transfer.outcome.status = failure("The account probarion-payee.testnet is not registered");
    callback.outcome.status = { SuccessValue: b64({ spend_id: 1, status: "failed" }) };
    t.status = { SuccessValue: b64({ spend_id: 1, status: "failed" }) };
    expect(await confirm(t, "approve")).toEqual({
      status: "failed",
      txHash: hashOf(t),
      code: null,
      error: "payout failed, reservation released",
    });
  });

  it("the first receipt ran, the callback failed, the top level is a Failure: unknown (locked), with the code", async () => {
    const t = asApprove(real.paid);
    const [first, , , callback] = t.receipts_outcome;
    expect(first.outcome.status).toHaveProperty("SuccessReceiptId");
    callback.outcome.status = failure("Exceeded the prepaid gas.");
    t.status = failure("Exceeded the prepaid gas.");
    const r = await confirm(t, "approve");
    expect(r.status).toBe("unknown");
    expect(r.txHash).toBe(hashOf(t));
    expect(r.error).toMatch(/part of it may have happened/);
    expect(r.error).toContain("Exceeded the prepaid gas");
  });

  it("the callback hit LackBalanceForState: unknown, with the code and the plain-language text", async () => {
    const t = asApprove(real.paid);
    const [, , , callback] = t.receipts_outcome;
    const lack = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { LackBalanceForState: { account_id: VAULT, amount: "10000000000000000000000" } },
        },
      },
    };
    callback.outcome.status = lack;
    t.status = lack;
    const r = await confirm(t, "approve");
    expect(r).toMatchObject({ status: "unknown", code: "LackBalanceForState" });
    expect(r.error).toContain(OUT_OF_NEAR_DETAIL);
  });

  it("NotEnoughBalance maps to the gas text", async () => {
    const t = asApprove(real.paid);
    t.status = {
      Failure: {
        InvalidTxError: { NotEnoughBalance: { signer_id: VAULT, balance: "1", cost: "9" } },
      },
    };
    t.receipts_outcome[0].outcome.status = t.status;
    const r = await confirm(t, "approve");
    expect(r).toMatchObject({ status: "failed", code: "NotEnoughBalance" });
    expect(r.error).toContain(OUT_OF_GAS_NEAR_DETAIL);
  });

  it("the call itself failed (first receipt Failure, as in the real NoMandate smoke): failed, with the PROBARION code", async () => {
    const t = asApprove(real.noMandate);
    const swap = JSON.parse(
      JSON.stringify(t).replaceAll("PROBARION:NoMandate", "PROBARION:NotApprover"),
    );
    const r = await confirm(swap, "approve");
    expect(r).toMatchObject({ status: "failed", txHash: hashOf(swap), code: "NotApprover" });
    expect(r.error).toContain("PROBARION:NotApprover");
  });

  it("the real smoke transactions are agent spends, which this console never sends or reads", async () => {
    for (const t of [real.paid, real.burned, real.noMandate]) {
      const r = await confirm(clone(t), "spend");
      expect(r.status).toBe("unknown");
      expect(r.error).toMatch(/malformed/);
      // and asked as another call, the chain's record does not match
      const other = await confirm(clone(t), "withdraw");
      expect(other.error).toMatch(/does not end in a withdraw call/);
    }
  });

  it("a status that is not final yet: unknown", async () => {
    for (const status of ["Started", "NotStarted", { SuccessReceiptId: "abc" }]) {
      const t = asApprove(real.paid);
      t.status = status;
      const r = await confirm(t, "approve");
      expect(r.status, JSON.stringify(status)).toBe("unknown");
      expect(r.txHash).toBe(hashOf(t));
    }
  });
});

describe("confirmTx on the other methods' receipt trees (from the contracts' promise chains)", () => {
  const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
  const FACTORY = "vaults.probarion.testnet";
  const receipt = (id: string, executor: string, status: unknown, ids: string[] = []) => ({
    id,
    outcome: { logs: [], receipt_ids: ids, executor_id: executor, status },
  });
  function tx(
    method: string,
    signer: string,
    receiver: string,
    status: unknown,
    receipts: ReturnType<typeof receipt>[],
  ): Json {
    return {
      final_execution_status: "FINAL",
      status,
      transaction: {
        hash: HASH,
        signer_id: signer,
        receiver_id: receiver,
        actions: [{ FunctionCall: { method_name: method, args: "e30=", gas: 1, deposit: "1" } }],
      },
      transaction_outcome: receipt(HASH, signer, { SuccessReceiptId: receipts[0]?.id }, [
        receipts[0]?.id ?? "",
      ]),
      receipts_outcome: receipts,
    };
  }
  const OWNER = "owner.testnet";

  describe("create_vault: factory.create_vault -> account batch + on_vault_created", () => {
    const vault = "acme.vaults.probarion.testnet";
    it("created: ok", async () => {
      const t = tx("create_vault", OWNER, FACTORY, { SuccessValue: b64(vault) }, [
        receipt("r1", FACTORY, { SuccessReceiptId: "r3" }, ["r2", "r3"]),
        receipt("r2", vault, { SuccessValue: "" }),
        receipt("r3", FACTORY, { SuccessValue: b64(vault) }),
      ]);
      expect((await confirm(t, "create_vault")).status).toBe("ok");
    });

    it("name taken: the batch receipt failed, on_vault_created returned null, the deposit was refunded: failed, with that reason", async () => {
      const t = tx("create_vault", OWNER, FACTORY, { SuccessValue: b64(null) }, [
        receipt("r1", FACTORY, { SuccessReceiptId: "r3" }, ["r2", "r3"]),
        receipt("r2", vault, {
          Failure: {
            ActionError: { index: 0, kind: { AccountAlreadyExists: { account_id: vault } } },
          },
        }),
        receipt("r3", FACTORY, { SuccessValue: b64(null) }, ["r4"]),
        receipt("r4", OWNER, { SuccessValue: "" }),
      ]);
      expect(await confirm(t, "create_vault")).toEqual({
        status: "failed",
        txHash: HASH,
        code: null,
        error: "name taken or deposit too low, refunded",
      });
    });

    it("on_vault_created itself failed: unknown, locked (the account may exist and not be registered)", async () => {
      const t = tx("create_vault", OWNER, FACTORY, failure("Exceeded the prepaid gas."), [
        receipt("r1", FACTORY, { SuccessReceiptId: "r3" }, ["r2", "r3"]),
        receipt("r2", vault, { SuccessValue: "" }),
        receipt("r3", FACTORY, failure("Exceeded the prepaid gas.")),
      ]);
      expect((await confirm(t, "create_vault")).status).toBe("unknown");
    });

    it("an EMPTY return is not the same as null: unknown, not refused", async () => {
      const t = tx("create_vault", OWNER, FACTORY, { SuccessValue: "" }, [
        receipt("r1", FACTORY, { SuccessReceiptId: "r3" }, ["r2", "r3"]),
        receipt("r2", vault, { SuccessValue: "" }),
        receipt("r3", FACTORY, { SuccessValue: "" }),
      ]);
      const r = await confirm(t, "create_vault");
      expect(r.status).toBe("unknown");
      expect(r.error).toMatch(/empty/);
    });

    it("the deposit was too small: the factory refused before creating anything: failed, with the code", async () => {
      const t = tx("create_vault", OWNER, FACTORY, panic("InsufficientDeposit"), [
        receipt("r1", FACTORY, panic("InsufficientDeposit")),
      ]);
      expect(await confirm(t, "create_vault")).toMatchObject({
        status: "failed",
        code: "InsufficientDeposit",
      });
    });
  });

  describe("withdraw_intents: vault.withdraw_intents -> intents.ft_withdraw (a U128)", () => {
    const intents = "intents-stub.probarion.testnet";
    const chain = (value: unknown, topStatus: unknown = { SuccessValue: b64(value) }) =>
      tx("withdraw_intents", OWNER, VAULT, topStatus, [
        receipt("r1", VAULT, { SuccessReceiptId: "r2" }, ["r2"]),
        receipt(
          "r2",
          intents,
          typeof value === "string" ? { SuccessValue: b64(value) } : topStatus,
        ),
      ]);

    it("Intents paid out: ok", async () => {
      expect((await confirm(chain("5000000"), "withdraw_intents")).status).toBe("ok");
    });

    it('Intents returned "0" (the transfer failed and the balance was re-credited): failed, nothing withdrawn', async () => {
      const r = await confirm(chain("0"), "withdraw_intents");
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/nothing was withdrawn/);
    });

    it("ft_withdraw panicked after the vault call ran: unknown (Intents may have debited)", async () => {
      const t = chain(null, failure("intents: account is locked"));
      t.receipts_outcome[1].outcome.status = failure("intents: account is locked");
      expect((await confirm(t, "withdraw_intents")).status).toBe("unknown");
    });
  });

  describe("withdraw: vault.withdraw -> usdc.ft_transfer (returned, no callback)", () => {
    it("ok", async () => {
      const t = tx("withdraw", OWNER, VAULT, { SuccessValue: "" }, [
        receipt("r1", VAULT, { SuccessReceiptId: "r2" }, ["r2"]),
        receipt("r2", "usdc.probarion.testnet", { SuccessValue: "" }),
      ]);
      expect((await confirm(t, "withdraw")).status).toBe("ok");
    });

    it("the transfer failed (owner not registered on USDC): failed, nothing moved", async () => {
      const f = failure("The account owner.testnet is not registered");
      const t = tx("withdraw", OWNER, VAULT, f, [
        receipt("r1", VAULT, { SuccessReceiptId: "r2" }, ["r2"]),
        receipt("r2", "usdc.probarion.testnet", f),
      ]);
      const r = await confirm(t, "withdraw");
      expect(r.status).toBe("failed");
      expect(r.error).toContain("not registered");
    });
  });

  describe("key calls: the vault adds or deletes its own key in a detached receipt", () => {
    it.each(["add_agent", "set_ledger_key", "remove_agent"])(
      "%s with the key receipt applied: ok",
      async (m) => {
        const t = tx(m, OWNER, VAULT, { SuccessValue: "" }, [
          receipt("r1", VAULT, { SuccessValue: "" }, ["r2"]),
          receipt("r2", VAULT, { SuccessValue: "" }),
        ]);
        expect((await confirm(t, m)).status).toBe("ok");
      },
    );

    it.each(["add_agent", "set_ledger_key", "remove_agent"])(
      "%s with the key receipt failed under a top-level success: unknown",
      async (m) => {
        const t = tx(m, OWNER, VAULT, { SuccessValue: "" }, [
          receipt("r1", VAULT, { SuccessValue: "" }, ["r2"]),
          receipt("r2", VAULT, {
            Failure: {
              ActionError: {
                index: 0,
                kind: { AddKeyAlreadyExists: { account_id: VAULT, public_key: "ed25519:x" } },
              },
            },
          }),
        ]);
        const r = await confirm(t, m);
        expect(r.status).toBe("unknown");
        expect(r.error).toMatch(/a step it started failed/);
      },
    );
  });

  describe("create_mandate: mandate stored, payee registered on USDC by a detached receipt, excess refunded", () => {
    const usdc = "usdc.probarion.testnet";
    it("ok", async () => {
      const t = tx("create_mandate", OWNER, VAULT, { SuccessValue: b64(2) }, [
        receipt("r1", VAULT, { SuccessValue: b64(2) }, ["r2", "r3"]),
        receipt("r2", usdc, { SuccessValue: b64({ total: "1", available: "0" }) }),
        receipt("r3", OWNER, { SuccessValue: "" }),
      ]);
      expect((await confirm(t, "create_mandate")).status).toBe("ok");
    });

    it("the payee registration failed under a returned id: unknown", async () => {
      const t = tx("create_mandate", OWNER, VAULT, { SuccessValue: b64(2) }, [
        receipt("r1", VAULT, { SuccessValue: b64(2) }, ["r2"]),
        receipt(
          "r2",
          usdc,
          failure("The attached deposit is less than the minimum storage balance"),
        ),
      ]);
      expect((await confirm(t, "create_mandate")).status).toBe("unknown");
    });
  });

  describe("Transfer: a plain NEAR top-up to the vault (Send NEAR to this vault)", () => {
    const deposit = "500000000000000000000000";
    function transfer(status: unknown, receipts: ReturnType<typeof receipt>[], signer = OWNER) {
      const t = tx("freeze", signer, VAULT, status, receipts);
      t.transaction.actions = [{ Transfer: { deposit } }];
      return t;
    }

    it("delivered: ok, and the deposit is not asked about (a transfer has nothing to read back)", async () => {
      const t = transfer({ SuccessValue: "" }, [receipt("r1", VAULT, { SuccessValue: "" })]);
      expect(await confirm(t, "Transfer")).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });

    it("the receiver does not exist or cannot hold it: failed, with no callback to wait for", async () => {
      const refused = {
        Failure: {
          ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: VAULT } } },
        },
      };
      const t = transfer(refused, [receipt("r1", VAULT, refused)]);
      const r = await confirm(t, "Transfer");
      expect(r.status).toBe("failed");
      expect(r.error).toContain("AccountDoesNotExist");
    });

    it("a failed receipt under a delivered transfer (a refund that bounced) is unknown", async () => {
      const t = transfer({ SuccessValue: "" }, [
        receipt("r1", VAULT, { SuccessValue: "" }, ["r2"]),
        receipt("r2", OWNER, failure("refund failed")),
      ]);
      expect((await confirm(t, "Transfer")).status).toBe("unknown");
    });

    it("an approver's top-up is read the same way (any signer may send NEAR)", async () => {
      const t = transfer(
        { SuccessValue: "" },
        [receipt("r1", VAULT, { SuccessValue: "" })],
        APPROVER,
      );
      expect((await confirm(t, "Transfer")).status).toBe("ok");
    });

    it("the chain's record has to be a transfer: a contract call is not a top-up", async () => {
      const call = tx("freeze", OWNER, VAULT, { SuccessValue: "" }, [
        receipt("r1", VAULT, { SuccessValue: "" }),
      ]);
      const r = await confirm(call, "Transfer");
      expect(r.status).toBe("unknown");
      expect(r.error).toMatch(/does not end in a Transfer/);
    });

    it("and a transfer is not a freeze (or any other call)", async () => {
      const t = transfer({ SuccessValue: "" }, [receipt("r1", VAULT, { SuccessValue: "" })]);
      for (const method of ["freeze", "withdraw", "approve", "ft_transfer"]) {
        const r = await confirm(t, method);
        expect(r.status, method).toBe("unknown");
        expect(r.error, method).toMatch(new RegExp(`does not end in a ${method} call`));
      }
    });

    it("a transfer followed by a call is read as the call", async () => {
      const t = transfer({ SuccessValue: "" }, [receipt("r1", VAULT, { SuccessValue: "" })]);
      t.transaction.actions = [
        { Transfer: { deposit } },
        { FunctionCall: { method_name: "freeze", args: "e30=", gas: 1, deposit: "0" } },
      ];
      expect((await confirm(t, "freeze")).status).toBe("ok");
      expect((await confirm(t, "Transfer")).status).toBe("unknown");
    });

    it("a transfer to another account than the one prepared is unknown", async () => {
      const t = transfer({ SuccessValue: "" }, [receipt("r1", VAULT, { SuccessValue: "" })]);
      expect((await confirm(t, "Transfer", { receiver: "other.testnet" })).status).toBe("unknown");
    });
  });

  describe("calls with no promise", () => {
    it("freeze: ok", async () => {
      const t = tx("freeze", OWNER, VAULT, { SuccessValue: "" }, [
        receipt("r1", VAULT, { SuccessValue: "" }),
      ]);
      expect((await confirm(t, "freeze")).status).toBe("ok");
    });

    it("freeze by a stranger: failed with NotOwner", async () => {
      const t = tx("freeze", "stranger.testnet", VAULT, panic("NotOwner"), [
        receipt("r1", VAULT, panic("NotOwner")),
      ]);
      expect(await confirm(t, "freeze")).toMatchObject({ status: "failed", code: "NotOwner" });
    });

    it("unfreeze without the one yocto: failed with RequiresOneYocto", async () => {
      const t = tx("unfreeze", OWNER, VAULT, panic("RequiresOneYocto"), [
        receipt("r1", VAULT, panic("RequiresOneYocto")),
      ]);
      expect(await confirm(t, "unfreeze")).toMatchObject({
        status: "failed",
        code: "RequiresOneYocto",
      });
    });
  });
});

describe("the chain's record has to be the transaction that was prepared", () => {
  const t = () => asApprove(real.paid);

  it("another transaction's hash in the answer: unknown", async () => {
    const tree = t();
    const { rpc } = rpcReturning(tree);
    const other = hashOf(tree).replace(/^./, "8");
    const r = await confirmTx(other, APPROVER, "approve", VAULT, rpc);
    expect(r).toMatchObject({ status: "unknown", txHash: other });
    expect(r.error).toMatch(/different transaction/);
  });

  it("signed by someone else: unknown", async () => {
    const r = await confirm(t(), "approve", { signer: "stranger.testnet" });
    expect(r.status).toBe("unknown");
    expect(r.error).toMatch(/not signed by stranger\.testnet/);
  });

  it("sent to a different account than the one prepared: unknown", async () => {
    const r = await confirm(t(), "approve", { receiver: "other.testnet" });
    expect(r.status).toBe("unknown");
    expect(r.error).toMatch(/different account/);
  });

  it("a different last method: unknown (a wallet cannot pass off another call's success)", async () => {
    for (const method of ["withdraw", "freeze", "reject", "create_vault"]) {
      const r = await confirm(t(), method);
      expect(r.status, method).toBe("unknown");
      expect(r.error).toMatch(new RegExp(`does not end in a ${method} call`));
    }
  });

  it("a multi-action transaction is read by its LAST call", async () => {
    const tree = t();
    tree.transaction.actions = [
      { FunctionCall: { method_name: "storage_deposit", args: "e30=", gas: 1, deposit: "1" } },
      { FunctionCall: { method_name: "approve", args: "e30=", gas: 1, deposit: "1" } },
    ];
    expect((await confirm(tree, "approve")).status).toBe("ok");
    expect((await confirm(tree, "storage_deposit")).status).toBe("unknown");
  });

  it("no actions, a non-call last action, or a missing transaction: unknown", async () => {
    for (const mutate of [
      (x: Json) => {
        x.transaction.actions = [];
      },
      (x: Json) => {
        x.transaction.actions = [{ Transfer: { deposit: "1" } }];
      },
      (x: Json) => {
        x.transaction.actions = undefined;
      },
      (x: Json) => {
        x.transaction = undefined;
      },
    ]) {
      const tree = t();
      mutate(tree);
      expect(
        (await confirm(tree, "approve", { signer: APPROVER, receiver: VAULT, hash: hashOf(t()) }))
          .status,
      ).toBe("unknown");
    }
  });

  it("without a receiver to compare, the signer and the method are still checked", async () => {
    const tree = t();
    const { rpc } = rpcReturning(tree);
    expect((await confirmTx(hashOf(tree), APPROVER, "approve", undefined, rpc)).status).toBe("ok");
    expect((await confirmTx(hashOf(tree), APPROVER, "freeze", undefined, rpc)).status).toBe(
      "unknown",
    );
  });
});

describe("what cannot be established is unknown, never ok", () => {
  const tree = asApprove(real.paid);
  const hash = hashOf(tree);

  it("the node cannot be reached: unknown, with the hash", async () => {
    const { rpc } = rpcReturning(new Error("network error: timed out after 8000ms"));
    const r = await confirmTx(hash, APPROVER, "approve", VAULT, rpc);
    expect(r).toMatchObject({ status: "unknown", txHash: hash });
    expect(r.error).toMatch(/timed out/);
    expect(r.error).toMatch(/confirm on the explorer/);
  });

  it("the node says there is no such transaction: unknown", async () => {
    const { rpc } = rpcReturning(new Error("UNKNOWN_TRANSACTION"));
    expect((await confirmTx(hash, APPROVER, "approve", VAULT, rpc)).status).toBe("unknown");
  });

  it("an answer that is not a transaction: unknown", async () => {
    for (const junk of [
      null,
      undefined,
      "ok",
      5,
      [],
      {},
      { status: { SuccessValue: "" } },
      { transaction: {} },
    ]) {
      const { rpc } = rpcReturning(junk);
      const r = await confirmTx(hash, APPROVER, "approve", VAULT, rpc);
      expect(r.status, JSON.stringify(junk)).toBe("unknown");
    }
  });

  it("an error message is cut short", async () => {
    const { rpc } = rpcReturning(new Error("x".repeat(5000)));
    const r = await confirmTx(hash, APPROVER, "approve", VAULT, rpc);
    expect(r.error?.length).toBeLessThan(400);
  });

  it("malformed inputs never reach the network", async () => {
    const { rpc, calls } = rpcReturning(tree);
    const cases: [string, string, string, string | undefined][] = [
      ["not-a-hash", APPROVER, "approve", VAULT],
      [hash, "Not An Account", "approve", VAULT],
      [hash, APPROVER, "spend", VAULT],
      [hash, APPROVER, "constructor", VAULT],
      [hash, APPROVER, "approve", "Bad Receiver"],
    ];
    for (const [h, s, m, r] of cases) {
      const result = await confirmTx(h, s, m, r, rpc);
      expect(result.status, `${h} ${s} ${m} ${r}`).toBe("unknown");
    }
    expect(calls).toEqual([]);
  });

  it("a bad hash is not echoed back as a link", async () => {
    const { rpc } = rpcReturning(tree);
    expect(
      (await confirmTx("../../etc/passwd", APPROVER, "approve", VAULT, rpc)).txHash,
    ).toBeNull();
  });
});
