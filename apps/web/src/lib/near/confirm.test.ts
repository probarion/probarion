import { OUT_OF_GAS_NEAR_DETAIL, OUT_OF_NEAR_DETAIL } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import trees from "../../../test/fixtures/testnet-spend-trees.json";
import {
  BASELINE_TOLERANCE_BLOCKS,
  confirmTx,
  currentFinalHeight,
  parseRequest,
  type RpcLike,
  sameJson,
} from "./confirm";
import type { ConfirmRequest, TxResult } from "./outcome";
import { sendNearTx } from "./transfer";
import {
  approveTx,
  createMandateTx,
  freezeTx,
  fundVaultUsdcTx,
  type MandateInputJson,
  type PreparedAction,
  type PreparedTx,
  rejectTx,
  toPrepared,
  unfreezeTx,
  withdrawTx,
} from "./tx";

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
const OWNER = "owner.testnet";
const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const BLOCK = "2ADxt1ZzSyXhWkXWdF9aGtsHSv8SqPVjvQyEmEXvwxp8";
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

/** How a faithful wallet's transaction looks in the node's JSON. */
function chainAction(a: PreparedAction): Json {
  return a.type === "Transfer"
    ? { Transfer: { deposit: a.deposit } }
    : {
        FunctionCall: {
          method_name: a.methodName,
          args: b64(a.args),
          gas: Number(a.gas),
          deposit: a.deposit,
        },
      };
}

/** What was shown, read back from a chain tree (so a tree of any shape can be confirmed as itself). */
function preparedFrom(tree: Json): PreparedTx {
  const actions = (tree.transaction.actions as Json[]).map((a): PreparedAction => {
    if (a.Transfer) return { type: "Transfer", deposit: String(a.Transfer.deposit) };
    const c = a.FunctionCall;
    return {
      type: "FunctionCall",
      methodName: c.method_name,
      args: JSON.parse(Buffer.from(c.args, "base64").toString("utf8")),
      deposit: String(c.deposit),
      gas: String(c.gas),
    };
  });
  return { receiverId: tree.transaction.receiver_id, actions };
}

interface RpcOptions {
  /** The block the transaction is in (default 100). `null`: the block cannot be read. */
  height?: number | null;
  /** The final height "now" (default 100). */
  finalHeight?: number | null;
  /** What the node says the block's own hash is, when it differs from the one asked for. */
  blockHash?: string;
}

