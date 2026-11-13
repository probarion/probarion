// `probarion payee check` over a scripted JSON-RPC fetch (TEST DOUBLES only, R20): the printed assessment, the
// JSON, and the exit codes (0 allow, 2 warn, 1 block or a failure, 64 usage). Nothing here talks to a network.
import { describe, expect, it } from "vitest";
import type { CliIo } from "../src/io.js";
import { runCli } from "../src/program.js";
import { testIo } from "./helpers.js";

const RPC = "https://rpc.payee.test/";
const ARCHIVAL = "https://archival.payee.test/";
const VAULT = "acme.vaults.probarion.testnet";
const NO_CODE = "11111111111111111111111111111111";
const TOP = 300_000_000;
const TOP_NS = 1_794_000_000_000_000_000n;
const SAMPLE = TOP - 100_000;

type Params = Record<string, unknown>;
type Answer = { result: unknown } | { error: unknown };

interface World {
  /** Accounts on chain now. */
  now: readonly string[];
  /** Accounts on chain about 7 days back. */
  weekAgo: readonly string[];
  mandates?: unknown[];
  spends?: unknown[];
}

const missing = (id: string): Answer => ({
  error: {
    name: "HANDLER_ERROR",
    cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: id } },
    message: "Server error",
  },
});
const view = (value: unknown): Answer => ({
  result: { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [] },
});

function chain(world: World): typeof fetch {
  const answer = (url: string, method: string, params: Params): Answer => {
    if (method === "block") {
      const height = params.finality === "final" ? TOP : SAMPLE;
      const ns = height === TOP ? TOP_NS : TOP_NS - 100_000n * 600_000_000n;
      return { result: { header: { height, timestamp_nanosec: ns.toString() } } };
    }
    if (params.request_type === "view_account") {
      const id = String(params.account_id);
      const there = url === ARCHIVAL ? world.weekAgo : world.now;
      return there.includes(id)
        ? { result: { amount: "1", locked: "0", code_hash: NO_CODE, storage_usage: 182 } }
        : missing(id);
    }
    if (params.method_name === "list_mandates") return view(world.mandates ?? []);
    if (params.method_name === "list_spends") return view(world.spends ?? []);
    return { error: { name: "REQUEST_VALIDATION_ERROR", message: "unexpected" } };
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Params };
    const out = answer(String(input), body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...out }), { status: 200 });
  }) as typeof fetch;
}

/** The vault knows vendor.testnet (mandate 1) and paid it twice. */
const VENDOR_VAULT: World = {
  now: ["vendor.testnet", "vend0r.testnet", "fresh.testnet"],
  weekAgo: ["vendor.testnet", "vend0r.testnet"],
  mandates: [{ id: 1, payee: { type: "near", account_id: "vendor.testnet" } }],
  spends: [
    { id: 0, destination: { type: "near", account_id: "vendor.testnet" }, status: "paid" },
    { id: 1, destination: { type: "near", account_id: "vendor.testnet" }, status: "paid" },
  ],
};

async function run(args: string[], world: World = VENDOR_VAULT) {
  const { io, state } = testIo(process.cwd());
  const withFetch: CliIo = { ...io, payeeDeps: { fetch: chain(world) } };
  const code = await runCli(
    ["--network", "testnet", "--rpc", RPC, "payee", "check", ...args, "--archival-rpc", ARCHIVAL],
    withFetch,
  );
  return { code, out: state.out, err: state.err };
}

