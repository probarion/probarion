// `probarion tx prove` over a scripted JSON-RPC fetch (TEST DOUBLES only, R20) that serves the answers N1 recorded
// from NEAR mainnet (packages/near/test/fixtures/proofs): the head on two origins, the `tx` answer and one
// light_client_proof per outcome. The printed tree with its events, the JSON, the exit codes (0 proven, 1 not
// proven or a failed read, 64 usage) and the exact requests are checked. Tampered answers are made in the test from
// the recorded ones and are labelled. Nothing here talks to a network.
//
// Needs the built packages: pnpm --filter @probarion/core build, --filter @probarion/sdk build and
// --filter @probarion/near build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CliIo } from "../src/io.js";
import { runCli } from "../src/program.js";
import { testIo } from "./helpers.js";

const HEAD_A = "https://head-a.test/";
const HEAD_B = "https://head-b.test/";
const ARCHIVAL = "https://archival.test/";
const PROOFS = fileURLToPath(new URL("../../near/test/fixtures/proofs/", import.meta.url));

type Params = Record<string, unknown>;
type Call = { url: string; method: string; params: Params };
interface Proof {
  outcome_proof: {
    id: string;
    outcome: { executor_id: string; logs: string[]; receipt_ids: string[]; status: unknown };
  };
}
interface ProofsFixture {
  head: { hash: string; height: number; blockMerkleRoot: string };
  head_secondary: { hash: string; height: number; block_merkle_root: string };
  tx: {
    transaction: { hash: string; signer_id: string };
    receipts_outcome: { id: string; outcome: { executor_id: string } }[];
  };
  proofs: Proof[];
}

function fixture(name: string): ProofsFixture {
  return JSON.parse(readFileSync(join(PROOFS, name), "utf8")) as ProofsFixture;
}

/** Mainnet spend 2 of v0.probarion.near: the tx, its 10 receipts and their 11 proofs under one head. */
const SPEND_2 = fixture("mainnet-spend-2.json");
const TX = SPEND_2.tx.transaction.hash;
const SIGNER = SPEND_2.tx.transaction.signer_id;
/** The receipt where the POA token on Base burned the payout: its ft_burn carries the WITHDRAW_TO memo. */
const POA_BURN = "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b";

/**
 * HEAD_A answers `block {finality: final}` with the recorded head, HEAD_B answers `block {block_id}` with the
 * recorded secondary; ARCHIVAL answers `tx` and `light_client_proof` (looked up by the outcome id asked for).
 * Anything else is an error answer. Every request lands in `calls` with the URL it was sent to.
 */
function chain(fx: ProofsFixture, calls: Call[] = []): typeof fetch {
  const block = (h: { hash: string; height: number; merkleRoot: string }) => ({
    result: { header: { hash: h.hash, height: h.height, block_merkle_root: h.merkleRoot } },
  });
  const answer = (
    url: string,
    method: string,
    params: Params,
  ): { result: unknown } | { error: unknown } => {
    if (url === HEAD_A && method === "block" && params.finality === "final") {
      return block({ ...fx.head, merkleRoot: fx.head.blockMerkleRoot });
    }
    if (url === HEAD_B && method === "block" && params.block_id === fx.head_secondary.hash) {
      return block({ ...fx.head_secondary, merkleRoot: fx.head_secondary.block_merkle_root });
    }
    if (url === ARCHIVAL && method === "tx" && params.tx_hash === fx.tx.transaction.hash) {
      return { result: fx.tx };
    }
    if (url === ARCHIVAL && method === "light_client_proof") {
      const id = params.type === "transaction" ? params.transaction_hash : params.receipt_id;
      const proof = fx.proofs.find((p) => p.outcome_proof.id === id);
      if (proof !== undefined) return { result: proof };
    }
    return {
      error: { name: "REQUEST_VALIDATION_ERROR", message: `unexpected ${method} on ${url}` },
    };
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Params };
    calls.push({ url, method: body.method, params: body.params });
    const out = answer(url, body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...out }), { status: 200 });
  }) as typeof fetch;
}

const ROUTES = ["--head-rpc", `${HEAD_A},${HEAD_B}`, "--archival-rpc", ARCHIVAL];

async function run(args: string[], fx: ProofsFixture = SPEND_2, txHash = TX, signer = SIGNER) {
  const { io, state } = testIo(process.cwd());
  const calls: Call[] = [];
  const withFetch: CliIo = { ...io, nearDeps: { fetch: chain(fx, calls) } };
  const code = await runCli(
    ["--network", "mainnet", "tx", "prove", txHash, "--signer", signer, ...ROUTES, ...args],
    withFetch,
  );
  return { code, out: state.out, err: state.err, calls };
}

