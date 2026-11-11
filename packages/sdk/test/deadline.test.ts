// The options that let a caller pass "the time I have left" to the SDK (plan 04 Task 17, ruling W-T17-R2): an overall
// `remainingMs` on the RPC client and on the NEAR AI proposer, a `sendTimeoutMs` that may be a function on the transaction
// sender, and a `knownModel` that skips the catalog and the probe. Every default is unchanged for other callers.
// No call starts with less than MIN_CALL_MS left: the tests of that floor answer `remainingMs` (and a `sendTimeoutMs`
// function) with fixed values, so they never race the clock.
import { createServer, type Server } from "node:http";
import { generateKeyPair, sha256Hex, utf8 } from "@probarion/core";
import { InvalidNonceError, UnknownTransactionError } from "near-api-js/rpc-errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_CALL_MS } from "../src/deadline.js";
import {
  ConfigError,
  NearAiError,
  ProbarionError,
  RpcError,
  TxOutcomeUnknownError,
  TxRejectedError,
} from "../src/errors.js";
import { NearAiProposer } from "../src/nearai.js";
import { RpcClient } from "../src/rpc.js";
import {
  createFakeNearAi,
  FAKE_NEARAI_BASE_URL,
  FAKE_PRIVATE_MODEL,
} from "../src/testing/index.js";
import { type FunctionCallTx, NearApiJsSender } from "../src/tx.js";
import { type FakeProviderOptions, fakeProvider, txHashOf } from "./helpers/fake-provider.js";

const API_KEY = ["sk", "live", "0123456789abcdefghijkl"].join("-");
const VAULT = "acme.vaults.probarion.testnet";
const key = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
const spendTx: FunctionCallTx = {
  receiverId: VAULT,
  methodName: "spend",
  args: { request: { mandate_id: 1 } },
  gas: 200_000_000_000_000n,
  deposit: 0n,
};
const proposalJson = JSON.stringify({
  action: "pay",
  mandate_id: 1,
  amount: "25000000",
  payee_hint: null,
  reasoning: "ok",
  confidence: 0.9,
});

/** Time left values below the floor: each one makes no request at all. */
const TOO_LITTLE = [1, 49, Number.NaN];

