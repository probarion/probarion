// readPayeeSignals over a scripted JSON-RPC fetch (TEST DOUBLES only, R20): NEAR's final and archival reads, Base,
// a vault's history, and every way a read can fail. A failed read is "unknown", and core's assessPayee then warns.
import { assessPayee, type PayeeRef } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHIVAL_RPC_URLS,
  PAYEE_ARCHIVAL_RPC_URLS,
  PAYEE_BASE_RPC_URLS,
  type ReadPayeeSignalsOptions,
  readPayeeSignals,
} from "../src/index.js";

const RPC = "https://rpc.payee.test/";
const ARCHIVAL = "https://archival.payee.test/";
const BASE_RPC = "https://base.payee.test/";
const NOW = new Date("2026-11-14T00:00:00.000Z");
const VENDOR: PayeeRef = { chain: "near", address: "vendor.testnet" };
const VAULT = "acme.vaults.probarion.testnet";
const BASE_PAYEE: PayeeRef = {
  chain: "base",
  address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
};
const NO_CODE = "11111111111111111111111111111111";
const CODE_A = "55E7imniT2uuYrECn17qJAk9fLcwQW4ftNSwmCJL5Di";
const CODE_B = "7cFNkhEuR8gc6FNtjj9dR5nNAQA3cfYuM8FTvpF6Fxbd";

// Two headers 100,000 blocks apart at 0.6 s a block: 7 days back is 1,008,000 blocks below the top.
const TOP = 300_000_000;
const TOP_NS = 1_794_000_000_000_000_000n;
const SAMPLE = TOP - 100_000;
const SAMPLE_NS = TOP_NS - 100_000n * 600_000_000n;
const WEEK_AGO = TOP - 1_008_000;

type Answer = { result: unknown } | { error: unknown } | Response;
type Call = { url: string; method: string; params: Record<string, unknown> & unknown[] };
type Handler = (call: Call) => Answer | Promise<Answer>;

function scripted(handler: Handler) {
  const calls: Call[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: string;
      method: string;
      params: Call["params"];
    };
    const call = { url: String(input), method: body.method, params: body.params };
    calls.push(call);
    const answer = await handler(call);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fake, calls };
}

const account = (code_hash = NO_CODE, extra: Record<string, unknown> = {}) => ({
  result: { amount: "1", locked: "0", code_hash, storage_usage: 182, ...extra },
});
const unknownAccount = (id: string) => ({
  error: {
    name: "HANDLER_ERROR",
    cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: id } },
    code: -32000,
    message: "Server error",
    data: `account ${id} does not exist while viewing`,
  },
});
const unknownBlock = {
  error: {
    name: "HANDLER_ERROR",
    cause: { name: "UNKNOWN_BLOCK", info: {} },
    code: -32000,
    message: "Server error",
  },
};
const header = (height: number, ns: bigint) => ({
  result: { header: { height, timestamp_nanosec: ns.toString() }, chunks: [] },
});
const view = (value: unknown) => ({
  result: {
    result: [...new TextEncoder().encode(JSON.stringify(value))],
    logs: [],
    block_height: TOP,
  },
});

interface Chain {
  now?: Answer;
  weekAgo?: (height: number) => Answer;
  mandates?: unknown;
  spends?: unknown;
}

/** A NEAR node pair that answers like the real ones: final reads and headers on RPC, old state on ARCHIVAL. */
function nearChain(chain: Chain = {}): Handler {
  return ({ url, method, params }) => {
    if (method === "block") {
      if (params.finality === "final") return header(TOP, TOP_NS);
      if (params.block_id === SAMPLE) return header(SAMPLE, SAMPLE_NS);
      return unknownBlock;
    }
    if (method === "query" && params.request_type === "view_account") {
      if (url === ARCHIVAL && typeof params.block_id === "number") {
        return chain.weekAgo?.(params.block_id) ?? account();
      }
      if (url === RPC && params.finality === "final") return chain.now ?? account();
    }
    if (method === "query" && params.request_type === "call_function" && url === RPC) {
      if (params.method_name === "list_mandates") return view(chain.mandates ?? []);
      if (params.method_name === "list_spends") return view(chain.spends ?? []);
    }
    return {
      error: {
        name: "REQUEST_VALIDATION_ERROR",
        cause: { name: "PARSE_ERROR" },
        message: "unexpected",
      },
    };
  };
}

function opts(
  fetch: typeof globalThis.fetch,
  over: ReadPayeeSignalsOptions = {},
): ReadPayeeSignalsOptions {
  return {
    rpcUrls: [RPC],
    archivalRpcUrls: [ARCHIVAL],
    baseRpcUrl: BASE_RPC,
    fetch,
    now: () => NOW,
    ...over,
  };
}

const mandate = (id: number, payee: unknown) => ({ id, payee, status: "active" });
const spend = (id: number, destination: unknown, status: string) => ({ id, destination, status });

