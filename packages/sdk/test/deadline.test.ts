// The options that let a caller pass "the time I have left" to the SDK (plan 04 Task 17, ruling W-T17-R2): an overall
// `remainingMs` on the RPC client and on the NEAR AI proposer, a `sendTimeoutMs` that may be a function on the transaction
// sender, and a `knownModel` that skips the catalog and the probe. Every default is unchanged for other callers.
import { createServer, type Server } from "node:http";
import { generateKeyPair, sha256Hex, utf8 } from "@probarion/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, NearAiError, RpcError } from "../src/errors.js";
import { NearAiProposer } from "../src/nearai.js";
import { RpcClient } from "../src/rpc.js";
import {
  createFakeNearAi,
  FAKE_NEARAI_BASE_URL,
  FAKE_PRIVATE_MODEL,
} from "../src/testing/index.js";
import { type FunctionCallTx, NearApiJsSender } from "../src/tx.js";
import { fakeProvider } from "./helpers/fake-provider.js";

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
  function sender(sendTimeoutMs: number | (() => number), blockHangs = true) {
    const fake = fakeProvider({ blockHangs });
    return new NearApiJsSender({
      accountId: VAULT,
      secretKey: key.secretKey,
      rpcUrl: () => "https://rpc.test",
      createProvider: () => fake.provider,
      sendTimeoutMs,
    });
  }

  it("reads the function at each step and uses what it answers", async () => {
    let reads = 0;
    const s = sender(() => {
      reads += 1;
      return 25;
    });
    const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as Error;
    // the stuck signing step: nothing was sent, and the deadline named is the one the function gave
    expect(error.message).toContain("timed out after 25 ms");
    expect(reads).toBeGreaterThanOrEqual(1);
  });

  it("follows a time that shrinks: the next step gets what is left", async () => {
    let left = 2000;
    const answers: number[] = [];
    const s = sender(() => {
      answers.push(left);
      left = 30;
      return left;
    });
    const started = Date.now();
    await s.functionCall(spendTx).catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(answers[0]).toBe(2000);
  });

  it("treats an answer that is not a positive number as the least time, not as no limit", async () => {
    for (const bad of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const s = sender(() => bad);
      const started = Date.now();
      const error = (await s.functionCall(spendTx).catch((e: unknown) => e)) as Error;
      expect(error, String(bad)).toBeInstanceOf(Error);
      expect(error.message, String(bad)).toMatch(/timed out after 1 ms/);
      expect(Date.now() - started, String(bad)).toBeLessThan(1500);
    }
  });

  it("still refuses a fixed timeout that is not a positive number, and keeps a fixed one working", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sender(bad)).toThrow(ConfigError);
    }
    expect(() => sender(25)).not.toThrow();
  });
});

describe("NearAiProposer remainingMs and knownModel", () => {
  const stall: typeof fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

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

  it("gives every call the smaller of its phase timeout and the time left, and says what it used", async () => {
    const deadline = Date.now() + 120;
    const { nearai } = proposer({
      fetch: stall,
      timeoutMs: { catalog: 30_000, report: 30_000, chat: 30_000, signature: 30_000 },
      remainingMs: () => deadline - Date.now(),
    });
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
      timeoutMs: { catalog: 30_000, report: 30_000, chat: 30_000, signature: 30_000 },
      remainingMs: () => deadline - Date.now(),
    });
    await nearai.listModelCatalog().catch(() => undefined); // uses it all
    const second = (await nearai
      .fetchModelReports(FAKE_PRIVATE_MODEL, sha256Hex(utf8("n")))
      .catch((e: unknown) => e)) as NearAiError;
    expect(second).toBeInstanceOf(NearAiError);
    expect(second.message).toMatch(/time left/);
  });

  it("does not wait out a signature back-off the time left cannot cover", async () => {
    let slept = 0;
    const fake = createFakeNearAi({ respond: () => proposalJson });
    const nearai = new NearAiProposer({
      apiKey: API_KEY,
      baseUrl: FAKE_NEARAI_BASE_URL,
      // every signature read answers 404, so the proposer would back off between tries
      fetch: (async (input, init) =>
        String(input).includes("/signature/")
          ? new Response("{}", { status: 404 })
          : fake.fetch(input, init)) as typeof fetch,
      sleep: async (ms) => {
        slept += ms;
      },
      signatureRetryDelayMs: 400,
      remainingMs: () => 300, // less than the first back-off
    });
    const error = (await nearai
      .fetchSignature("chatcmpl-test-double-1", FAKE_PRIVATE_MODEL)
      .catch((e: unknown) => e)) as NearAiError;
    expect(error).toBeInstanceOf(NearAiError);
    expect(error.message).toMatch(/no time left/);
    expect(slept).toBe(0);
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