function rpcFor(tree: unknown, o: RpcOptions = {}) {
  const calls: { method: string; params: Json }[] = [];
  const rpc: RpcLike = {
    async call(method, params) {
      const p = params as Json;
      calls.push({ method, params: p });
      if (method === "tx") {
        if (tree instanceof Error) throw tree;
        return tree as never;
      }
      if (method === "block") {
        if (p.finality === "final") {
          if (o.finalHeight === null) throw new Error("no final block");
          return { header: { height: o.finalHeight ?? 100, hash: BLOCK } } as never;
        }
        if (o.height === null) throw new Error("UNKNOWN_BLOCK");
        return { header: { height: o.height ?? 100, hash: o.blockHash ?? p.block_id } } as never;
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  return { rpc, calls };
}

interface Over extends RpcOptions {
  signer?: string;
  receiver?: string;
  hash?: string;
  /** The final height when the send began (default 100; `null`: it could not be read). */
  baseline?: number | null;
  /** Change what was shown. */
  shown?: (p: PreparedTx) => PreparedTx;
}

function requestFor(tree: Json, method: string, over: Over): ConfirmRequest {
  let shown = preparedFrom(tree);
  // asking about another last call means that call is what was shown last
  const last = shown.actions[shown.actions.length - 1];
  const label = last?.type === "Transfer" ? "Transfer" : last?.methodName;
  if (method !== label) {
    const swapped: PreparedAction =
      method === "Transfer"
        ? { type: "Transfer", deposit: "1" }
        : { type: "FunctionCall", methodName: method, args: {}, deposit: "0", gas: "1" };
    shown = { ...shown, actions: [...shown.actions.slice(0, -1), swapped] };
  }
  if (over.shown) shown = over.shown(shown);
  return {
    hash: over.hash ?? hashOf(tree),
    signerId: over.signer ?? tree.transaction.signer_id,
    tx: { ...shown, receiverId: over.receiver ?? shown.receiverId },
    baselineHeight: over.baseline === undefined ? 100 : over.baseline,
  };
}

async function confirm(tree: Json, method: string, over: Over = {}): Promise<TxResult> {
  return confirmTx(requestFor(tree, method, over), rpcFor(tree, over).rpc);
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

  it("asks the node for the final status of exactly this transaction, then for its block", async () => {
    const t = asApprove(real.paid);
    const { rpc, calls } = rpcFor(t);
    await confirmTx(requestFor(t, "approve", {}), rpc);
    expect(calls).toEqual([
      {
        method: "tx",
        params: { tx_hash: hashOf(t), sender_account_id: APPROVER, wait_until: "FINAL" },
      },
      { method: "block", params: { block_id: t.transaction_outcome.block_hash } },
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

  it("the first receipt ran, the callback failed, the top level is a Failure: unknown (locked)", async () => {
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
      expect(r.error).toMatch(/not one this console reads/);
      // and shown as another call, the chain's record does not match
      const other = await confirm(clone(t), "withdraw");
      expect(other.status).toBe("unknown");
      expect(other.error).toMatch(/calls spend, not withdraw/);
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
      transaction_outcome: {
        ...receipt(HASH, signer, { SuccessReceiptId: receipts[0]?.id }, [receipts[0]?.id ?? ""]),
        block_hash: BLOCK,
      },
      receipts_outcome: receipts,
    };
  }

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

  describe("set_ledger_key recovering a stuck ledger key (W-T10-R3)", () => {
    // contracts/vault/src/keys.rs (3dde545, 64ac3c0): DeleteKey(previous) and AddKey(new) are two
    // independent receipts. When the previous key was never added, only the DeleteKey fails.
    const OLD_LEDGER = "ed25519:old-ledger-key-never-added";
    const NEW_LEDGER = "ed25519:new-ledger-key";
    const deleteMissing = (publicKey: string, account = VAULT) => ({
      Failure: {
        ActionError: {
          index: 0,
          kind: { DeleteKeyDoesNotExist: { account_id: account, public_key: publicKey } },
        },
      },
    });
    const anchorKey = {
      nonce: 0,
      permission: {
        FunctionCall: {
          allowance: "250000000000000000000000",
          receiver_id: VAULT,
          method_names: ["anchor"],
        },
      },
    };

    function recovering(
      deleteStatus: unknown = deleteMissing(OLD_LEDGER),
      over: { method?: string; executor?: string; extra?: ReturnType<typeof receipt>[] } = {},
    ): Json {
      const method = over.method ?? "set_ledger_key";
      const t = tx(method, OWNER, VAULT, { SuccessValue: "" }, [
        receipt("r1", VAULT, { SuccessValue: "" }, ["r2", "r3"]),
        receipt("r2", over.executor ?? VAULT, deleteStatus),
        receipt("r3", VAULT, { SuccessValue: "" }),
        ...(over.extra ?? []),
      ]);
      t.transaction.actions[0].FunctionCall.args = b64({
        public_key: NEW_LEDGER,
        allowance: "250000000000000000000000",
      });
      return t;
    }

    interface Chain {
      /** get_config at the block the transaction is in; an Error makes the view fail. */
      before?: unknown;
      /** view_access_key of the new key now. */
      key?: unknown;
    }

    function chainRpc(t: Json, c: Chain = {}) {
      const calls: { method: string; params: Json }[] = [];
      const rpc: RpcLike = {
        async call(method, params) {
          const p = params as Json;
          calls.push({ method, params: p });
          if (method === "tx") return t as never;
          if (method === "block") {
            return { header: { height: 100, hash: p.block_id ?? BLOCK } } as never;
          }
          if (method === "query" && p.request_type === "call_function") {
            if (c.before instanceof Error) throw c.before;
            const config = c.before ?? { owner: OWNER, ledger_key: OLD_LEDGER };
            return { result: [...Buffer.from(JSON.stringify(config))], logs: [] } as never;
          }
          if (method === "query" && p.request_type === "view_access_key") {
            return (c.key ?? anchorKey) as never;
          }
          throw new Error(`unexpected rpc ${method}`);
        },
      };
      return { rpc, calls };
    }

    const run = (t: Json, c: Chain = {}, method = "set_ledger_key") =>
      confirmTx(requestFor(t, method, {}), chainRpc(t, c).rpc);

    it("the only failed receipt is the DeleteKey of the previous, never-added ledger key, and the new key landed: ok", async () => {
      const t = recovering();
      const { rpc, calls } = chainRpc(t);
      expect(await confirmTx(requestFor(t, "set_ledger_key", {}), rpc)).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
      // The previous key is read at the block the transaction is in; the new key, as it is now.
      expect(calls.filter((x) => x.method === "query").map((x) => x.params)).toEqual([
        {
          request_type: "call_function",
          block_id: BLOCK,
          account_id: VAULT,
          method_name: "get_config",
          args_base64: "e30=",
        },
        {
          request_type: "view_access_key",
          finality: "final",
          account_id: VAULT,
          public_key: NEW_LEDGER,
        },
      ]);
    });

    it.each([
      [
        "the failed DeleteKey is of a key that was not the ledger key",
        () => recovering(deleteMissing("ed25519:another-key")),
        {},
      ],
      [
        "the failed DeleteKey is of the new key itself",
        () => recovering(deleteMissing(NEW_LEDGER)),
        { before: { ledger_key: NEW_LEDGER } },
      ],
      [
        "the failed receipt ran on another account",
        () => recovering(deleteMissing(OLD_LEDGER), { executor: OWNER }),
        {},
      ],
      ["the error names another account", () => recovering(deleteMissing(OLD_LEDGER, OWNER)), {}],
      [
        "another action of the receipt failed",
        () =>
          recovering({
            Failure: {
              ActionError: {
                index: 1,
                kind: { DeleteKeyDoesNotExist: { account_id: VAULT, public_key: OLD_LEDGER } },
              },
            },
          }),
        {},
      ],
      [
        "the failure is not a DeleteKeyDoesNotExist",
        () =>
          recovering({
            Failure: {
              ActionError: {
                index: 0,
                kind: { LackBalanceForState: { account_id: VAULT, amount: "1" } },
              },
            },
          }),
        {},
      ],
      [
        "a second receipt failed too",
        () =>
          recovering(deleteMissing(OLD_LEDGER), {
            extra: [receipt("r4", VAULT, deleteMissing(OLD_LEDGER))],
          }),
        {},
      ],
      [
        "the vault's ledger key before the call cannot be read",
        () => recovering(),
        { before: new Error("UNKNOWN_BLOCK") },
      ],
      [
        "the new key is not on the vault",
        () => recovering(),
        { key: { error: `access key ${NEW_LEDGER} does not exist while viewing` } },
      ],
      [
        "the new key is not anchor-only",
        () => recovering(),
        {
          key: {
            nonce: 0,
            permission: { FunctionCall: { receiver_id: VAULT, method_names: ["anchor", "spend"] } },
          },
        },
      ],
      [
        "the new key is for another single method",
        () => recovering(),
        {
          key: {
            nonce: 0,
            permission: { FunctionCall: { receiver_id: VAULT, method_names: ["spend"] } },
          },
        },
      ],
      [
        "the new key is a full-access key",
        () => recovering(),
        { key: { nonce: 0, permission: "FullAccess" } },
      ],
      [
        "the new key is for another receiver",
        () => recovering(),
        {
          key: {
            nonce: 0,
            permission: { FunctionCall: { receiver_id: OWNER, method_names: ["anchor"] } },
          },
        },
      ],
    ] as const)("%s: unknown, never ok", async (_name, make, c) => {
      const r = await run(make(), c as Chain);
      expect(r.status).toBe("unknown");
      expect(r.error).toMatch(/a step it started failed/);
    });

    it("the same shape on another key call is not a ledger recovery", async () => {
      const t = recovering(deleteMissing(OLD_LEDGER), { method: "remove_agent" });
      const r = await run(t, {}, "remove_agent");
      expect(r.status).toBe("unknown");
    });
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

    it("delivered: ok", async () => {
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
      expect(r.error).toMatch(/is not a Transfer/);
    });

    it("and a transfer is not a freeze (or any other call)", async () => {
      const t = transfer({ SuccessValue: "" }, [receipt("r1", VAULT, { SuccessValue: "" })]);
      for (const method of ["freeze", "withdraw", "approve", "ft_transfer"]) {
        const r = await confirm(t, method);
        expect(r.status, method).toBe("unknown");
        expect(r.error, method).toMatch(/is not a contract call/);
      }
    });

    it("a transfer followed by a call is read as the call, and both actions must match", async () => {
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
    const other = hashOf(tree).replace(/^./, "8");
    const r = await confirm(tree, "approve", { hash: other });
    expect(r).toMatchObject({ status: "unknown", txHash: other });
    expect(r.error).toMatch(/different transaction/);
  });

  it("signed by someone else than the expected signer: unknown", async () => {
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
      expect(r.error).toMatch(new RegExp(`calls approve, not ${method}`));
    }
  });

  it("a multi-action transaction is checked action by action, in order", async () => {
    const tree = t();
    tree.transaction.actions = [
      { FunctionCall: { method_name: "storage_deposit", args: "e30=", gas: 1, deposit: "1" } },
      { FunctionCall: { method_name: "approve", args: "e30=", gas: 1, deposit: "1" } },
    ];
    expect((await confirm(tree, "approve")).status).toBe("ok");
    // shown in the other order: not the same transaction
    const r = await confirm(tree, "approve", {
      shown: (p) => ({ ...p, actions: [...p.actions].reverse() }),
    });
    expect(r.status).toBe("unknown");
  });

  it("no actions, a missing transaction or non-array actions: unknown", async () => {
    for (const mutate of [
      (x: Json) => {
        x.transaction.actions = [];
      },
      (x: Json) => {
        x.transaction.actions = undefined;
      },
      (x: Json) => {
        x.transaction = undefined;
      },
    ]) {
      const tree = t();
      const request = requestFor(tree, "approve", {});
      mutate(tree);
      const r = await confirmTx(request, rpcFor(tree).rpc);
      expect(r.status).toBe("unknown");
    }
  });
});

describe("W-T6-R2: the transaction that landed is the transaction that was shown", () => {
  const ATTACKER = "attacker.testnet";
  const USDC = "usdc.probarion.testnet";
  const HALF = "500000000000000000000000";
  const FIFTY = "50000000000000000000000000";

  /** A tree whose actions are exactly `actions` (as the node would report them), succeeding with `status`. */
  function treeWith(
    shown: PreparedTx,
    signer: string,
    actions: Json[],
    status: unknown = { SuccessValue: "" },
  ): Json {
    return {
      final_execution_status: "FINAL",
      status,
      transaction: {
        hash: HASH,
        signer_id: signer,
        receiver_id: shown.receiverId,
        actions,
      },
      transaction_outcome: {
        id: HASH,
        block_hash: BLOCK,
        outcome: {
          logs: [],
          receipt_ids: ["r1"],
          executor_id: signer,
          status: { SuccessReceiptId: "r1" },
        },
      },
      receipts_outcome: [
        { id: "r1", outcome: { logs: [], receipt_ids: [], executor_id: shown.receiverId, status } },
      ],
    };
  }

  async function landed(
    tx: Parameters<typeof toPrepared>[0],
    signer: string,
    tamper: (faithful: Json[], shown: PreparedTx) => Json[] = (a) => a,
    over: Over = {},
  ): Promise<TxResult> {
    const shown = toPrepared(tx);
    const tree = treeWith(shown, signer, tamper(shown.actions.map(chainAction), shown));
    const { rpc } = rpcFor(tree, over);
    return confirmTx(
      {
        hash: HASH,
        signerId: over.signer ?? signer,
        tx: shown,
        baselineHeight: over.baseline === undefined ? 100 : over.baseline,
      },
      rpc,
    );
  }

  const notOk = (r: TxResult) => {
    expect(r.status).not.toBe("ok");
    expect(["unknown", "failed"]).toContain(r.status);
  };

  describe("a faithful transaction is ok", () => {
    it.each([
      ["freeze", freezeTx(VAULT)],
      ["a USDC top-up (storage_deposit then ft_transfer)", fundVaultUsdcTx(USDC, VAULT, "25")],
      ["a NEAR top-up", sendNearTx(VAULT, HALF)],
    ])("%s", async (_name, tx) => {
      expect(await landed(tx, OWNER)).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });

    it("gas may differ: a wallet can adjust it", async () => {
      const r = await landed(freezeTx(VAULT), OWNER, (actions) =>
        actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, gas: 1 } })),
      );
      expect(r.status).toBe("ok");
    });

    it("the order of an object's keys in the arguments does not matter", async () => {
      const input: MandateInputJson = {
        payee: { type: "near", account_id: "bob.testnet" },
        purpose_hash: "a".repeat(64),
        max_per_payment: "1",
        max_total: "10",
        max_uses: 3,
        expires_at_ns: "1798675200000000000",
        approval_above: "5",
        agent_pk: "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M",
        label: "x",
      };
      const tx = createMandateTx(VAULT, input);
      const shown = toPrepared(tx);
      const reordered = shown.actions.map((a) => {
        if (a.type !== "FunctionCall") return chainAction(a);
        const inner = (a.args as { input: Record<string, unknown> }).input;
        const flipped = Object.fromEntries(Object.entries(inner).reverse());
        return chainAction({ ...a, args: { input: flipped } });
      });
      const tree = treeWith(shown, OWNER, reordered, { SuccessValue: b64(1) });
      const r = await confirmTx(
        { hash: HASH, signerId: OWNER, tx: shown, baselineHeight: 100 },
        rpcFor(tree).rpc,
      );
      expect(r.status).toBe("ok");
    });

    it("a deposit the node writes as a safe integer equals the shown decimal string", async () => {
      const r = await landed(approveTx(VAULT, 7), OWNER, (actions) =>
        actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, deposit: 1 } })),
      );
      // (this tree's top-level status is not an approve result, so it is not "ok", but the
      // actions themselves matched: the reader, not the match, is what stops it)
      expect(r.error ?? "").not.toMatch(/differs from the one shown/);
    });
  });

  describe("a prepended, appended or swapped action is never ok", () => {
    const attacker = (amount: string): Json => ({
      FunctionCall: {
        method_name: "ft_transfer",
        args: b64({ receiver_id: ATTACKER, amount, memo: null }),
        gas: 30000000000000,
        deposit: "1",
      },
    });

    it("fundVaultUsdcTx lands as [ft_transfer(attacker, 10000 USDC), storage_deposit, ft_transfer(vault, 25)]", async () => {
      const r = await landed(fundVaultUsdcTx(USDC, VAULT, "25"), OWNER, (a) => [
        attacker("10000000000"),
        ...a,
      ]);
      notOk(r);
      expect(r.error).toMatch(/has 3 actions, not the 2 that were shown/);
    });

    it("lands as [ft_transfer(attacker, 10000 USDC), ft_transfer(vault, 25)]: same count, first action replaced", async () => {
      const r = await landed(fundVaultUsdcTx(USDC, VAULT, "25"), OWNER, (a) => [
        attacker("10000000000"),
        a[1] as Json,
      ]);
      notOk(r);
      expect(r.error).toMatch(/action 1 calls ft_transfer, not storage_deposit/);
    });

    it("an action appended after the last one", async () => {
      const r = await landed(freezeTx(VAULT), OWNER, (a) => [...a, attacker("1")]);
      notOk(r);
      expect(r.error).toMatch(/has 2 actions, not the 1/);
    });

    it("the same method on the same contract, but the money goes to the attacker", async () => {
      const r = await landed(fundVaultUsdcTx(USDC, VAULT, "25"), OWNER, (a) => [
        a[0] as Json,
        attacker("25"),
      ]);
      notOk(r);
      expect(r.error).toMatch(/action 2 \(ft_transfer\) has different arguments/);
    });

    it("an action of a kind this console never sends (AddKey, DeleteAccount, Stake, DeployContract, CreateAccount)", async () => {
      for (const extra of [
        { AddKey: { public_key: "ed25519:x", access_key: { nonce: 0, permission: "FullAccess" } } },
        { DeleteAccount: { beneficiary_id: ATTACKER } },
        { Stake: { stake: "1", public_key: "ed25519:x" } },
        { DeployContract: { code: "AGFzbQ==" } },
        { CreateAccount: {} },
        null,
        "FunctionCall",
      ]) {
        const alone = await landed(freezeTx(VAULT), OWNER, () => [extra as Json]);
        notOk(alone);
        const after = await landed(freezeTx(VAULT), OWNER, (a) => [...a, extra as Json]);
        notOk(after);
      }
    });
  });

  describe("different arguments are never ok", () => {
    it("approve {spend_id: 7} lands as {spend_id: 8}", async () => {
      const shown = toPrepared(approveTx(VAULT, 7));
      const tree = asApprove(real.paid);
      tree.transaction.actions = shown.actions.map((a) =>
        a.type === "FunctionCall" ? chainAction({ ...a, args: { spend_id: 8 } }) : chainAction(a),
      );
      tree.transaction.receiver_id = shown.receiverId;
      const r = await confirmTx(
        { hash: hashOf(tree), signerId: APPROVER, tx: shown, baselineHeight: 100 },
        rpcFor(tree).rpc,
      );
      notOk(r);
      expect(r.error).toMatch(/action 1 \(approve\) has different arguments/);
    });

    it("the same transaction with spend_id 7 is ok (the control)", async () => {
      const shown = toPrepared(approveTx(VAULT, 7));
      const tree = asApprove(real.paid);
      tree.transaction.actions = shown.actions.map(chainAction);
      tree.transaction.receiver_id = shown.receiverId;
      const r = await confirmTx(
        { hash: hashOf(tree), signerId: APPROVER, tx: shown, baselineHeight: 100 },
        rpcFor(tree).rpc,
      );
      expect(r.status).toBe("ok");
    });

    it.each([
      ["a nested field changed", { input: { max_total: "999" } }],
      ["a key added", { extra: true }],
      ["a key removed", {}],
      ["a number where a string was shown", { spend_id: "7" }],
      ["a string where a number was shown", { spend_id: 7.5 }],
      ["null", null],
      ["an array", [7]],
    ])("%s", async (_name, args) => {
      const r = await landed(approveTx(VAULT, 7), OWNER, (actions) =>
        actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, args: b64(args) } })),
      );
      notOk(r);
      expect(r.error).toMatch(/different arguments/);
    });

    it("arguments that are not base64 JSON at all", async () => {
      for (const args of [
        "",
        "!!!",
        Buffer.from("not json").toString("base64"),
        5,
        null,
        undefined,
      ]) {
        const r = await landed(approveTx(VAULT, 7), OWNER, (actions) =>
          actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, args } })),
        );
        notOk(r);
      }
    });

    describe("empty arguments on the chain count as {} when {} was shown (some wallets encode it so)", () => {
      const emptyBytes = (actions: Json[]) =>
        actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, args: "" } }));

      it.each([
        ["freeze", freezeTx(VAULT)],
        ["unfreeze", unfreezeTx(VAULT)],
      ])("%s with empty argument bytes is ok", async (_name, tx) => {
        expect(toPrepared(tx).actions[0]).toMatchObject({ args: {} });
        expect(await landed(tx, OWNER, emptyBytes)).toEqual({
          status: "ok",
          txHash: HASH,
          code: null,
          error: null,
        });
      });

      it("{} spelled out is still ok (both encodings are accepted)", async () => {
        expect((await landed(freezeTx(VAULT), OWNER)).status).toBe("ok");
      });

      it("but arguments that were shown as something else are not satisfied by empty bytes", async () => {
        for (const tx of [approveTx(VAULT, 7), rejectTx(VAULT, 7), withdrawTx(VAULT, HALF)]) {
          const r = await landed(tx, OWNER, emptyBytes);
          notOk(r);
          expect(r.error).toMatch(/different arguments/);
        }
      });

      it("only truly empty bytes count: blanks, null, [] or 0 do not", async () => {
        for (const args of [" ", "bnVsbA==", "W10=", "MA=="]) {
          const r = await landed(freezeTx(VAULT), OWNER, (actions) =>
            actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, args } })),
          );
          notOk(r);
        }
      });

      it("empty bytes do not excuse any other mismatch on the same action", async () => {
        const r = await landed(freezeTx(VAULT), OWNER, (actions) =>
          actions.map((a) => ({
            FunctionCall: { ...a.FunctionCall, args: "", deposit: "1" },
          })),
        );
        notOk(r);
        expect(r.error).toMatch(/deposit/);
      });
    });

    it("a changed nested mandate field in create_mandate", async () => {
      const input: MandateInputJson = {
        payee: { type: "near", account_id: "bob.testnet" },
        purpose_hash: "a".repeat(64),
        max_per_payment: "1",
        max_total: "10",
        max_uses: 3,
        expires_at_ns: "1798675200000000000",
        approval_above: "5",
        agent_pk: "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M",
        label: "x",
      };
      const shown = toPrepared(createMandateTx(VAULT, input));
      const forged = shown.actions.map((a) =>
        a.type === "FunctionCall"
          ? chainAction({
              ...a,
              args: { input: { ...input, payee: { type: "near", account_id: ATTACKER } } },
            })
          : chainAction(a),
      );
      const tree = treeWith(shown, OWNER, forged, { SuccessValue: b64(1) });
      const r = await confirmTx(
        { hash: HASH, signerId: OWNER, tx: shown, baselineHeight: 100 },
        rpcFor(tree).rpc,
      );
      notOk(r);
      expect(r.error).toMatch(/different arguments/);
    });
  });

  describe("an inflated deposit is never ok", () => {
    it("a 0.5 NEAR top-up that landed as 50 NEAR", async () => {
      const r = await landed(sendNearTx(VAULT, HALF), OWNER, () => [
        { Transfer: { deposit: FIFTY } },
      ]);
      notOk(r);
      expect(r.error).toMatch(/moves a different amount of NEAR/);
    });

    it("a smaller transfer is not ok either", async () => {
      const r = await landed(sendNearTx(VAULT, HALF), OWNER, () => [
        { Transfer: { deposit: "1" } },
      ]);
      notOk(r);
    });

    it("a call that attached more than was shown", async () => {
      for (const deposit of ["2", "1000000000000000000000000"]) {
        const r = await landed(approveTx(VAULT, 7), OWNER, (actions) =>
          actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, deposit } })),
        );
        notOk(r);
        expect(r.error).toMatch(/attaches a different deposit/);
      }
    });

    it("a freeze (no deposit) that landed with one", async () => {
      const r = await landed(freezeTx(VAULT), OWNER, (actions) =>
        actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, deposit: "1" } })),
      );
      notOk(r);
    });

    it("a deposit that is not a number", async () => {
      for (const deposit of ["1.0", "1e0", "", "-1", null, undefined, {}, 1.5, "0x1"]) {
        const r = await landed(approveTx(VAULT, 7), OWNER, (actions) =>
          actions.map((a) => ({ FunctionCall: { ...a.FunctionCall, deposit } })),
        );
        notOk(r);
      }
    });
  });

  describe("an old transaction is never ok (replay)", () => {
    const tx = freezeTx(VAULT);

    const NOT_THIS_ONE =
      /could not confirm this is the transaction you just approved; check the explorer/;

    it("the tolerance is 30 blocks (about half a minute)", () => {
      expect(BASELINE_TOLERANCE_BLOCKS).toBe(30);
    });

    it("a block far older than the send began: unknown, even though everything else matches", async () => {
      const r = await landed(tx, OWNER, (a) => a, { height: 100, baseline: 1000 });
      expect(r.status).toBe("unknown");
      expect(r.txHash).toBe(HASH);
      expect(r.error).toMatch(NOT_THIS_ONE);
    });

    it("last week's freeze (far older) is unknown", async () => {
      expect(
        (await landed(tx, OWNER, (a) => a, { height: 1000, baseline: 2_000_000 })).status,
      ).toBe("unknown");
    });

    it("the same block, or a newer one, is ok", async () => {
      expect((await landed(tx, OWNER, (a) => a, { height: 100, baseline: 100 })).status).toBe("ok");
      expect((await landed(tx, OWNER, (a) => a, { height: 101, baseline: 100 })).status).toBe("ok");
    });

    describe("the baseline is read while the wallet is already being asked, so a little earlier is fine", () => {
      const BASE = 1000;

      it("inside the tolerance (one block, half the tolerance, exactly 30 earlier) is ok", async () => {
        for (const behind of [1, 15, BASELINE_TOLERANCE_BLOCKS]) {
          const r = await landed(tx, OWNER, (a) => a, { height: BASE - behind, baseline: BASE });
          expect(r.status, `${behind} blocks behind`).toBe("ok");
        }
      });

      it("one block beyond the tolerance (31 earlier) is unknown, with the explorer wording", async () => {
        const r = await landed(tx, OWNER, (a) => a, {
          height: BASE - BASELINE_TOLERANCE_BLOCKS - 1,
          baseline: BASE,
        });
        expect(r.status).toBe("unknown");
        expect(r.txHash).toBe(HASH);
        expect(r.error).toMatch(NOT_THIS_ONE);
      });

      it("a replay older than 30 blocks is still refused, whatever else matches", async () => {
        for (const behind of [31, 60, 500, 100_000]) {
          const r = await landed(tx, OWNER, (a) => a, { height: BASE - behind, baseline: BASE });
          expect(r.status, `${behind} blocks behind`).toBe("unknown");
        }
      });

      it("a baseline near the start of the chain (less than 30) accepts any block", async () => {
        const r = await landed(tx, OWNER, (a) => a, { height: 1, baseline: 5 });
        expect(r.status).toBe("ok");
      });

      it("the tolerance only loosens the height; a different action still never matches", async () => {
        const r = await landed(
          approveTx(VAULT, 7),
          OWNER,
          (actions) =>
            actions.map((a) => ({
              FunctionCall: { ...a.FunctionCall, args: b64({ spend_id: 8 }) },
            })),
          { height: BASE - 10, baseline: BASE },
        );
        notOk(r);
      });

      it("the signer still has to match inside the tolerance", async () => {
        const r = await landed(tx, OWNER, (a) => a, {
          height: BASE - 10,
          baseline: BASE,
          signer: "someone-else.near",
        });
        notOk(r);
      });

      it("a failure inside the tolerance is judged like any other failure, not as ok", async () => {
        const shown = toPrepared(tx);
        const tree = treeWith(shown, OWNER, shown.actions.map(chainAction), panic("NotOwner"));
        const r = await confirmTx(
          { hash: HASH, signerId: OWNER, tx: shown, baselineHeight: BASE },
          rpcFor(tree, { height: BASE - 10 }).rpc,
        );
        expect(r.status).not.toBe("ok");
      });
    });

    it("an old failure is not reported as a fresh failure either", async () => {
      const shown = toPrepared(tx);
      const tree = treeWith(shown, OWNER, shown.actions.map(chainAction), panic("NotOwner"));
      const r = await confirmTx(
        { hash: HASH, signerId: OWNER, tx: shown, baselineHeight: 500 },
        rpcFor(tree, { height: 10 }).rpc,
      );
      expect(r.status).toBe("unknown");
    });

    it("the height when the send began could not be read: never ok", async () => {
      const r = await landed(tx, OWNER, (a) => a, { baseline: null });
      expect(r.status).toBe("unknown");
      expect(r.error).toMatch(/height when the send began could not be read/);
    });

    it("the block the transaction is in cannot be established: never ok", async () => {
      const unreadable = await landed(tx, OWNER, (a) => a, { height: null });
      expect(unreadable.status).toBe("unknown");
      expect(unreadable.error).toMatch(/block this transaction is in could not be read/);
      const wrongBlock = await landed(tx, OWNER, (a) => a, { blockHash: "someOtherBlock" });
      expect(wrongBlock.status).toBe("unknown");
    });

    it("a transaction with no block hash is never ok", async () => {
      const shown = toPrepared(tx);
      const tree = treeWith(shown, OWNER, shown.actions.map(chainAction));
      for (const hash of [undefined, "", 5, null]) {
        tree.transaction_outcome.block_hash = hash;
        const r = await confirmTx(
          { hash: HASH, signerId: OWNER, tx: shown, baselineHeight: 100 },
          rpcFor(tree).rpc,
        );
        expect(r.status).toBe("unknown");
      }
    });

    it("a block height that is not a height is never ok", async () => {
      const shown = toPrepared(tx);
      const tree = treeWith(shown, OWNER, shown.actions.map(chainAction));
      for (const height of [0, -5, 1.5, "100", Number.NaN, undefined, 2 ** 60]) {
        const rpc: RpcLike = {
          async call(method) {
            if (method === "tx") return tree as never;
            return { header: { height, hash: BLOCK } } as never;
          },
        };
        const r = await confirmTx(
          { hash: HASH, signerId: OWNER, tx: shown, baselineHeight: 100 },
          rpc,
        );
        expect(r.status, String(height)).toBe("unknown");
      }
    });
  });

  describe("the signer is the expected one, not the one the wallet names", () => {
    it("a transaction signed by another account than expected: unknown", async () => {
      const r = await landed(freezeTx(VAULT), "stranger.testnet", (a) => a, { signer: OWNER });
      expect(r.status).toBe("unknown");
      expect(r.error).toMatch(/not signed by owner\.testnet/);
    });

    it("the node is asked about the expected signer's transaction", async () => {
      const shown = toPrepared(freezeTx(VAULT));
      const tree = treeWith(shown, OWNER, shown.actions.map(chainAction));
      const { rpc, calls } = rpcFor(tree);
      await confirmTx({ hash: HASH, signerId: OWNER, tx: shown, baselineHeight: 100 }, rpc);
      expect(calls[0]?.params.sender_account_id).toBe(OWNER);
    });
  });
});