describe("readPayeeSignals: NEAR", () => {
  it("reads an old plain account, its code a week ago, and the vault's history: allow", async () => {
    const { fetch, calls } = scripted(
      nearChain({
        mandates: [mandate(1, { type: "near", account_id: "vendor.testnet" })],
        spends: [
          spend(0, { type: "near", account_id: "vendor.testnet" }, "paid"),
          spend(1, { type: "near", account_id: "vendor.testnet" }, "rejected"),
        ],
      }),
    );
    const signals = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(fetch),
    );
    expect(signals).toEqual({
      network: "testnet",
      payee: VENDOR,
      read_at: NOW.toISOString(),
      exists: true,
      contract: false,
      new_7d: false,
      code_changed_7d: false,
      past_block: WEEK_AGO,
      known_payees: [{ payee: VENDOR, paid: 1, mandates: [1] }],
      why_unknown: {},
    });
    expect(assessPayee(signals).verdict).toBe("allow");
    // Read-only: views and headers, nothing else.
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["query", "block"]));
    // Two headers from the RPC give the block time; only the account a week back needs the archival node.
    expect(
      calls.filter((c) => c.method === "block").map((c) => [c.url, c.params.block_id ?? "final"]),
    ).toEqual([
      [RPC, "final"],
      [RPC, SAMPLE],
    ]);
    expect(calls.filter((c) => c.url === ARCHIVAL).map((c) => c.params.block_id)).toEqual([
      WEEK_AGO,
    ]);
  });

  it("marks an account that did not exist a week ago as new, with no code to compare", async () => {
    const { fetch } = scripted(nearChain({ weekAgo: () => unknownAccount("vendor.testnet") }));
    const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(signals.new_7d).toBe(true);
    expect(signals.code_changed_7d).toBeNull();
    expect(signals.known_payees).toBeNull();
    expect(assessPayee(signals).reasons.map((r) => `${r.level}:${r.id}`)).toContain("warn:new_7d");
  });

  it("compares code identities: a changed code hash, and a global contract counts as code", async () => {
    const { fetch } = scripted(nearChain({ now: account(CODE_B), weekAgo: () => account(CODE_A) }));
    const changed = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(changed.contract).toBe(true);
    expect(changed.code_changed_7d).toBe(true);

    const global = scripted(
      nearChain({
        now: account(NO_CODE, { global_contract_hash: CODE_A }),
        weekAgo: () => account(NO_CODE, { global_contract_hash: CODE_A }),
      }),
    );
    const same = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(global.fetch));
    expect(same.contract).toBe(true);
    expect(same.code_changed_7d).toBe(false);
  });

  it("counts a global contract named by account id as code, and a switch of that account as a change", async () => {
    const { fetch } = scripted(
      nearChain({
        now: account(NO_CODE, { global_contract_account_id: "b.globals.testnet" }),
        weekAgo: () => account(NO_CODE, { global_contract_account_id: "a.globals.testnet" }),
      }),
    );
    const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(signals.contract).toBe(true);
    expect(signals.code_changed_7d).toBe(true);

    const bad = scripted(nearChain({ now: account(NO_CODE, { global_contract_account_id: 5 }) }));
    const malformed = await readPayeeSignals(
      { network: "testnet", payee: VENDOR },
      opts(bad.fetch),
    );
    expect(malformed.contract).toBe("unknown");
    expect(malformed.why_unknown.contract).toContain("malformed global_contract_account_id");
  });

  it("does not call the code unchanged when both blocks name the same global contract account", async () => {
    const byAccount = account(NO_CODE, { global_contract_account_id: "a.globals.testnet" });
    const { fetch } = scripted(nearChain({ now: byAccount, weekAgo: () => byAccount }));
    const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(signals.contract).toBe(true);
    expect(signals.code_changed_7d).toBe("unknown");
    expect(signals.why_unknown.code_changed_7d).toBe(
      "it uses the global contract of a.globals.testnet, which that account can redeploy, so its code was not compared",
    );
    const ids = assessPayee(signals).reasons.map((r) => `${r.level}:${r.id}`);
    expect(ids).toContain("warn:code_change_unknown");
    expect(ids).not.toContain("info:code_unchanged_7d");
  });

  it("reads a missing account in both answer forms, and leaves age and code out", async () => {
    const legacy = {
      result: {
        error: "account vendor.testnet does not exist while viewing",
        logs: [],
        block_height: TOP,
      },
    };
    for (const now of [unknownAccount("vendor.testnet"), legacy]) {
      const { fetch } = scripted(nearChain({ now }));
      const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
      expect(signals.exists).toBe(false);
      expect(signals.contract).toBeNull();
      expect(signals.new_7d).toBeNull();
      expect(signals.code_changed_7d).toBeNull();
      expect(assessPayee(signals).verdict).toBe("block");
    }
  });

  it("steps one block lower when the height about a week back has no block", async () => {
    const { fetch } = scripted(
      nearChain({ weekAgo: (h) => (h === WEEK_AGO ? unknownBlock : account()) }),
    );
    const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(signals.past_block).toBe(WEEK_AGO - 1);
    expect(signals.new_7d).toBe(false);
  });

  it("gives unknown, then warn, when every read times out", async () => {
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const signals = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(hang, { timeoutMs: 30 }),
    );
    expect(signals.exists).toBe("unknown");
    expect(signals.contract).toBe("unknown");
    expect(signals.new_7d).toBe("unknown");
    expect(signals.code_changed_7d).toBe("unknown");
    expect(signals.known_payees).toBe("unknown");
    expect(signals.why_unknown.exists).toContain("timed out after 30ms");
    const a = assessPayee(signals);
    expect(a.verdict).toBe("warn");
    expect(a.reasons.find((r) => r.id === "exists_unknown")?.text).toContain(
      "timed out after 30ms",
    );
  });

  it("stops at the budget for all reads together, whatever each request's timeout", async () => {
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const started = Date.now();
    const signals = await readPayeeSignals(
      { network: "testnet", payee: VENDOR },
      opts(hang, { timeoutMs: 60_000, budgetMs: 200 }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(signals.exists).toBe("unknown");
    expect(assessPayee(signals).verdict).toBe("warn");
  });

  it("tries an endpoint again after an HTTP 429", async () => {
    let limited = 0;
    const { fetch } = scripted((call) => {
      if (call.url === ARCHIVAL && limited === 0) {
        limited += 1;
        return new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
      }
      return nearChain()(call);
    });
    const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(limited).toBe(1);
    expect(signals.new_7d).toBe(false);
    expect(signals.why_unknown).toEqual({});
  });

  it("gives unknown for a header or an answer it cannot read, never a value", async () => {
    const { fetch } = scripted(({ method, url }) => {
      if (method === "block") return { result: { header: { height: "high" } } };
      if (url === RPC) return { result: { amount: "1" } }; // no code_hash
      return { result: null };
    });
    const signals = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(fetch),
    );
    expect(signals.exists).toBe("unknown");
    expect(signals.new_7d).toBe("unknown");
    expect(signals.known_payees).toBe("unknown");
    expect(assessPayee(signals).verdict).toBe("warn");
  });

  it("keeps the code-change signal unknown when only the read now failed", async () => {
    const { fetch } = scripted((call) =>
      call.url === RPC && call.params.request_type === "view_account"
        ? new Response("busy", { status: 503 })
        : nearChain()(call),
    );
    const signals = await readPayeeSignals({ network: "testnet", payee: VENDOR }, opts(fetch));
    expect(signals.exists).toBe("unknown");
    expect(signals.new_7d).toBe(false);
    expect(signals.code_changed_7d).toBe("unknown");
    expect(signals.why_unknown.exists).toContain("HTTP 503");
  });
});