/** A fetch that never answers and rejects when its signal aborts, with the number of requests it was given. */
function stalling() {
  const seen = { sent: 0 };
  const fetch = ((_input: unknown, init?: RequestInit) => {
    seen.sent += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

it("keeps the floor under which no call starts at 50 ms", () => {
  expect(MIN_CALL_MS).toBe(50);
});

describe("RpcClient remainingMs", () => {
  let silent: Server;
  let silentUrl = "";

  beforeAll(async () => {
    silent = createServer(() => {}); // accepts connections and never answers
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    silentUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("makes no request, and says so, when no time is left", async () => {
    let sent = 0;
    const rpc = new RpcClient({
      urls: ["https://a.test"],
      remainingMs: () => 0,
      fetch: (async () => {
        sent += 1;
        return new Response("{}");
      }) as typeof fetch,
    });
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.message).toMatch(/time left/);
    expect(sent).toBe(0);
  });

  it("starts no try with less than MIN_CALL_MS left", async () => {
    for (const left of TOO_LITTLE) {
      const { fetch, seen } = stalling();
      const rpc = new RpcClient({ urls: ["https://a.test"], remainingMs: () => left, fetch });
      const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
      expect(error, String(left)).toBeInstanceOf(RpcError);
      expect(error.message, String(left)).toMatch(
        /the time left for this job ran out after 0 attempt/,
      );
      expect(seen.sent, String(left)).toBe(0);
    }
  });

  it("starts a try with exactly MIN_CALL_MS left, and gives it that as its timeout", async () => {
    const { fetch, seen } = stalling();
    const rpc = new RpcClient({
      urls: ["https://a.test"],
      maxRounds: 1,
      timeoutMs: 30_000,
      remainingMs: () => 50,
      fetch,
    });
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(seen.sent).toBe(1);
    expect(error.attempts.map((a) => a.error)).toEqual(["network error: timed out after 50ms"]);
  });

  it("cuts a back-off to the time left, and starts no try after it with less than MIN_CALL_MS", async () => {
    // every endpoint answers 503, so the client backs off 100 ms before its second try; the fake sleep moves the clock
    const run = async (start: number) => {
      let left = start;
      let sent = 0;
      const slept: number[] = [];
      const rpc = new RpcClient({
        urls: ["https://a.test", "https://b.test"],
        maxRounds: 1,
        baseDelayMs: 100,
        remainingMs: () => left,
        sleep: async (ms) => {
          slept.push(ms);
          left -= ms;
        },
        fetch: (async () => {
          sent += 1;
          return new Response("busy", { status: 503 });
        }) as typeof fetch,
      });
      const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
      expect(error).toBeInstanceOf(RpcError);
      return { error, sent, slept };
    };
    // 149 ms: the back-off is waited out in full and leaves 49 ms, so the second try is refused
    const short = await run(149);
    expect(short.error.message).toMatch(/the time left for this job ran out after 1 attempt/);
    expect(short.sent).toBe(1);
    expect(short.slept).toEqual([100]);
    // 150 ms: the back-off leaves exactly MIN_CALL_MS, so the second try is made
    const enough = await run(150);
    expect(enough.error.message).toMatch(/all 2 RPC endpoint\(s\) failed after 2 attempts/);
    expect(enough.sent).toBe(2);
    expect(enough.slept).toEqual([100]);
    // 60 ms: the back-off is cut to what is left, and nothing is left for the second try
    const cut = await run(60);
    expect(cut.error.message).toMatch(/the time left for this job ran out after 1 attempt/);
    expect(cut.sent).toBe(1);
    expect(cut.slept).toEqual([60]);
  });

  it("gives every try the smaller of timeoutMs and the time left, and stops retrying when it is over", async () => {
    const deadline = Date.now() + 300;
    const rpc = new RpcClient({
      urls: [silentUrl, silentUrl],
      maxRounds: 5, // ten tries and a long back-off without a deadline
      timeoutMs: 30_000,
      baseDelayMs: 100,
      remainingMs: () => deadline - Date.now(),
    });
    const started = Date.now();
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    // the first try used all the time there was (not 30 s), and nothing ran past the deadline
    expect(Date.now() - started).toBeLessThan(1500);
    expect(error.attempts.length).toBeGreaterThanOrEqual(1);
    expect(error.attempts[0]?.error).toMatch(/timed out after (\d+)ms/);
    const first = Number(/timed out after (\d+)ms/.exec(error.attempts[0]?.error ?? "")?.[1]);
    expect(first).toBeLessThanOrEqual(300);
  });

  it("keeps its defaults when the option is not given", async () => {
    const rpc = new RpcClient({
      urls: [silentUrl],
      maxRounds: 2,
      timeoutMs: 100,
      sleep: async () => {},
    });
    const error = (await rpc.viewAccount("a.testnet").catch((e: unknown) => e)) as RpcError;
    expect(error.attempts.map((a) => a.error)).toEqual([
      "network error: timed out after 100ms",
      "network error: timed out after 100ms",
    ]);
  });
});

describe("NearApiJsSender sendTimeoutMs as a function", () => {
  /** A sender over a fake provider; by default the provider's block read never answers, so signing hangs. */
  function sender(
    sendTimeoutMs: number | (() => number),
    options: FakeProviderOptions = { blockHangs: true },
  ) {
    const fake = fakeProvider(options);
    const s = new NearApiJsSender({
      accountId: VAULT,
      secretKey: key.secretKey,
      rpcUrl: () => "https://rpc.test",
      createProvider: () => fake.provider,
      sendTimeoutMs,
    });
    return { s, ...fake };
  }

  /** A time left that answers `values` in turn, one per read (one read per step), and the last one from then on. */
  const answers = (...values: number[]) => {
    let read = 0;
    return () => values[Math.min(read++, values.length - 1)] ?? Number.NaN;
  };
  const never = () => new Promise<never>(() => {});
  const invalidNonce = () => new InvalidNonceError(9, 8, "", "");
  const unknownToNode = (args: unknown) => {
    throw new UnknownTransactionError(String((args as { txHash: string }).txHash));
  };
  const paid = () => ({ status: { SuccessValue: "" } });
  const HASH = "8Ha8qkqA9xVgG4xjxUeBGbv5RJz5bQ7Nqp1s4i8wQ2Wd";

  it("reads the function at each step and uses what it answers", async () => {
    let reads = 0;
    const { s } = sender(() => {
      reads += 1;
      return 60;
    });
    const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as Error;
    // the stuck signing step: nothing was sent, and the deadline named is the one the function gave
    expect(error.message).toContain("timed out after 60 ms");
    expect(reads).toBe(1);
  });

  it("follows a time that shrinks: the next step gets what is left", async () => {
    // signing answers at once; the send never does, so it ends at the deadline of the second read
    const { s, sent } = sender(answers(2000, 60), { send: never });
    const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(TxOutcomeUnknownError);
    expect(error.message).toContain("timed out after 60 ms");
    expect(sent).toHaveLength(1);
  });

  it("starts no step, and asks the node nothing, with less than MIN_CALL_MS left or a time that is not a finite number", async () => {
    for (const left of [
      0,
      -5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      1,
      49,
    ]) {
      const { s, calls } = sender(() => left);
      const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as ProbarionError;
      // nothing was signed or sent: a definite failure, never an unknown outcome
      expect(error, String(left)).toBeInstanceOf(ProbarionError);
      expect(error, String(left)).not.toBeInstanceOf(TxOutcomeUnknownError);
      expect(error.code, String(left)).toBe("TxSendFailed");
      expect(error.message, String(left)).toBe(
        `spend transaction could not be sent (nothing was sent): the time left ran out before signing it (less than ${MIN_CALL_MS} ms)`,
      );
      expect(calls, String(left)).toEqual([]);
    }
  });

  it("starts a step with exactly MIN_CALL_MS left, and gives it that as its deadline", async () => {
    const { s, calls } = sender(() => 50);
    const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as ProbarionError;
    expect(error.code).toBe("TxSendFailed");
    expect(error.message).toContain("timed out after 50 ms");
    expect(calls).toContain("viewBlock");
  });

  it("sends nothing when the time runs out after signing, and says nothing was sent", async () => {
    for (const left of [49, 0, Number.NaN]) {
      const { s, sent, calls } = sender(answers(2000, left), {});
      const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as ProbarionError;
      expect(error, String(left)).toBeInstanceOf(ProbarionError);
      expect(error, String(left)).not.toBeInstanceOf(TxOutcomeUnknownError);
      expect(error.code, String(left)).toBe("TxSendFailed");
      expect(error.message, String(left)).toBe(
        `spend transaction could not be sent (nothing was sent): the time left ran out before sending it (less than ${MIN_CALL_MS} ms)`,
      );
      expect(sent, String(left)).toHaveLength(0);
      expect(calls, String(left)).not.toContain("sendTransactionUntil");
    }
  });

  it("keeps the hash in a TxOutcomeUnknownError when a lookup has too little time, and asks the node nothing", async () => {
    for (const left of [49, 0, Number.NaN]) {
      const { s, statusCalls } = sender(() => left, { status: paid });
      const error = (await s.lookup(HASH).catch((e: unknown) => e)) as TxOutcomeUnknownError;
      expect(error, String(left)).toBeInstanceOf(TxOutcomeUnknownError);
      expect(error.txHash, String(left)).toBe(HASH);
      expect(error.message, String(left)).toContain(
        `the time left ran out before the node could be asked (less than ${MIN_CALL_MS} ms)`,
      );
      expect(statusCalls, String(left)).toHaveLength(0);
    }
    // with MIN_CALL_MS left the lookup is made
    const { s, statusCalls } = sender(() => 50, { status: paid });
    expect((await s.lookup(HASH)).ok).toBe(true);
    expect(statusCalls).toHaveLength(1);
  });

  describe("after the node refused a send with InvalidNonce", () => {
    const refusing = { send: () => Promise.reject(invalidNonce()), status: unknownToNode };

    it("keeps the outcome unknown, with the hash that was sent, when the lookup of it has too little time", async () => {
      // signing, the send (refused), then 49 ms for the lookup of the transaction just sent
      const { s, sent, statusCalls } = sender(answers(2000, 2000, 49), refusing);
      const error = (await s
        .functionCall(spendTx)
        .catch((e: unknown) => e)) as TxOutcomeUnknownError;
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
      expect(sent).toHaveLength(1);
      const signed = sent[0]?.signed;
      if (signed === undefined) throw new Error("nothing sent");
      expect(error.txHash).toBe(txHashOf(signed));
      expect(statusCalls).toHaveLength(0);
    });

    // The node refused the nonce of the transaction sent and said it does not know it: the same proof the sender signs
    // again on, and the one a refusal after the last retry rests on. So the call ends as that refusal (nothing ran), not as
    // "nothing was sent": a transaction was sent.
    it("ends as the node's InvalidNonce refusal when the time runs out before a fresh signature", async () => {
      // signing, the send (refused), the lookup (unknown to the node), then 49 ms for the fresh signature
      const { s, sent, calls } = sender(answers(2000, 2000, 2000, 49), refusing);
      const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as TxRejectedError;
      expect(error).toBeInstanceOf(TxRejectedError);
      expect(error.kind).toBe("InvalidNonce");
      expect(error.message).toMatch(
        /refused by the node before it ran \(nothing changed\): InvalidNonce: /,
      );
      expect(error.message).toContain(
        `the node refused the key's nonce, and the time left ran out before a fresh signature could be sent (less than ${MIN_CALL_MS} ms)`,
      );
      expect(error.message).not.toContain("nothing was sent");
      expect(sent).toHaveLength(1);
      expect(calls.filter((c) => c === "viewAccessKey")).toHaveLength(1);
    });

    it("ends the same way when the time runs out after the fresh signature, before its send", async () => {
      const { s, sent, calls } = sender(answers(2000, 2000, 2000, 2000, 49), refusing);
      const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as TxRejectedError;
      expect(error).toBeInstanceOf(TxRejectedError);
      expect(error.kind).toBe("InvalidNonce");
      expect(error.message).toContain(
        "the time left ran out before a fresh signature could be sent",
      );
      expect(sent).toHaveLength(1);
      expect(calls.filter((c) => c === "viewAccessKey")).toHaveLength(2);
    });
  });

  // A function that throws is no time either: each step refuses as it does under the floor, and says what was thrown.
  // Thrown on raw, the error would lose the hash of a transaction already sent, or pass for one that may have run.
  describe("when the function throws", () => {
    const refusing = { send: () => Promise.reject(invalidNonce()), status: unknownToNode };
    /** 2000 ms at every read but read `n` (counted from 1), which throws. */
    const throwsAt = (n: number) => {
      let read = 0;
      return () => {
        read += 1;
        if (read === n) throw new Error("clock unavailable");
        return 2000;
      };
    };
    const threw = "the time left could not be read";
    const why = "sendTimeoutMs threw: clock unavailable";

    it("signs and sends nothing when it throws before signing or before the send: TxSendFailed", async () => {
      for (const [n, step] of [
        [1, "signing"],
        [2, "sending"],
      ] as const) {
        const { s, sent, calls } = sender(throwsAt(n), {});
        const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as ProbarionError;
        expect(error, step).toBeInstanceOf(ProbarionError);
        expect(error, step).not.toBeInstanceOf(TxOutcomeUnknownError);
        expect(error.code, step).toBe("TxSendFailed");
        expect(error.message, step).toBe(
          `spend transaction could not be sent (nothing was sent): ${threw} before ${step} it (${why})`,
        );
        expect((error.cause as Error | undefined)?.message, step).toBe("clock unavailable");
        expect(sent, step).toHaveLength(0);
        if (n === 1) expect(calls).toEqual([]);
      }
    });

    it("keeps the outcome unknown, with the hash that was sent, when it throws at the lookup after an InvalidNonce", async () => {
      // signing, the send (refused), then the read for the lookup of the transaction just sent throws
      const { s, sent, statusCalls } = sender(throwsAt(3), refusing);
      const error = (await s
        .functionCall(spendTx)
        .catch((e: unknown) => e)) as TxOutcomeUnknownError;
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
      expect(sent).toHaveLength(1);
      const signed = sent[0]?.signed;
      if (signed === undefined) throw new Error("nothing sent");
      expect(error.txHash).toBe(txHashOf(signed));
      expect(error.message).toContain(`${threw} before the node could be asked (${why})`);
      expect(statusCalls).toHaveLength(0);
    });

    it("ends as the node's InvalidNonce refusal when it throws before a fresh signature or its send", async () => {
      for (const n of [4, 5]) {
        const { s, sent } = sender(throwsAt(n), refusing);
        const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as TxRejectedError;
        expect(error, String(n)).toBeInstanceOf(TxRejectedError);
        expect(error.kind, String(n)).toBe("InvalidNonce");
        expect(error.message, String(n)).toContain(
          `the node refused the key's nonce, and ${threw} before a fresh signature could be sent (${why})`,
        );
        expect(sent, String(n)).toHaveLength(1);
      }
    });

    it("keeps the hash in a TxOutcomeUnknownError when it throws at a caller's lookup", async () => {
      const { s, statusCalls } = sender(throwsAt(1), { status: paid });
      const error = (await s.lookup(HASH).catch((e: unknown) => e)) as TxOutcomeUnknownError;
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
      expect(error.txHash).toBe(HASH);
      expect(error.message).toContain(`${threw} before the node could be asked (${why})`);
      expect(statusCalls).toHaveLength(0);
    });
  });

  it("does not turn a deadline longer than a timer can hold into 1 ms", async () => {
    // a timer longer than 2^31 - 1 ms fires after 1 ms; the send here answers after 20 ms
    const late = () =>
      new Promise((resolve) => setTimeout(() => resolve({ status: { SuccessValue: "" } }), 20));
    for (const ms of [2 ** 31, 1e12]) {
      for (const sendTimeoutMs of [ms, () => ms]) {
        const { s, sent } = sender(sendTimeoutMs, { send: late });
        expect((await s.functionCall(spendTx)).ok, String(ms)).toBe(true);
        expect(sent).toHaveLength(1);
      }
    }
  });

  it("still refuses a fixed timeout that is not a positive number, and keeps a fixed one working", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sender(bad)).toThrow(ConfigError);
    }
    expect(() => sender(25)).not.toThrow();
  });

  it("keeps a fixed timeout below MIN_CALL_MS as it is: the floor is for the time a caller has left", async () => {
    const { s, calls } = sender(25);
    const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as ProbarionError;
    expect(error.code).toBe("TxSendFailed");
    expect(error.message).toContain("timed out after 25 ms");
    expect(calls).toContain("viewBlock");
  });
});

describe("NearAiProposer remainingMs and knownModel", () => {
  const stall: typeof fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const LONG = { catalog: 30_000, report: 30_000, chat: 30_000, signature: 30_000 };

  function proposer(extra: Partial<ConstructorParameters<typeof NearAiProposer>[0]> = {}) {
    const fake = createFakeNearAi({ respond: () => proposalJson });
    const nearai = new NearAiProposer({
      apiKey: API_KEY,
      baseUrl: FAKE_NEARAI_BASE_URL,
      fetch: fake.fetch,
      now: () => new Date("2026-11-05T12:00:00.000Z"),
      sleep: async () => {},
      ...extra,
    });
    return { nearai, fake };
  }

  it("makes no call when no time is left", async () => {
    const { nearai, fake } = proposer({ remainingMs: () => 0 });
    const error = (await nearai.listModelCatalog().catch((e: unknown) => e)) as NearAiError;
    expect(error).toBeInstanceOf(NearAiError);
    expect(error.message).toMatch(/time left/);
    expect(fake.calls).toHaveLength(0);
  });

  it("starts no call with less than MIN_CALL_MS left", async () => {
    for (const left of TOO_LITTLE) {
      const { nearai, fake } = proposer({ remainingMs: () => left });
      const error = (await nearai.listModelCatalog().catch((e: unknown) => e)) as NearAiError;
      expect(error, String(left)).toBeInstanceOf(NearAiError);
      expect(error.message, String(left)).toBe(
        "GET /model/list: the time left for the model step ran out (not sent)",
      );
      expect(fake.calls, String(left)).toHaveLength(0);
    }
  });

  it("starts a call with exactly MIN_CALL_MS left, and gives it that as its timeout", async () => {
    const { fetch, seen } = stalling();
    const { nearai } = proposer({ fetch, timeoutMs: LONG, remainingMs: () => 50 });
    const error = (await nearai.listModelCatalog().catch((e: unknown) => e)) as NearAiError;
    expect(error).toBeInstanceOf(NearAiError);
    expect(seen.sent).toBe(1);
    expect(error.message).toBe("GET /model/list: timed out after 50 ms (request)");
  });

  it("gives every call the smaller of its phase timeout and the time left, and says what it used", async () => {
    // the clock starts once the proposer is built, so a slow machine does not eat the time before the call
    let deadline = Number.POSITIVE_INFINITY;
    const { nearai } = proposer({
      fetch: stall,
      timeoutMs: LONG,
      remainingMs: () => deadline - Date.now(),
    });
    deadline = Date.now() + 120;
    const started = Date.now();
    const error = (await nearai.listModelCatalog().catch((e: unknown) => e)) as NearAiError;
    expect(error).toBeInstanceOf(NearAiError);
    const used = Number(/timed out after (\d+) ms/.exec(error.message)?.[1]);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(120);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("shares one budget across the calls of a proposer: what the first one used is not left for the next", async () => {
    const deadline = Date.now() + 150;
    const { nearai } = proposer({
      fetch: stall,
      timeoutMs: LONG,
      remainingMs: () => deadline - Date.now(),
    });
    await nearai.listModelCatalog().catch(() => undefined); // uses it all
    const second = (await nearai
      .fetchModelReports(FAKE_PRIVATE_MODEL, sha256Hex(utf8("n")))
      .catch((e: unknown) => e)) as NearAiError;
    expect(second).toBeInstanceOf(NearAiError);
    expect(second.message).toMatch(/time left/);
  });

  /** A proposer whose every signature read answers 404, so it backs off 400 ms, then 800 ms, between tries. */
  function signature404s(left: number) {
    let slept = 0;
    let reads = 0;
    const fake = createFakeNearAi({ respond: () => proposalJson });
    const nearai = new NearAiProposer({
      apiKey: API_KEY,
      baseUrl: FAKE_NEARAI_BASE_URL,
      fetch: (async (input, init) => {
        if (!String(input).includes("/signature/")) return fake.fetch(input, init);
        reads += 1;
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
      sleep: async (ms) => {
        slept += ms;
      },
      signatureRetryDelayMs: 400,
      remainingMs: () => left,
    });
    const run = async () => {
      const error = (await nearai
        .fetchSignature("chatcmpl-test-double-1", FAKE_PRIVATE_MODEL)
        .catch((e: unknown) => e)) as NearAiError;
      expect(error).toBeInstanceOf(NearAiError);
      return { error, slept, reads };
    };
    return run();
  }

  it("does not wait out a signature back-off the time left cannot cover", async () => {
    const { error, slept, reads } = await signature404s(300); // less than the first back-off
    expect(error.message).toMatch(/no time left/);
    expect(slept).toBe(0);
    expect(reads).toBe(1);
  });

  it("does not wait out a signature back-off that would leave less than MIN_CALL_MS for the try after it", async () => {
    // 449 ms: the first back-off (400 ms) would leave 49 ms, so there is no second try
    const short = await signature404s(449);
    expect(short.error.message).toMatch(/no time left for another try \(last: HTTP 404\)/);
    expect(short.slept).toBe(0);
    expect(short.reads).toBe(1);
    // 450 ms: it leaves exactly MIN_CALL_MS, so the second try is made; the next back-off (800 ms) is not waited out
    const enough = await signature404s(450);
    expect(enough.error.message).toMatch(/no time left for another try \(last: HTTP 404\)/);
    expect(enough.slept).toBe(400);
    expect(enough.reads).toBe(2);
  });

  it("keeps a model the caller already resolved: no catalog call and no probe", async () => {
    const { nearai, fake } = proposer({ knownModel: FAKE_PRIVATE_MODEL });
    expect(await nearai.resolveModel()).toBe(FAKE_PRIVATE_MODEL);
    expect(nearai.resolvedModel).toBe(FAKE_PRIVATE_MODEL);
    expect(fake.calls).toHaveLength(0);
  });

  it("reports the model it resolved, and null before it has", async () => {
    const { nearai } = proposer();
    expect(nearai.resolvedModel).toBeNull();
    expect(await nearai.resolveModel()).toBe(FAKE_PRIVATE_MODEL);
    expect(nearai.resolvedModel).toBe(FAKE_PRIVATE_MODEL);
  });

  it("refuses a known model that is not a non-empty string", () => {
    for (const bad of ["", "  ", 5 as never]) {
      expect(() => proposer({ knownModel: bad }), String(bad)).toThrow(NearAiError);
    }
  });

  it("changes nothing for a caller that passes neither option", async () => {
    const { nearai, fake } = proposer();
    await nearai.resolveModel();
    expect(fake.calls.some((c) => c.path === "/v1/model/list")).toBe(true);
    expect(fake.calls.some((c) => c.path === "/v1/attestation/report")).toBe(true);
  });
});
