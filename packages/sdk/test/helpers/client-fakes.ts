import type { SpendRequest } from "@probarion/core";
import { RpcClient } from "../../src/rpc.js";
import type { FunctionCallTx, TxOutcome, TxSender } from "../../src/tx.js";

export type View = (contract: string, method: string, args: Record<string, unknown>) => unknown;

export interface ViewCall {
  contract: string;
  method: string;
  args: Record<string, unknown>;
}

/** An RpcClient whose every `call_function` query is answered by `view`; no network. */
export function viewRpc(view: View) {
  const calls: ViewCall[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
    const contract = String(body.params.account_id);
    const method = String(body.params.method_name);
    const args = JSON.parse(
      Buffer.from(String(body.params.args_base64), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    calls.push({ contract, method, args });
    const value = view(contract, method, args);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { result: [...Buffer.from(JSON.stringify(value))], logs: [] },
      }),
    );
  };
  return { rpc: new RpcClient({ urls: ["https://rpc.test"], fetch: fetchFn }), calls };
}

export const VAULT = "acme.vaults.probarion.testnet";
export const ROOT = "ab".repeat(32);
export const TGAS = 1_000_000_000_000n;

/**
 * A sender that answers every call with `outcome`. With `lookup`, it also has `lookup(txHash)`,
 * answered by that function (it may throw); `looked` records the hashes asked for.
 */
export function fakeSender(outcome: TxOutcome, lookup?: (txHash: string) => TxOutcome) {
  const sent: FunctionCallTx[] = [];
  const looked: string[] = [];
  const sender: TxSender = {
    accountId: VAULT,
    publicKey: "ed25519:Agent",
    functionCall: async (tx) => {
      sent.push(tx);
      return outcome;
    },
    ...(lookup === undefined
      ? {}
      : {
          lookup: async (txHash: string) => {
            looked.push(txHash);
            return lookup(txHash);
          },
        }),
  };
  return { sender, sent, looked };
}

export const okOutcome = (value: unknown): TxOutcome => ({
  txHash: "T",
  ok: true,
  value,
  code: null,
  failure: null,
  raw: null,
});

export const request: SpendRequest = {
  mandate_id: 1,
  amount: "25000000",
  invoice_hash: "ab".repeat(32),
  ref: "INV-1",
  decision_hash: "cd".repeat(32),
};