describe("readPayeeSignals: the vault's history", () => {
  it("joins a checksummed mandate payee and a lowercase burned spend into one Base payee", async () => {
    const lower = BASE_PAYEE.address.toLowerCase();
    const asset = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    const { fetch } = scripted(({ method, url, params }) => {
      if (url === BASE_RPC) return { result: method === "eth_getCode" ? "0x" : "0x5" };
      return nearChain({
        mandates: [
          mandate(2, { type: "intents", chain: "base", address: BASE_PAYEE.address, asset }),
          mandate(1, { type: "near", account_id: "probarion-duong.near" }),
        ],
        spends: [
          spend(0, { type: "intents", chain: "base", address: lower, asset }, "burned"),
          spend(1, { type: "near", account_id: "probarion-duong.near" }, "held"),
        ],
      })({ method, url, params });
    });
    const signals = await readPayeeSignals(
      { network: "mainnet", payee: { chain: "base", address: lower }, vault: VAULT },
      opts(fetch),
    );
    expect(signals.known_payees).toEqual([
      { payee: BASE_PAYEE, paid: 1, mandates: [2] },
      { payee: { chain: "near", address: "probarion-duong.near" }, paid: 0, mandates: [1] },
    ]);
    const a = assessPayee(signals);
    expect(a.verdict).toBe("allow");
    expect(a.reasons.map((r) => r.id)).toContain("paid_before");
  });

  it("reads every page, and gives unknown for a malformed row or a vault too long to read", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      mandate(i + 1, { type: "near", account_id: `p${i}.testnet` }),
    );
    const paged = scripted((call) =>
      call.params.method_name === "list_mandates"
        ? view(
            rows
              .slice(
                Number(JSON.parse(atob(String(call.params.args_base64))).from_index),
                undefined,
              )
              .slice(0, 100),
          )
        : nearChain()(call),
    );
    const signals = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(paged.fetch),
    );
    expect(Array.isArray(signals.known_payees) && signals.known_payees.length).toBe(150);

    const malformed = scripted(nearChain({ mandates: [{ id: 1, payee: { type: "near" } }] }));
    const bad = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(malformed.fetch),
    );
    expect(bad.known_payees).toBe("unknown");
    expect(bad.why_unknown.known_payees).toBe("list_mandates 1: malformed payee");

    const endless = scripted((call) =>
      call.params.method_name === "list_spends"
        ? view(
            Array.from({ length: 100 }, (_, i) =>
              spend(i, { type: "near", account_id: "x.testnet" }, "paid"),
            ),
          )
        : nearChain()(call),
    );
    const long = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(endless.fetch),
    );
    expect(long.known_payees).toBe("unknown");
    expect(long.why_unknown.known_payees).toBe(
      "list_spends: more than 2000 rows, so not all were read",
    );
  });
});

