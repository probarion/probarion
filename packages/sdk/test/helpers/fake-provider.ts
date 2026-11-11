import { createHash } from "node:crypto";
import { baseEncode, encodeTransaction, type Provider, type SignedTransaction } from "near-api-js";

export interface FakeProviderOptions {
  /** The answer to `sendTransactionUntil`; throw to reject. `call` counts from 1. */
  send?: (signed: SignedTransaction, call: number) => unknown;
  /** The answer to `viewTransactionStatus`; throw to reject. */
  status?: (args: unknown) => unknown;
  /** Make `viewAccessKey` reject (nothing can be signed). */
  accessKeyFails?: unknown;
  /** Make `viewBlock` never answer. */
  blockHangs?: boolean;
}

/**
 * Just the provider methods the sender uses. No network. `viewAccessKey` hands out a higher nonce
 * on every call, so a re-signed transaction is told apart from a repeated one. `calls` names every
 * provider method called, in order, so a test can show that a step asked the node nothing.
 */
export function fakeProvider(options: FakeProviderOptions = {}) {
  const sent: { signed: SignedTransaction; waitUntil: unknown }[] = [];
  const statusCalls: unknown[] = [];
  const calls: string[] = [];
  let accessKeyCalls = 0;
  const provider = {
    viewAccessKey: async () => {
      calls.push("viewAccessKey");
      if (options.accessKeyFails !== undefined) throw options.accessKeyFails;
      accessKeyCalls += 1;
      return {
        nonce: BigInt(6 + accessKeyCalls),
        permission: "FullAccess",
        block_hash: baseEncode(new Uint8Array(32).fill(2)),
        block_height: 99,
      };
    },
    viewBlock: async () => {
      calls.push("viewBlock");
      if (options.blockHangs === true) return new Promise<never>(() => {});
      return { header: { hash: baseEncode(new Uint8Array(32).fill(3)), height: 100 } };
    },
    sendTransactionUntil: async (signed: SignedTransaction, waitUntil: unknown) => {
      calls.push("sendTransactionUntil");
      sent.push({ signed, waitUntil });
      if (options.send === undefined) return { status: { SuccessValue: "" } };
      return options.send(signed, sent.length);
    },
    viewTransactionStatus: async (args: unknown) => {
      calls.push("viewTransactionStatus");
      statusCalls.push(args);
      return options.status?.(args);
    },
  } as unknown as Provider;
  return { provider, sent, statusCalls, calls };
}

/** sha256 of the borsh-encoded transaction: the digest that is signed and, in base58, the tx hash. */
export function txDigest(signed: SignedTransaction): Buffer {
  return createHash("sha256").update(encodeTransaction(signed.transaction)).digest();
}

export function txHashOf(signed: SignedTransaction): string {
  return baseEncode(txDigest(signed));
}