describe("probarion payee check", () => {
  it("blocks a lookalike of the vault's payee and prints every reason (snapshot)", async () => {
    const { code, out, err } = await run(["near:vend0r.testnet", "--vault", VAULT]);
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(out).toMatchInlineSnapshot(`
      "BLOCK: near:vend0r.testnet on testnet
        block lookalike           near:vend0r.testnet looks like near:vendor.testnet, the payee of mandate 1 (the same after reading rn as m, l as 1 and o as 0). Check every character with the payee through another channel before you sign.
        warn  first_payment       This vault has not paid near:vend0r.testnet before. Set approval_above to 0 on its mandate, so an approver signs each payment until you trust this payee.
        info  not_blocklisted     Not on Probarion's seed blocklist for testnet (2 entries; a seed list, not a reputation service).
        info  found               The account exists on NEAR testnet.
        info  no_contract         No contract code on NEAR testnet: a plain account.
        info  older_than_7d       The account existed about 7 days ago (block 298992000).
        info  code_unchanged_7d   Its code is the same as about 7 days ago (block 298992000).
      Read-only at 2026-11-05T12:00:00.000Z: views and block headers, nothing signed or sent.
      The verdict is advice for the owner who writes this payee into a mandate. It changes nothing on chain.
      "
    `);
  });

  it("allows the vault's own payee that it paid before (exit 0)", async () => {
    const { code, out } = await run(["vendor.testnet", "--vault", VAULT]);
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toBe("ALLOW: near:vendor.testnet on testnet");
  });

  it("warns on a new account with no past payment (exit 2)", async () => {
    const { code, out } = await run(["near:fresh.testnet", "--vault", VAULT]);
    expect(code).toBe(2);
    expect(out).toContain(
      "  warn  first_payment       This vault has not paid near:fresh.testnet before.",
    );
    expect(out).toContain("  warn  new_7d              The account did not exist about 7 days ago");
  });

  it("blocks a named account that does not exist, and names the blocklist evidence", async () => {
    expect((await run(["near:nobody-here.testnet"])).code).toBe(1);
    const listed = await run(["near:attacker-eval.testnet"], {
      now: ["attacker-eval.testnet"],
      weekAgo: ["attacker-eval.testnet"],
    });
    expect(listed.code).toBe(1);
    expect(listed.out).toContain(
      "evidence: https://github.com/probarion/probarion/blob/main/eval/cases.json",
    );
  });

  it("prints the assessment and its signals as JSON", async () => {
    const { code, out } = await run(["near:vendor.testnet", "--vault", VAULT, "--json"]);
    expect(code).toBe(0);
    const json = JSON.parse(out) as Record<string, unknown> & { signals: Record<string, unknown> };
    expect(Object.keys(json)).toEqual([
      "verdict",
      "reasons",
      "network",
      "payee",
      "checked_at",
      "signals",
    ]);
    expect(json.verdict).toBe("allow");
    expect(json.checked_at).toBe("2026-11-05T12:00:00.000Z");
    expect(json.signals.known_payees).toEqual([
      { payee: { chain: "near", address: "vendor.testnet" }, paid: 2, mandates: [1] },
    ]);
  });

  it("warns, never allows, when the chain cannot be read", async () => {
    const { io, state } = testIo(process.cwd());
    const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const code = await runCli(
      ["--rpc", RPC, "payee", "check", "near:vendor.testnet", "--archival-rpc", ARCHIVAL],
      { ...io, payeeDeps: { fetch: down } },
    );
    expect(code).toBe(2);
    expect(state.out).toContain(
      "  warn  exists_unknown      Could not read whether vendor.testnet exists",
    );
  });

  it("warns without a vault, since lookalikes and past payments were not checked (exit 2)", async () => {
    const { code, out } = await run(["near:vendor.testnet"]);
    expect(code).toBe(2);
    expect(out.split("\n").slice(0, 2)).toEqual([
      "WARN: near:vendor.testnet on testnet",
      "  warn  history_not_checked No vault given: lookalikes of its payees and past payments were not checked, so this may be a first payment.",
    ]);
  });

  it("takes the vault from PROBARION_VAULT_ID when --vault is not given", async () => {
    const { io, state } = testIo(process.cwd(), { PROBARION_VAULT_ID: VAULT });
    const code = await runCli(
      [
        "--network",
        "testnet",
        "--rpc",
        RPC,
        "payee",
        "check",
        "near:vendor.testnet",
        "--archival-rpc",
        ARCHIVAL,
      ],
      { ...io, payeeDeps: { fetch: chain(VENDOR_VAULT) } },
    );
    expect(code).toBe(0);
    expect(state.out).toContain(
      "  info  paid_before         This vault paid near:vendor.testnet 2 times before.",
    );
  });

  it("exits 1 with an error, never a verdict, when the check itself cannot run", async () => {
    const { io, state } = testIo(process.cwd());
    const broken: CliIo = {
      ...io,
      now: () => {
        throw new Error("no clock");
      },
      payeeDeps: { fetch: chain(VENDOR_VAULT) },
    };
    const code = await runCli(
      ["--rpc", RPC, "payee", "check", "near:vendor.testnet", "--archival-rpc", ARCHIVAL],
      broken,
    );
    expect(code).toBe(1);
    expect(state.out).toBe("");
    expect(state.err).toBe("error: payee check could not run: no clock\n");
  });

  it("exits 64 on a malformed payee, vault or URL list, before any read", async () => {
    for (const args of [
      ["0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27"],
      ["base:0x123"],
      ["tron:abc"],
      ["near:vendor.testnet", "--vault", "Not A Vault"],
      ["near:vendor.testnet", "--base-rpc", " , "],
    ]) {
      const { io, state } = testIo(process.cwd());
      let reads = 0;
      const counting = (async () => {
        reads += 1;
        return new Response("{}");
      }) as typeof fetch;
      const code = await runCli(["payee", "check", ...args], {
        ...io,
        payeeDeps: { fetch: counting },
      });
      expect(code, args.join(" ")).toBe(64);
      expect(reads, args.join(" ")).toBe(0);
      expect(state.err, args.join(" ")).toMatch(/^error: /);
    }
  });

  it("lists its exit codes in --help", async () => {
    const { io, state } = testIo(process.cwd());
    expect(await runCli(["payee", "check", "--help"], io)).toBe(0);
    expect(state.out).toContain("Usage: probarion payee check [options] <payee>");
    expect(state.out).toContain(
      "  2   warn: confirm something with the payee first, or a signal could not be read",
    );
  });
});