describe("readPayeeSignals: Base and Solana", () => {
  it("reads eth_getCode and eth_getTransactionCount on Base mainnet", async () => {
    const answers: Record<string, Record<string, string>> = {
      eoaNew: { eth_getCode: "0x", eth_getTransactionCount: "0x0" },
      safe: { eth_getCode: "0x608060405273", eth_getTransactionCount: "0x1" },
    };
    for (const [name, byMethod] of Object.entries(answers)) {
      const { fetch, calls } = scripted(({ method }) => ({ result: byMethod[method] }));
      const signals = await readPayeeSignals(
        { network: "mainnet", payee: BASE_PAYEE },
        opts(fetch),
      );
      expect(
        calls.every((c) => c.url === BASE_RPC),
        name,
      ).toBe(true);
      expect(calls.map((c) => c.params)).toEqual([
        [BASE_PAYEE.address, "latest"],
        [BASE_PAYEE.address, "latest"],
      ]);
      expect(signals.exists, name).toBeNull();
      expect(signals.code_changed_7d, name).toBeNull();
      expect(signals.contract, name).toBe(name === "safe");
      expect(signals.new_7d, name).toBe(name === "eoaNew");
    }
  });

  it("leaves Base on testnet and Solana unread: unknown, then warn, with no request sent", async () => {
    const { fetch, calls } = scripted(nearChain());
    const base = await readPayeeSignals(
      { network: "testnet", payee: BASE_PAYEE },
      opts(fetch, { baseRpcUrl: undefined }),
    );
    expect(base.contract).toBe("unknown");
    expect(base.why_unknown.contract).toBe("no Base RPC is mapped for testnet");
    const sol = await readPayeeSignals(
      {
        network: "mainnet",
        payee: { chain: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
      },
      opts(fetch),
    );
    expect(sol.new_7d).toBe("unknown");
    expect(calls).toEqual([]);
    expect(assessPayee(base).verdict).toBe("warn");
    expect(assessPayee(sol).verdict).toBe("warn");
  });

  it("gives unknown for a malformed Base answer", async () => {
    const { fetch } = scripted(() => ({ result: 42 }));
    const signals = await readPayeeSignals({ network: "mainnet", payee: BASE_PAYEE }, opts(fetch));
    expect(signals.contract).toBe("unknown");
    expect(signals.new_7d).toBe("unknown");
  });
});

describe("readPayeeSignals: input and defaults", () => {
  it("reads nothing for a payee that is not a valid address", async () => {
    const { fetch, calls } = scripted(nearChain());
    const signals = await readPayeeSignals(
      { network: "testnet", payee: { chain: "near", address: "Not An Account" }, vault: VAULT },
      opts(fetch),
    );
    expect(calls).toEqual([]);
    expect(signals.exists).toBe("unknown");
    expect(assessPayee(signals).verdict).toBe("block");
  });

  it("gives unknown, not an exception, for an empty URL list", async () => {
    const { fetch, calls } = scripted(nearChain());
    const signals = await readPayeeSignals(
      { network: "testnet", payee: VENDOR, vault: VAULT },
      opts(fetch, { rpcUrls: [] }),
    );
    expect(calls).toEqual([]);
    expect(signals.exists).toBe("unknown");
    expect(signals.known_payees).toBe("unknown");
    expect(signals.why_unknown.exists).toBe("at least one NEAR RPC URL is required");
    expect(assessPayee(signals).verdict).toBe("warn");
  });

  it("defaults to FastNEAR's archival nodes (the snapshot code's too) and Base mainnet only", () => {
    expect(PAYEE_ARCHIVAL_RPC_URLS).toEqual(DEFAULT_ARCHIVAL_RPC_URLS);
    expect(PAYEE_BASE_RPC_URLS).toEqual({ mainnet: "https://mainnet.base.org", testnet: null });
  });
});