/** A deep copy of the fixture with `edit` applied (a tampered answer made in this test, not a recorded one). */
function tampered(edit: (fx: ProofsFixture) => void): ProofsFixture {
  const copy = structuredClone(SPEND_2);
  edit(copy);
  return copy;
}

describe("probarion tx prove", () => {
  it("proves mainnet spend 2 and lists each outcome with its events (snapshot)", async () => {
    const { code, out, err } = await run([]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatchInlineSnapshot(`
      "PROVEN: tx BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9 signed by v0.probarion.near on mainnet: 11 outcome(s) committed under block 224468697 (BhK1wjhwJbbxrz5Bygb4C7xVFfE2TBiLzzNggepHNdPv)
        BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9  v0.probarion.near  block 224331723  success (continues in receipt FuEKLqzVPpm3Ks9xVMHmNk3A2SJTNYbra17HVeKz96a9)
        FuEKLqzVPpm3Ks9xVMHmNk3A2SJTNYbra17HVeKz96a9  v0.probarion.near  block 224331723  success (continues in receipt ChNYpWkBdspsT81quDPBLKZ5AWn37x6DkN1nNdzComfY)
          event probarion spend_submitted 1.0.0 {"spend_id":2,"mandate_id":2,"amount":"1000000","invoice_hash":"bd45f2327fb0c2c1e960606e5c0bb91e3cfec7883f21315e94f454a83fee8357","decision_hash":"d64f0de77c38294cf103439e6b5b0c2623b96b114962afd50f5a3c553df2a336","destination":{"type":"intents","chain":"base","address":"0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27","asset":"base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"}}
        F2BErA5fo6HBPhgwjyER9iiCrs9XHmDHX6dsey1dZmVi  intents.near  block 224331724  success (continues in receipt 8hAiNNwar1yut3LSSSvYQxp9NA7Xbv187GZRWd68HU2w)
          event nep245 mt_burn 1.0.0 [{"owner_id":"v0.probarion.near","token_ids":["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"],"amounts":["1000000"],"memo":"withdraw"}]
        D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b  base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near  block 224331725  success (no value)
          event nep141 ft_burn 1.0.0 [{"owner_id":"intents.near","amount":"1000000","memo":"WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27"}]
        9aKWUzfU2vCZSxdZcPeKmTKFLLDqgT6PiWZFGJCUP5xV  v0.probarion.near  block 224331726  success (no value)
        8hAiNNwar1yut3LSSSvYQxp9NA7Xbv187GZRWd68HU2w  intents.near  block 224331726  success (value "1000000")
        HKQpYHXvpCaUxhs5r2GZriNwktFSmiByZ3uh24orJEPP  v0.probarion.near  block 224331727  success (no value)
        6s73ZacDZB2tv2XDtTZjxMmy6aAPr29TmhVUEpsUM27D  v0.probarion.near  block 224331725  success (no value)
        ChNYpWkBdspsT81quDPBLKZ5AWn37x6DkN1nNdzComfY  v0.probarion.near  block 224331727  success (value {"spend_id":2,"status":"burned"})
          event probarion spend_burned 1.0.0 {"spend_id":2,"mandate_id":2,"amount":"1000000","chain":"base","address":"0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27","asset":"base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near","memo":"WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27"}
        BqZneYq1dcpsv2urNFU1dX4bKuttfeExgvpnv3RBvS1Z  v0.probarion.near  block 224331728  success (no value)
        BCRaU7FwVhQKcZkTgYvmj6EgvirqwSkDm8n8TUtt3if9  v0.probarion.near  block 224331724  success (no value)
      Events are listed as each executor logged them: an event speaks for a token when its executor is that token's contract.
      Head block 224468697 read from https://head-a.test and matched on https://head-b.test: the head is trusted, not proven (validator signatures are not checked).
      Proofs read with light_client_proof from https://archival.test. Nothing was signed or sent.
      "
    `);
  });

  it("reads the head on one origin, matches it on the other, and fetches every proof under it", async () => {
    const { calls } = await run([]);
    expect(calls.slice(0, 3)).toEqual([
      { url: HEAD_A, method: "block", params: { finality: "final" } },
      { url: HEAD_B, method: "block", params: { block_id: SPEND_2.head.hash } },
      {
        url: ARCHIVAL,
        method: "tx",
        params: { tx_hash: TX, sender_account_id: SIGNER, wait_until: "FINAL" },
      },
    ]);
    const proofCalls = calls.slice(3);
    expect(proofCalls).toHaveLength(1 + SPEND_2.tx.receipts_outcome.length);
    expect(proofCalls[0]).toEqual({
      url: ARCHIVAL,
      method: "light_client_proof",
      params: {
        type: "transaction",
        transaction_hash: TX,
        sender_id: SIGNER,
        light_client_head: SPEND_2.head.hash,
      },
    });
    for (const [i, receipt] of SPEND_2.tx.receipts_outcome.entries()) {
      expect(proofCalls[i + 1]).toEqual({
        url: ARCHIVAL,
        method: "light_client_proof",
        params: {
          type: "receipt",
          receipt_id: receipt.id,
          receiver_id: receipt.outcome.executor_id,
          light_client_head: SPEND_2.head.hash,
        },
      });
    }
    // Views and proofs only: nothing is sent to be signed or broadcast.
    expect(new Set(calls.map((c) => c.method))).toEqual(
      new Set(["block", "tx", "light_client_proof"]),
    );
  });

  it("prints the proven outcomes and their events as JSON", async () => {
    const { code, out } = await run(["--json"]);
    expect(code).toBe(0);
    const json = JSON.parse(out) as {
      proven: boolean;
      head: unknown;
      head_origins: unknown;
      archival_origins: unknown;
      outcomes: {
        id: string;
        executorId: string;
        gasBurnt: unknown;
        tokensBurnt: unknown;
        status: { kind: string; value?: unknown };
        events: {
          standard: string;
          event: string;
          emitter: string;
          proven: boolean;
          data: unknown;
        }[];
      }[];
    };
    expect(json.proven).toBe(true);
    expect(json.head).toEqual(SPEND_2.head);
    expect(json.head_origins).toEqual({
      read: "https://head-a.test",
      matched: ["https://head-b.test"],
    });
    expect(json.archival_origins).toEqual(["https://archival.test"]);
    expect(json.outcomes.map((o) => o.id)).toEqual(SPEND_2.proofs.map((p) => p.outcome_proof.id));
    expect(json.outcomes.every((o) => !("head" in o))).toBe(true);
    expect(typeof json.outcomes[0]?.gasBurnt).toBe("string");
    expect(typeof json.outcomes[0]?.tokensBurnt).toBe("string");
    const burn = json.outcomes.find((o) => o.id === POA_BURN);
    expect(burn?.executorId).toBe("base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near");
    expect(burn?.status).toEqual({ kind: "success_value", value: "" });
    expect(burn?.events.map((e) => [e.standard, e.event, e.emitter, e.proven])).toEqual([
      ["nep141", "ft_burn", "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", true],
    ]);
    expect(JSON.stringify(burn?.events[0]?.data)).toContain(
      "WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
    );
  });

  it("exits 1, NOT PROVEN, when one character of a log is changed (tampered answer)", async () => {
    const fx = tampered((copy) => {
      const proof = copy.proofs.find((p) => p.outcome_proof.id === POA_BURN);
      const log = proof?.outcome_proof.outcome.logs[0] ?? "";
      if (proof !== undefined)
        proof.outcome_proof.outcome.logs[0] = log.replace("1000000", "9000000");
    });
    const { code, out, err } = await run([], fx);
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(out).toMatch(
      new RegExp(
        `^NOT PROVEN: tx ${TX} signed by ${SIGNER.replaceAll(".", "\\.")} on mainnet: proof \\d+: outcome_root_mismatch: `,
      ),
    );
    const json = JSON.parse((await run(["--json"], fx)).out) as Record<string, unknown>;
    expect(json.proven).toBe(false);
    expect(json.code).toBe("outcome_root_mismatch");
  });

  it("exits 1, NOT PROVEN, when the tx answer names a receipt whose proof is of another transaction", async () => {
    // Tampered pointer: the drill's failed receipt (its own recorded proof) added to spend 2's receipt list.
    const drill = fixture("mainnet-drill-over-cap.json");
    const stranger = drill.proofs[1] as Proof;
    const fx = tampered((copy) => {
      copy.tx.receipts_outcome.push({
        id: stranger.outcome_proof.id,
        outcome: { executor_id: stranger.outcome_proof.outcome.executor_id },
      });
      copy.proofs.push(stranger);
    });
    const { code, out } = await run([], fx);
    expect(code).toBe(1);
    expect(out).toMatch(/^NOT PROVEN: .*: proof 11: /);
  });

  it("proves a refused spend: the failed receipt is proven with status failure (exit 0)", async () => {
    // The drill's over-cap spend as recorded: the tx, its failed receipt and the refund receipt that one created.
    const drill = fixture("mainnet-drill-over-cap.json");
    const failed = drill.proofs[1]?.outcome_proof.id;
    const { code, out } = await run(
      [],
      drill,
      drill.tx.transaction.hash,
      drill.tx.transaction.signer_id,
    );
    expect(code).toBe(0);
    expect(out).toMatch(
      new RegExp(
        `^PROVEN: tx ${drill.tx.transaction.hash} .*: 3 outcome\\(s\\) committed under block `,
      ),
    );
    for (const proof of drill.proofs) expect(out).toContain(`  ${proof.outcome_proof.id}  `);
    expect(out).toContain(`  ${failed}  v0.probarion.near  block `);
    expect(out).toContain("failure (the proof does not carry the reason)");
    expect(out).toContain(
      "1 receipt(s) failed: the proof shows they ran and failed, and an event a failed receipt logged did not take effect.",
    );
  });

  // The tx answer only says what to fetch. An answer that leaves receipts out (tampered here from the recorded one)
  // would leave a tree that verifies but hides them, so proveTransaction refuses a proven outcome's receipt without a
  // proof as `incomplete`, and the CLI says to read it again.
  it("exits 1, NOT PROVEN (incomplete), when the tx answer leaves out the drill's failed receipt", async () => {
    const drill = fixture("mainnet-drill-over-cap.json");
    const failed = drill.proofs[1]?.outcome_proof.id as string;
    const fx: ProofsFixture = { ...drill, tx: { ...drill.tx, receipts_outcome: [] } };
    const args = [fx, drill.tx.transaction.hash, drill.tx.transaction.signer_id] as const;
    const { code, out, err, calls } = await run([], ...args);
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(out).toMatch(
      new RegExp(
        `^NOT PROVEN: tx ${drill.tx.transaction.hash} signed by v0\\.probarion\\.near on mainnet: proof 0: incomplete: `,
      ),
    );
    expect(out).toContain(failed);
    expect(out).toMatch(
      / \(the tx answer left out a receipt: run it again, or with another --archival-rpc\)\n$/,
    );
    expect(out).not.toContain("failure (the proof");
    // Only the transaction's own proof was asked for: the answer named no receipt.
    expect(calls.filter((c) => c.method === "light_client_proof")).toHaveLength(1);
    const json = JSON.parse((await run(["--json"], ...args)).out) as Record<string, unknown>;
    expect(json.proven).toBe(false);
    expect(json.code).toBe("incomplete");
    expect(json.index).toBe(0);
    expect(json.detail).toContain(failed);
    expect(json).not.toHaveProperty("outcomes");
  });

  it("exits 1, NOT PROVEN (incomplete), when the tx answer leaves out the POA burn and the receipt it created", async () => {
    const burn = SPEND_2.proofs.find((p) => p.outcome_proof.id === POA_BURN);
    const dropped = new Set([POA_BURN, ...(burn?.outcome_proof.outcome.receipt_ids ?? [])]);
    expect(dropped.size).toBe(2);
    const fx = tampered((copy) => {
      copy.tx.receipts_outcome = copy.tx.receipts_outcome.filter((r) => !dropped.has(r.id));
    });
    const { code, out } = await run([], fx);
    expect(code).toBe(1);
    expect(out).toMatch(/^NOT PROVEN: .* on mainnet: proof \d+: incomplete: /);
    expect(out).toContain(POA_BURN);
    expect(out).not.toContain("ft_burn");
    const json = JSON.parse((await run(["--json"], fx)).out) as Record<string, unknown>;
    expect(json.proven).toBe(false);
    expect(json.code).toBe("incomplete");
  });

  it("exits 1, NOT PROVEN (incomplete), when the tx answer leaves out any one leaf receipt of spend 2", async () => {
    const leaves = SPEND_2.proofs.filter(
      (p, i) => i > 0 && p.outcome_proof.outcome.receipt_ids.length === 0,
    );
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) {
      const id = leaf.outcome_proof.id;
      const fx = tampered((copy) => {
        copy.tx.receipts_outcome = copy.tx.receipts_outcome.filter((r) => r.id !== id);
      });
      const { code, out } = await run([], fx);
      expect(code, id).toBe(1);
      expect(out, id).toMatch(/^NOT PROVEN: .*: incomplete: /);
      expect(out, id).toContain(id);
    }
  });

  it("exits 1 with an error when the two head providers disagree", async () => {
    const fx = tampered((copy) => {
      copy.head_secondary.block_merkle_root = "11111111111111111111111111111111";
    });
    const { code, out, err } = await run([], fx);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/^error: tx prove could not read a head both providers agree on: block /);
    expect(err).toContain("block_merkle_root");
    expect(err).not.toContain("run it again");
  });

  it("exits 1 and says to run it again when the second provider does not know the head yet", async () => {
    // Tampered: HEAD_B is asked for a block it has not seen (another hash than the one it serves).
    const fx = tampered((copy) => {
      copy.head_secondary.hash = "11111111111111111111111111111111";
    });
    const { code, out, err } = await run([], fx);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/^error: tx prove could not read a head both providers agree on: block: /);
    expect(err).toContain(
      "(a provider a few blocks behind may not know the head yet: run it again)\n",
    );
  });

  it("exits 1 with an error, and no verdict, when the proofs cannot be read", async () => {
    const { io, state } = testIo(process.cwd());
    const served = chain(SPEND_2);
    const archivalDown = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === ARCHIVAL
        ? new Response("down", { status: 503 })
        : served(input, init)) as typeof fetch;
    const code = await runCli(
      ["--network", "mainnet", "tx", "prove", TX, "--signer", SIGNER, ...ROUTES],
      {
        ...io,
        nearDeps: { fetch: archivalDown },
      },
    );
    expect(code).toBe(1);
    expect(state.out).toBe("");
    expect(state.err).toMatch(/^error: tx prove could not read the proofs: tx: /);
  });

  it("exits 64 on a malformed hash, account or flag, or head URLs on one origin, before any read", async () => {
    for (const args of [
      ["not-a-hash", "--signer", SIGNER, ...ROUTES],
      [TX, "--signer", "Not An Account", ...ROUTES],
      [TX, ...ROUTES],
      [TX, "--signer", SIGNER, "--head-rpc", `${HEAD_A},${HEAD_A}v2`, "--archival-rpc", ARCHIVAL],
      [TX, "--signer", SIGNER, "--head-rpc", HEAD_A, "--archival-rpc", ARCHIVAL],
      [
        TX,
        "--signer",
        SIGNER,
        "--head-rpc",
        `${HEAD_A},ftp://head-b.test/`,
        "--archival-rpc",
        ARCHIVAL,
      ],
      [TX, "--signer", SIGNER, "--head-rpc", " , ", "--archival-rpc", ARCHIVAL],
      [TX, "--signer", SIGNER, "--head-rpc", `${HEAD_A},${HEAD_B}`, "--archival-rpc", " , "],
      // The testnet defaults name one RPC origin, so without --head-rpc there is no second provider.
      [TX, "--signer", SIGNER, "--network", "testnet", "--archival-rpc", ARCHIVAL],
    ]) {
      const { io, state } = testIo(process.cwd());
      let reads = 0;
      const counting = (async () => {
        reads += 1;
        return new Response("{}");
      }) as typeof fetch;
      const code = await runCli(["tx", "prove", ...args], { ...io, nearDeps: { fetch: counting } });
      expect(code, args.join(" ")).toBe(64);
      expect(reads, args.join(" ")).toBe(0);
      expect(state.err, args.join(" ")).toMatch(/^error: /);
    }
  });

  it("takes the head providers from --rpc when --head-rpc is not given", async () => {
    const { io, state } = testIo(process.cwd());
    const code = await runCli(
      [
        "--network",
        "mainnet",
        "--rpc",
        `${HEAD_A},${HEAD_B}`,
        "tx",
        "prove",
        TX,
        "--signer",
        SIGNER,
        "--archival-rpc",
        ARCHIVAL,
      ],
      { ...io, nearDeps: { fetch: chain(SPEND_2) } },
    );
    expect(code).toBe(0);
    expect(state.out).toContain("read from https://head-a.test and matched on https://head-b.test");
  });

  it("lists its exit codes in --help", async () => {
    const { io, state } = testIo(process.cwd());
    expect(await runCli(["tx", "prove", "--help"], io)).toBe(0);
    expect(state.out).toContain("Usage: probarion tx prove [options] <tx-hash>");
    expect(state.out).toContain(
      "  0   proven: the transaction and every receipt it led to are committed under the head",
    );
    expect(state.out).toContain("the tx answer left out a receipt that a proven outcome created");
  });
});
