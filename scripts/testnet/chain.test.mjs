import assert from "node:assert/strict";
import { test } from "node:test";
import { globalCodeStatus, main } from "./chain.mjs";

const HASH = "AoPRQSq7cvnZtqBSruN8xi7LzYCb3CY3zVFu9dWtPNJP";

// The two shapes below are what rpc.mainnet.fastnear.com and rpc.testnet.fastnear.com answered to
// a view_global_contract_code query on 2026-11-01 (code_base64 shortened).
const PUBLISHED = {
  jsonrpc: "2.0",
  id: 1,
  result: { block_hash: "CVfN", block_height: 222565202, code_base64: "AGFzbQ==", hash: HASH },
};
const NOT_PUBLISHED = {
  jsonrpc: "2.0",
  id: 1,
  error: {
    name: "HANDLER_ERROR",
    cause: {
      info: { block_hash: "CVfN", block_height: 222565202, identifier: { hash: HASH } },
      name: "NO_GLOBAL_CONTRACT_CODE",
    },
    code: -32000,
    message: "Server error",
    data: `Global contract code with identifier CodeHash(${HASH}) has never been observed on the node`,
  },
};

test("a hash that answers with its own code is published", () => {
  assert.equal(globalCodeStatus(PUBLISHED, HASH), "published");
});

test("NO_GLOBAL_CONTRACT_CODE means not published", () => {
  assert.equal(globalCodeStatus(NOT_PUBLISHED, HASH), "not published");
});

test("any other reply is an error, never read as not published", () => {
  const other = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
  assert.throws(() => globalCodeStatus(other, HASH), /UNKNOWN_BLOCK/);
  assert.throws(() => globalCodeStatus({}, HASH), /no matching result/);
  assert.throws(() => globalCodeStatus(undefined, HASH), /no matching result/);
  const wrongHash = { result: { ...PUBLISHED.result, hash: "11111111111111111111111111111111" } };
  assert.throws(() => globalCodeStatus(wrongHash, HASH), /no matching result/);
});

/** Runs `main` with `fetch` answering `reply`; returns the result and the request that was sent. */
async function runWith(reply, args) {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => reply };
  };
  try {
    return { result: await main(args), sent };
  } finally {
    globalThis.fetch = real;
  }
}

test("global-code asks the read-only view_global_contract_code query and exits 0 only if published", async () => {
  const yes = await runWith(PUBLISHED, ["global-code", HASH]);
  assert.deepEqual(yes.result, { out: "published", code: 0 });
  assert.equal(yes.sent.body.method, "query");
  assert.deepEqual(yes.sent.body.params, {
    request_type: "view_global_contract_code",
    finality: "final",
    code_hash: HASH,
  });

  const no = await runWith(NOT_PUBLISHED, ["global-code", HASH]);
  assert.deepEqual(no.result, { out: "not published", code: 1 });
});

test("global-code needs a hash", async () => {
  await assert.rejects(() => main(["global-code"]), /usage: chain\.mjs global-code <code-hash>/);
});