describe("confirmTx refuses a malformed request without asking the network", () => {
  const good = (): ConfirmRequest => ({
    hash: HASH,
    signerId: OWNER,
    tx: toPrepared(freezeTx(VAULT)),
    baselineHeight: 100,
  });
  const withTx = (edit: (tx: Json) => void): Json => {
    const r = clone(good()) as Json;
    edit(r.tx);
    return r;
  };

  it("a good request parses back as itself", () => {
    expect(parseRequest(good())).toEqual(good());
    expect(parseRequest({ ...good(), baselineHeight: null })).toMatchObject({
      baselineHeight: null,
    });
  });

  it.each([
    ["not an object", null],
    ["an array", []],
    ["a string", "x"],
    ["a bad hash", { ...good(), hash: "not-a-hash" }],
    ["a hash with a path in it", { ...good(), hash: "../../etc/passwd" }],
    ["no hash", { ...good(), hash: undefined }],
    ["a bad signer", { ...good(), signerId: "Not An Account" }],
    ["no signer", { ...good(), signerId: undefined }],
    ["a bad receiver", withTx((tx) => (tx.receiverId = "Bad Receiver"))],
    ["no tx", { ...good(), tx: undefined }],
    ["no actions", withTx((tx) => (tx.actions = []))],
    ["actions not an array", withTx((tx) => (tx.actions = {}))],
    [
      "too many actions",
      withTx((tx) => (tx.actions = Array.from({ length: 17 }, () => tx.actions?.[0] ?? {}))),
    ],
    ["an unknown action type", withTx((tx) => (tx.actions[0].type = "DeleteAccount"))],
    ["an action that is not an object", withTx((tx) => (tx.actions = ["freeze"]))],
    ["no deposit", withTx((tx) => (tx.actions[0].deposit = undefined))],
    ["a deposit that is not digits", withTx((tx) => (tx.actions[0].deposit = "1.5"))],
    ["a deposit above U128", withTx((tx) => (tx.actions[0].deposit = (2n ** 128n).toString()))],
    ["a numeric deposit", withTx((tx) => (tx.actions[0].deposit = 1))],
    ["no gas", withTx((tx) => (tx.actions[0].gas = undefined))],
    ["a bad method name", withTx((tx) => (tx.actions[0].methodName = "free ze"))],
    ["an empty method name", withTx((tx) => (tx.actions[0].methodName = ""))],
    ["a long method name", withTx((tx) => (tx.actions[0].methodName = "a".repeat(129)))],
    ["args that are not an object", withTx((tx) => (tx.actions[0].args = []))],
    ["args that are too big", withTx((tx) => (tx.actions[0].args = { x: "y".repeat(17_000) }))],
    [
      "a last call this console does not read",
      withTx((tx) => (tx.actions[0].methodName = "spend")),
    ],
    ["no starting height", { ...good(), baselineHeight: undefined }],
    ["a starting height of 0", { ...good(), baselineHeight: 0 }],
    ["a negative starting height", { ...good(), baselineHeight: -1 }],
    ["a fractional starting height", { ...good(), baselineHeight: 1.5 }],
    ["a starting height as text", { ...good(), baselineHeight: "100" }],
    ["a starting height of NaN", { ...good(), baselineHeight: Number.NaN }],
  ])("%s", async (_name, request) => {
    expect(typeof parseRequest(request)).toBe("string");
    const { rpc, calls } = rpcFor(new Error("must not be asked"));
    const r = await confirmTx(request, rpc);
    expect(r.status).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("says what is wrong with the actions and with the starting height", () => {
    expect(parseRequest(withTx((tx) => (tx.actions = [])))).toBe(
      "The transaction has no actions, or too many",
    );
    expect(
      parseRequest(
        withTx((tx) => (tx.actions = Array.from({ length: 17 }, () => tx.actions?.[0] ?? {}))),
      ),
    ).toBe("The transaction has no actions, or too many");
    expect(parseRequest({ ...good(), baselineHeight: undefined })).toBe(
      "The starting block height is missing",
    );
    expect(parseRequest({ ...good(), baselineHeight: -1 })).toBe(
      "The starting block height is not a block height",
    );
  });

  it("checks the method name of EVERY action, not only the last", () => {
    const two = (first: string): Json => {
      const r = clone({
        hash: HASH,
        signerId: OWNER,
        tx: toPrepared(fundVaultUsdcTx("usdc.near", VAULT, "25")),
        baselineHeight: 100,
      }) as Json;
      r.tx.actions[0].methodName = first;
      return r;
    };
    expect(typeof parseRequest(two("storage_deposit"))).toBe("object");
    for (const bad of ["a b", "", "a".repeat(129), "a.b", "a-b", "a;b", "é", "a\nb"]) {
      expect(parseRequest(two(bad)), JSON.stringify(bad)).toBe("An action was malformed");
    }
  });

  it("echoes only a real hash back", async () => {
    const { rpc } = rpcFor(new Error("x"));
    expect((await confirmTx({ ...good(), signerId: "BAD" }, rpc)).txHash).toBe(HASH);
    expect(
      (await confirmTx({ ...good(), hash: "<script>", signerId: "BAD" }, rpc)).txHash,
    ).toBeNull();
    expect((await confirmTx(null, rpc)).txHash).toBeNull();
  });

  it("a request is read from its fields, not from anything else it carries", () => {
    const r = parseRequest({
      ...good(),
      extra: "x",
      tx: { ...good().tx, more: 1 },
    }) as ConfirmRequest;
    expect(r).toEqual(good());
  });
});

describe("what cannot be established is unknown, never ok", () => {
  const tree = asApprove(real.paid);
  const request = requestFor(tree, "approve", {});

  it("the node cannot be reached: unknown, with the hash", async () => {
    const r = await confirmTx(
      request,
      rpcFor(new Error("network error: timed out after 8000ms")).rpc,
    );
    expect(r).toMatchObject({ status: "unknown", txHash: hashOf(tree) });
    expect(r.error).toMatch(/timed out/);
    expect(r.error).toMatch(/confirm on the explorer/);
  });

  it("the node says there is no such transaction: unknown", async () => {
    const r = await confirmTx(request, rpcFor(new Error("UNKNOWN_TRANSACTION")).rpc);
    expect(r.status).toBe("unknown");
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
      const r = await confirmTx(request, rpcFor(junk).rpc);
      expect(r.status, JSON.stringify(junk)).toBe("unknown");
    }
  });

  it("an error message is cut short", async () => {
    const r = await confirmTx(request, rpcFor(new Error("x".repeat(5000))).rpc);
    expect(r.error?.length).toBeLessThan(400);
  });
});

describe("sameJson", () => {
  it("is equal for the same value whatever the order of keys", () => {
    expect(
      sameJson({ a: 1, b: { c: [1, 2, { d: null }] } }, { b: { c: [1, 2, { d: null }] }, a: 1 }),
    ).toBe(true);
    expect(sameJson([], [])).toBe(true);
    expect(sameJson({}, {})).toBe(true);
    expect(sameJson("a", "a")).toBe(true);
    expect(sameJson(null, null)).toBe(true);
  });

  it("is not equal for anything that differs, including its type", () => {
    for (const [a, b] of [
      [{ a: 1 }, { a: 2 }],
      [{ a: 1 }, { a: "1" }],
      [{ a: 1 }, { a: 1, b: 2 }],
      [{ a: 1, b: 2 }, { a: 1 }],
      [{ a: 1 }, { b: 1 }],
      [
        [1, 2],
        [2, 1],
      ],
      [[1], [1, 2]],
      [{}, []],
      [[], {}],
      [null, {}],
      [{}, null],
      [0, "0"],
      [undefined, null],
      [{ a: undefined }, {}],
      [{ a: [] }, { a: {} }],
    ] as [unknown, unknown][]) {
      expect(sameJson(a, b), JSON.stringify([a, b])).toBe(false);
    }
  });

  it("gives up (not equal) on absurd nesting instead of recursing without bound", () => {
    let a: unknown = 1;
    let b: unknown = 1;
    for (let i = 0; i < 50; i++) {
      a = [a];
      b = [b];
    }
    expect(sameJson(a, b)).toBe(false);
  });

  it("treats a key called __proto__ as a key", () => {
    const a = JSON.parse('{"__proto__": {"x": 1}}');
    const b = JSON.parse('{"__proto__": {"x": 2}}');
    expect(sameJson(a, b)).toBe(false);
    expect(sameJson(a, JSON.parse('{"__proto__": {"x": 1}}'))).toBe(true);
  });
});

describe("currentFinalHeight", () => {
  const rpc = (answer: unknown): RpcLike => ({
    async call() {
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
  });

  it("reads the final block's height", async () => {
    expect(await currentFinalHeight(rpc({ header: { height: 123 } }))).toBe(123);
  });

  it("is null when the network cannot say", async () => {
    for (const bad of [
      new Error("down"),
      null,
      {},
      { header: null },
      { header: {} },
      { header: { height: 0 } },
      { header: { height: -1 } },
      { header: { height: 1.5 } },
      { header: { height: "5" } },
    ]) {
      expect(await currentFinalHeight(rpc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("asks for the final block", async () => {
    const asked: unknown[] = [];
    await currentFinalHeight({
      async call(method, params) {
        asked.push([method, params]);
        return { header: { height: 1 } } as never;
      },
    });
    expect(asked).toEqual([["block", { finality: "final" }]]);
  });
});
