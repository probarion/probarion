// Tests for scripts/smoke-live.mjs: its rules and a whole run against a fake fetch and a fake exec, so nothing here
// reaches the network or spawns npx. The live script itself is run by hand (docs/ops/judging-days.md).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  allowanceVerdict,
  CANARY_MIN_LEDGER_ALLOWANCE,
  checkSpendVerdict,
  DEFAULT_UNTIL,
  expiryVerdict,
  healthVerdict,
  MAINNET_MANDATE_1,
  MCP_DEMO_ARGS,
  mainnetMandateVerdict,
  nearText,
  PAGES,
  parseArgs,
  ROWS,
  rpcVerdict,
  runSmoke,
  SAMPLES,
  siteOrigin,
  teeVerdict,
  usdcText,
  VAULTS,
  VERIFY_ARGS,
} from "./smoke-live.mjs";

const MAIN = "18cdf04aa086750b7ed2f12d72b9c76b822b25cc";
const NOW = Date.parse("2026-11-14T03:00:00Z");
const ns = (day) => `${BigInt(Date.parse(`${day}T00:00:00Z`)) * 1_000_000n}`;
const NEAR = (n) => `${BigInt(Math.round(n * 10_000)) * 10n ** 20n}`;

const mandate = (id, over = {}) => ({
  id,
  status: "active",
  uses: 0,
  max_uses: 5,
  max_per_payment: "5000000",
  payee: { type: "near", account_id: "probarion-payee.testnet" },
  expires_at_ns: ns("2026-12-01"),
  agent_pk: `ed25519:agent-${id}`,
  ...over,
});

const MAINNET_M1 = mandate(1, {
  uses: 1,
  max_uses: 2,
  max_per_payment: "1000000",
  payee: { type: "near", account_id: "probarion-duong.near" },
  expires_at_ns: ns("2027-01-31"),
});

const key = (pk, method, allowance) => ({
  public_key: pk,
  access_key: {
    permission: { FunctionCall: { allowance, method_names: [method], receiver_id: "v" } },
  },
});

/** The chain as the fake RPC answers it, keyed by account. */
function chain() {
  return {
    mandates: {
      "v0.probarion.near": [
        MAINNET_M1,
        mandate(2, { status: "exhausted", expires_at_ns: ns("2026-11-20") }),
      ],
      "v0.probarion.testnet": [mandate(1, { uses: 1 }), mandate(2, { uses: 1 })],
      "demo.vaults.probarion.testnet": [mandate(1, { status: "exhausted", uses: 5 })],
      "canary.vaults.probarion.testnet": [mandate(1, { expires_at_ns: ns("2027-01-31") })],
      "percall.vaults.probarion.testnet": [mandate(1, { status: "exhausted" })],
    },
    keys: {
      "v0.probarion.near": [
        key("ed25519:A", "anchor", NEAR(0.2491)),
        key("ed25519:S", "spend", NEAR(0.2462)),
      ],
      "demo.vaults.probarion.testnet": [
        key("ed25519:S", "spend", NEAR(0.99)),
        key("ed25519:L", "anchor", NEAR(0.24)),
      ],
      "canary.vaults.probarion.testnet": [
        key("ed25519:S", "spend", NEAR(2.9)),
        key("ed25519:L", "anchor", NEAR(1.9)),
      ],
      "percall.vaults.probarion.testnet": [
        key("ed25519:S", "spend", NEAR(0.98)),
        key("ed25519:L", "anchor", NEAR(0.24)),
      ],
    },
    usdc: "2000000",
    frozen: false,
  };
}

/** The views the script may call: every one is a read. */
const VIEW_METHODS = ["get_mandate", "check_spend", "list_mandates", "ft_balance_of", "get_config"];

function view(world, account, method, args) {
  assert.ok(
    VIEW_METHODS.includes(method),
    `the script called ${method}, which is not a view it may call`,
  );
  if (method === "list_mandates") return world.chain.mandates[account] ?? [];
  if (method === "get_mandate")
    return (world.chain.mandates[account] ?? []).find((m) => m.id === args.mandate_id) ?? null;
  if (method === "ft_balance_of") return world.chain.usdc;
  if (method === "get_config") return { frozen: world.chain.frozen };
  const m = world.chain.mandates[account].find((x) => x.id === args.request.mandate_id);
  assert.equal(args.signer_pk, m.agent_pk, "check_spend is asked with the mandate's own agent key");
  return BigInt(args.request.amount) <= BigInt(m.max_per_payment)
    ? { ok: true, code: null, would_hold: false }
    : { ok: false, code: "OverPerPayment", would_hold: false };
}

const SERVED = {
  "ledger.jsonl": '{"seq":0}\n',
  "mainnet-proof.json": "{}\n",
  "evidence/v0-decision-m001.json": "{}\n",
};

/** A fake world: the site, GitHub, the RPCs, and what the fake exec answers. Each test changes what it needs. */
function makeWorld() {
  const world = {
    chain: chain(),
    health: { ok: true, service: "probarion-web", network: "testnet", commit: MAIN.slice(0, 12) },
    main: MAIN,
    samples: true,
    /** Whether the deployed commit holds the samples on GitHub, or the HTTP status GitHub answers. */
    rawHasSamples: true,
    canary: '<main><textarea maxLength="4000"></textarea></main>',
    tee: null,
    nearaiOk: true,
    rpcBusy: new Set(),
    /** An RPC error cause per account, answered by every host. */
    rpcErrors: {},
    /** What the fake exec answers for the verify and the MCP demo, in place of a pass. */
    verifyAnswer: null,
    demoAnswer: null,
    siteRpcUp: [true],
    calls: [],
    execs: [],
    verifyChecks: {
      a: "pass",
      b: "pass",
      c: "pass",
      d: "pass",
      e: "pass",
      f: "pass",
      g: "pass",
      h: "pass",
      i: "skip",
    },
  };
  world.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    world.calls.push({ url, method, body: init.body });
    const u = new URL(url);
    if (method === "POST") {
      if (world.rpcBusy.has(u.host)) return new Response("busy", { status: 429 });
      const req = JSON.parse(init.body);
      const p = req.params;
      const cause = world.rpcErrors[p.account_id];
      if (cause) {
        return Response.json({
          jsonrpc: "2.0",
          id: req.id,
          error: { name: "HANDLER_ERROR", cause: { name: cause } },
        });
      }
      if (p.request_type === "view_access_key_list") {
        return Response.json({
          jsonrpc: "2.0",
          id: req.id,
          result: { keys: world.chain.keys[p.account_id] ?? [] },
        });
      }
      const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8"));
      const value = view(world, p.account_id, p.method_name, args);
      return Response.json({
        jsonrpc: "2.0",
        id: req.id,
        result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1 },
      });
    }
    if (u.host === "api.github.com")
      return new Response(world.main ?? "", { status: world.main ? 200 : 403 });
    if (u.host === "raw.githubusercontent.com") {
      const raw = world.rawHasSamples;
      return new Response("", { status: typeof raw === "number" ? raw : raw ? 200 : 404 });
    }
    if (u.pathname === "/api/health") return Response.json(world.health);
    if (u.pathname === "/api/health/nearai") {
      return Response.json(
        {
          name: "NEAR AI Cloud",
          ok: world.nearaiOk,
          detail: world.nearaiOk ? "12 model(s) listed, 3 with attestation" : "HTTP 503",
        },
        { status: world.nearaiOk ? 200 : 503 },
      );
    }
    if (u.pathname === "/api/health/rpc") {
      const n = Number(u.searchParams.get("provider"));
      const up = world.siteRpcUp[n];
      return Response.json(
        {
          name: `p${n}`,
          ok: up,
          detail: up ? "block 9, 1 s behind" : "HTTP 429",
          network: "testnet",
          provider: n,
          providers: world.siteRpcUp.length,
        },
        { status: up ? 200 : 503 },
      );
    }
    if (u.pathname === "/api/tee/check")
      return Response.json(world.tee(u.searchParams.get("nonce")));
    if (u.pathname === "/canary") return new Response(world.canary);
    if (u.pathname.startsWith("/samples/mainnet/")) {
      const file = u.pathname.slice("/samples/mainnet/".length);
      return world.samples
        ? new Response(SERVED[file])
        : new Response("not found", { status: 404 });
    }
    if (PAGES.includes(u.pathname)) return new Response("<html>Probarion</html>");
    return new Response("not found", { status: 404 });
  };
  world.exec = async (cmd, args, opts) => {
    world.execs.push({ cmd, args, opts });
    if (cmd === "git")
      return { code: 0, stdout: `${MAIN}\trefs/heads/main\n`, stderr: "", all: "" };
    if (args.includes("verify")) {
      for (const f of SAMPLES) assert.equal(readFileSync(join(opts.cwd, f), "utf8"), SERVED[f]);
      if (world.verifyAnswer) return world.verifyAnswer;
      const checks = Object.entries(world.verifyChecks).map(([id, status]) => ({
        id,
        status,
        detail: "",
      }));
      return {
        code: checks.some((c) => c.status === "fail") ? 1 : 0,
        stdout: JSON.stringify({ checks, entries: 6, anchors: 4 }),
        stderr: "",
        all: "",
      };
    }
    if (world.demoAnswer) return world.demoAnswer;
    const stdout =
      "  result: as expected\n  result: note. Mandate 1 has no uses left\nDone: 6 steps, 5 as expected, 1 note. Nothing was signed or sent.\n";
    return { code: 0, stdout, stderr: "", all: stdout };
  };
  return world;
}

async function run(world, argv = [], env = {}) {
  let out = "";
  let err = "";
  const code = await runSmoke(argv, {
    fetch: world.fetch,
    exec: world.exec,
    now: () => NOW,
    env: { PATH: "/usr/bin", ...env },
    platform: "linux",
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

const rowsOf = async (world, argv = []) => {
  const r = await run(world, [...argv, "--json"]);
  return { code: r.code, rows: Object.fromEntries(JSON.parse(r.out).rows.map((x) => [x.id, x])) };
};

describe("parseArgs", () => {
  test("defaults, flags and values", () => {
    assert.deepEqual(parseArgs([]), {
      site: "https://probarion.xyz",
      until: DEFAULT_UNTIL,
      tee: false,
      quick: false,
      json: false,
      help: false,
    });
    const f = parseArgs([
      "--tee",
      "--quick",
      "--json",
      "--site",
      "http://localhost:3010",
      "--until",
      "2026-11-18",
    ]);
    assert.equal(f.site, "http://localhost:3010");
    assert.equal(f.until, "2026-11-18");
    assert.ok(f.tee && f.quick && f.json);
  });

  test("refuses a bad site, a bad day and an unknown flag", () => {
    for (const argv of [
      ["--site", "http://probarion.xyz"],
      ["--site", "https://probarion.xyz/proof"],
      ["--site"],
      ["--until", "2026-11-31"],
      ["--until", "tomorrow"],
      ["--sign"],
    ]) {
      assert.ok("problem" in parseArgs(argv), argv.join(" "));
    }
    assert.equal(siteOrigin("https://probarion.vercel.app/"), "https://probarion.vercel.app");
  });

  test("a usage error exits 2 and --help exits 0, with no read", async () => {
    const world = makeWorld();
    assert.equal((await run(world, ["--nope"])).code, 2);
    assert.match((await run(world, ["--help"])).out, /^Usage: node scripts\/smoke-live\.mjs/);
    assert.equal(world.calls.length, 0);
  });
});

describe("units", () => {
  test("NEAR with 4 decimals and USDC with none trailing", () => {
    assert.equal(nearText("246219350238132600000000"), "0.2462");
    assert.equal(nearText(2n * 10n ** 24n), "2.0000");
    assert.equal(usdcText("1000000"), "1");
    assert.equal(usdcText("250000"), "0.25");
  });
});

describe("the rules", () => {
  test("health: main's head passes, another commit fails, an unread main warns", () => {
    const body = { ok: true, network: "testnet", commit: MAIN.slice(0, 12) };
    assert.equal(healthVerdict(200, body, MAIN).result, "PASS");
    const behind = healthVerdict(200, body, `ab${MAIN.slice(2)}`);
    assert.equal(behind.result, "FAIL");
    assert.match(behind.detail, /has not deployed yet/);
    assert.equal(healthVerdict(200, body, null).result, "WARN");
    assert.equal(healthVerdict(503, { ok: false, detail: "settings" }, MAIN).result, "FAIL");
    assert.equal(
      healthVerdict(200, { ok: true, network: "testnet", commit: null }, MAIN).result,
      "FAIL",
    );
  });

  test("check_spend: each answer must be the one shown", () => {
    const spec = {
      mandate: 1,
      cases: [
        { amount: "1000000", want: "ok" },
        { amount: "2000000", want: "OverPerPayment" },
      ],
    };
    const ok = { ok: true, code: null, would_hold: false };
    const over = { ok: false, code: "OverPerPayment", would_hold: false };
    assert.equal(checkSpendVerdict(spec, [ok, over]).result, "PASS");
    const frozen = { ok: false, code: "Frozen", would_hold: false };
    const v = checkSpendVerdict(spec, [frozen, frozen]);
    assert.equal(v.result, "FAIL");
    assert.match(v.detail, /1 USDC answered Frozen, not ok/);
  });

  test("allowances: 0.2 NEAR for every key, 0.5 NEAR for the Canary's ledger key, no full-access key", () => {
    const vault = VAULTS.find((v) => v.id === "v0.probarion.near");
    const canary = VAULTS.find((v) => v.id === "canary.vaults.probarion.testnet");
    assert.equal(canary.anchorMin, CANARY_MIN_LEDGER_ALLOWANCE);
    assert.equal(allowanceVerdict(vault, chain().keys["v0.probarion.near"]).result, "PASS");
    const low = allowanceVerdict(vault, [key("ed25519:S", "spend", NEAR(0.1999))]);
    assert.equal(low.result, "WARN");
    assert.match(low.detail, /the spend key has 0\.1999 NEAR, under 0\.2000/);
    const canaryKeys = (ledger) => [
      key("ed25519:S", "spend", NEAR(2)),
      key("ed25519:L", "anchor", NEAR(ledger)),
    ];
    // Under 0.5 NEAR the Canary has stopped: a FAIL, not a WARN.
    const stopped = allowanceVerdict(canary, canaryKeys(0.45));
    assert.equal(stopped.result, "FAIL");
    assert.match(
      stopped.detail,
      /anchor key has 0\.4500 NEAR, under 0\.5000: the Canary does not run/,
    );
    // Under twice that level it still runs: a WARN, so the key is replaced with a margin.
    const margin = allowanceVerdict(canary, canaryKeys(0.9));
    assert.equal(margin.result, "WARN");
    assert.match(
      margin.detail,
      /anchor key has 0\.9000 NEAR, under 1\.0000 \(2 times its 0\.5000 NEAR stop\)/,
    );
    assert.equal(allowanceVerdict(canary, canaryKeys(1)).result, "PASS");
    // Another vault's ledger key has the 0.2 NEAR line only.
    assert.equal(allowanceVerdict(vault, canaryKeys(0.45)).result, "PASS");
    assert.equal(allowanceVerdict(vault, [key("ed25519:L", "anchor", NEAR(1))]).result, "WARN");
    const full = allowanceVerdict(vault, [
      { public_key: "ed25519:F", access_key: { permission: "FullAccess" } },
    ]);
    assert.equal(full.result, "FAIL");
  });

  test("expiry: only active mandates count, and one before the cutoff warns", () => {
    const vault = VAULTS[1];
    const late = [
      {
        vault,
        mandates: [
          mandate(1),
          mandate(2, { status: "exhausted", expires_at_ns: ns("2026-11-15") }),
        ],
      },
    ];
    assert.equal(expiryVerdict(late, DEFAULT_UNTIL, NOW).result, "PASS");
    const soon = [{ vault, mandates: [mandate(1, { expires_at_ns: ns("2026-11-19") })] }];
    const v = expiryVerdict(soon, DEFAULT_UNTIL, NOW);
    assert.equal(v.result, "WARN");
    assert.match(
      v.detail,
      /mandate 1 expires 2026-11-19: before 2026-11-20\. After its expiry, a spend on it is refused with MandateExpired/,
    );
    const gone = [{ vault, mandates: [mandate(1, { expires_at_ns: ns("2026-11-10") })] }];
    assert.match(expiryVerdict(gone, DEFAULT_UNTIL, NOW).detail, /mandate 1 expired 2026-11-10/);
    assert.equal(expiryVerdict([{ vault, mandates: [] }], DEFAULT_UNTIL, NOW).result, "WARN");
  });

  test("mainnet mandate 1: the public copy's numbers, or a FAIL that says to update it", () => {
    const list = chain().mandates["v0.probarion.near"];
    assert.equal(mainnetMandateVerdict(list, "2000000", false).result, "PASS");
    const spent = mainnetMandateVerdict(
      [{ ...MAINNET_M1, uses: 2, status: "exhausted" }],
      "1000000",
      false,
    );
    assert.equal(spent.result, "FAIL");
    assert.match(spent.detail, /2 of its 2 payments are used, not 1 of 2/);
    const another = mainnetMandateVerdict([MAINNET_M1, mandate(4)], "2000000", false);
    assert.match(another.detail, /mandate 4 is active too/);
    assert.equal(mainnetMandateVerdict(list, "1500000", false).result, "WARN");
    assert.equal(mainnetMandateVerdict(list, "2000000", true).result, "WARN");
    assert.equal(MAINNET_MANDATE_1.payee, "probarion-duong.near");
  });

  test("TEE: 4 of 4 pass; unavailable warns; a fail, another nonce or an error fails; 429 warns", () => {
    const n = "ab".repeat(32);
    const answer = (statuses) => ({
      nonce: n,
      model: "z-ai/glm-5.3-flash",
      elapsed_ms: 900,
      checks: ["nonce", "signer", "o1", "o2"].map((id, i) => ({
        id,
        status: statuses[i],
        detail: "x",
      })),
    });
    assert.equal(teeVerdict(200, answer(["pass", "pass", "pass", "pass"]), n).result, "PASS");
    assert.equal(
      teeVerdict(200, answer(["pass", "pass", "unavailable", "pass"]), n).result,
      "WARN",
    );
    assert.equal(teeVerdict(200, answer(["pass", "fail", "pass", "pass"]), n).result, "FAIL");
    assert.equal(
      teeVerdict(200, answer(["pass", "pass", "pass", "pass"]), "cd".repeat(32)).result,
      "FAIL",
    );
    assert.equal(teeVerdict(429, null, n).result, "WARN");
    assert.equal(teeVerdict(503, { title: "unavailable" }, n).result, "FAIL");
  });

  test("RPC: a 429 or an error from a host warns", () => {
    assert.equal(rpcVerdict([{ host: "a", status: 200 }]).result, "PASS");
    const busy = rpcVerdict([
      { host: "a", status: 429 },
      { host: "b", status: 200 },
    ]);
    assert.equal(busy.result, "WARN");
    assert.match(busy.detail, /a 0 ok, 1 HTTP 429; b 1 ok/);
  });

  test("the site's RPC providers: all up passes, one down warns, all down fails", async () => {
    for (const [up, want] of [
      [[true, true], "PASS"],
      [[false, true], "WARN"],
      [[false], "FAIL"],
    ]) {
      const world = makeWorld();
      world.siteRpcUp = up;
      const { rows } = await rowsOf(world, ["--quick"]);
      assert.equal(rows["site-rpc"].result, want, rows["site-rpc"].detail);
      const asked = world.calls.filter((c) => c.url.includes("/api/health/rpc"));
      assert.equal(asked.length, up.length, "one probe per provider the site names");
    }
  });
});

describe("a whole run against fakes", () => {
  test("everything holds: no FAIL and no WARN, the TEE row skipped, exit 0", async () => {
    const world = makeWorld();
    const { code, rows } = await rowsOf(world);
    assert.equal(code, 0);
    for (const row of ROWS) assert.ok(rows[row.id], `row ${row.id} printed`);
    for (const r of Object.values(rows)) {
      assert.equal(r.result, r.id === "tee-check" ? "SKIP" : "PASS", `${r.id}: ${r.detail}`);
    }
    assert.match(rows["check-spend-mainnet"].detail, /1 USDC ok; 2 USDC OverPerPayment/);
    assert.match(rows["check-spend-testnet"].detail, /2 USDC ok; 50 USDC OverPerPayment/);
    assert.ok(
      !world.calls.some((c) => c.url.includes("/api/tee/check")),
      "the TEE check takes from the rate limit all visitors share: not without --tee",
    );
  });

  test("it only reads: GETs, and RPC view queries", async () => {
    const world = makeWorld();
    world.tee = (nonce) => ({ nonce, model: "m", elapsed_ms: 1, checks: [] });
    await run(world, ["--tee"]);
    for (const c of world.calls) {
      if (c.method === "GET") continue;
      assert.equal(c.method, "POST");
      const { method, params } = JSON.parse(c.body);
      assert.equal(method, "query");
      assert.ok(["call_function", "view_access_key_list"].includes(params.request_type));
      assert.equal(params.finality, "final");
    }
    const source = readFileSync(new URL("./smoke-live.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /broadcast_tx|send_tx|signAndSend|signTransaction|keys\.json"|\.near-credentials/,
    );
  });

  test("the npx runs: the README's commands, no secret in their environment, an empty home for the demo", async () => {
    const world = makeWorld();
    await run(world, [], {
      PROBARION_AGENT_KEY: "ed25519:secret",
      NEARAI_API_KEY: "sk",
      HOME: "/home/me",
    });
    const verify = world.execs.find((e) => e.args.includes("verify"));
    const demo = world.execs.find((e) => e.args.includes("demo"));
    assert.deepEqual([verify.cmd, ...verify.args], ["npx", ...VERIFY_ARGS]);
    assert.deepEqual([demo.cmd, ...demo.args], ["npx", ...MCP_DEMO_ARGS]);
    for (const e of world.execs) {
      assert.equal(e.opts.env.PROBARION_AGENT_KEY, undefined);
      assert.equal(e.opts.env.NEARAI_API_KEY, undefined);
    }
    assert.equal(demo.opts.env.HOME, demo.opts.cwd);
    assert.equal(demo.opts.env.USERPROFILE, demo.opts.cwd);
    assert.ok(!existsSync(demo.opts.cwd), "the temp folder is removed after the run");
  });

  test("--quick skips the two npx rows and runs nothing", async () => {
    const world = makeWorld();
    const { code, rows } = await rowsOf(world, ["--quick"]);
    assert.equal(code, 0);
    assert.equal(rows["samples-verify"].result, "SKIP");
    assert.equal(rows["mcp-demo"].result, "SKIP");
    assert.ok(!world.execs.some((e) => e.cmd === "npx"));
  });

  test("samples not served while the deployed commit lacks them: WARN, said to be expected", async () => {
    const world = makeWorld();
    world.samples = false;
    world.rawHasSamples = false;
    const { code, rows } = await rowsOf(world);
    assert.equal(code, 0);
    assert.equal(rows["samples-verify"].result, "WARN");
    assert.match(
      rows["samples-verify"].detail,
      /not deployed yet, as expected: .* has no apps\/web\/public\/samples\/mainnet\/ledger\.jsonl/,
    );
  });

  test("samples not served although the deployed commit holds them: FAIL", async () => {
    const world = makeWorld();
    world.samples = false;
    const { code, rows } = await rowsOf(world);
    assert.equal(code, 1);
    assert.equal(rows["samples-verify"].result, "FAIL");
  });

  test("samples not served and /api/health names no commit: FAIL, nothing to compare with", async () => {
    const world = makeWorld();
    world.samples = false;
    world.health = { ...world.health, commit: null };
    const { code, rows } = await rowsOf(world);
    assert.equal(code, 1);
    assert.equal(rows["samples-verify"].result, "FAIL");
    assert.match(rows["samples-verify"].detail, /named no deployed commit to compare with/);
    assert.ok(!world.calls.some((c) => c.url.includes("raw.githubusercontent.com")));
  });

  test("samples not served and GitHub answers 503 for the deployed commit's copy: WARN, re-run", async () => {
    const world = makeWorld();
    world.samples = false;
    world.rawHasSamples = 503;
    const { code, rows } = await rowsOf(world);
    assert.equal(code, 0);
    assert.equal(rows["samples-verify"].result, "WARN");
    assert.match(
      rows["samples-verify"].detail,
      /GitHub answered 503 .* could not tell .* re-run it/,
    );
  });

  test("a verify that fails check c or d says the served ledger may be stale", async () => {
    for (const check of ["c", "d"]) {
      const world = makeWorld();
      world.verifyChecks[check] = "fail";
      const { code, rows } = await rowsOf(world);
      assert.equal(code, 1);
      assert.match(
        rows["samples-verify"].detail,
        new RegExp(
          `check ${check} is fail, expected pass.*refresh apps/web/public/samples/mainnet`,
        ),
      );
    }
    const world = makeWorld();
    world.verifyChecks.f = "fail";
    const { rows } = await rowsOf(world);
    assert.equal(rows["samples-verify"].result, "FAIL");
    assert.doesNotMatch(rows["samples-verify"].detail, /refresh/);
  });

  test("the verify and the MCP demo fail on the network: WARN, re-run, not FAIL", async () => {
    const failed = {
      code: 1,
      stdout: "",
      stderr: "TypeError: fetch failed",
      all: "TypeError: fetch failed",
    };
    for (const over of [failed, { ...failed, stderr: "", all: "", timedOut: true }]) {
      const world = makeWorld();
      world.verifyAnswer = over;
      world.demoAnswer = over;
      const { code, rows } = await rowsOf(world);
      assert.equal(code, 0);
      assert.equal(rows["samples-verify"].result, "WARN", rows["samples-verify"].detail);
      assert.match(rows["samples-verify"].detail, /the network failed, so re-run it/);
      assert.equal(rows["mcp-demo"].result, "WARN", rows["mcp-demo"].detail);
      assert.match(rows["mcp-demo"].detail, /the network failed.*re-run it/);
    }
  });

  test("a deploy behind main fails the health row and the run", async () => {
    const world = makeWorld();
    world.health = { ...world.health, commit: "0123456789ab" };
    const { code, rows } = await rowsOf(world);
    assert.equal(code, 1);
    assert.equal(rows.health.result, "FAIL");
  });

  test("GitHub's API refused: main's head comes from git ls-remote", async () => {
    const world = makeWorld();
    world.main = null;
    const { rows } = await rowsOf(world, ["--quick"]);
    assert.equal(rows.health.result, "PASS");
    assert.ok(world.execs.some((e) => e.cmd === "git" && e.args[0] === "ls-remote"));
  });

  test("FastNEAR answers 429: the other host answers, and the RPC row warns", async () => {
    const world = makeWorld();
    world.rpcBusy.add("rpc.mainnet.fastnear.com");
    const { code, rows } = await rowsOf(world, ["--quick"]);
    assert.equal(code, 0);
    assert.equal(rows["check-spend-mainnet"].result, "PASS");
    assert.equal(rows.rpc.result, "WARN");
    assert.match(rows.rpc.detail, /rpc\.mainnet\.fastnear\.com 0 ok, \d+ HTTP 429/);
  });

  test("no RPC host answers: the chain rows warn (re-run), they do not fail", async () => {
    const world = makeWorld();
    world.rpcBusy.add("rpc.mainnet.fastnear.com");
    world.rpcBusy.add("rpc.mainnet.near.org");
    const { rows } = await rowsOf(world, ["--quick"]);
    assert.equal(rows["check-spend-mainnet"].result, "WARN");
    assert.match(rows["check-spend-mainnet"].detail, /could not be read this time/);
  });

  test("a paused Canary and a frozen mainnet vault", async () => {
    const world = makeWorld();
    world.canary = "<p>The live Canary is paused.</p>";
    world.chain.frozen = true;
    const { rows } = await rowsOf(world, ["--quick"]);
    assert.equal(rows["canary-page"].result, "WARN");
    assert.match(rows["canary-page"].detail, /a CANARY_MODE setting/);
    assert.equal(rows["mainnet-mandate-1"].result, "WARN");
  });

  test("a Canary that stopped itself, or shows no form, fails", async () => {
    for (const page of [
      "<p>The live Canary is not open yet.</p>",
      "<p>The live Canary is closed: its ledger is full.</p>",
      "<main><p>Recorded attacks</p></main>",
    ]) {
      const world = makeWorld();
      world.canary = page;
      const { code, rows } = await rowsOf(world, ["--quick"]);
      assert.equal(code, 1, page);
      assert.equal(rows["canary-page"].result, "FAIL", page);
    }
  });

  test("/api/health/nearai not ok: FAIL", async () => {
    const world = makeWorld();
    world.nearaiOk = false;
    const { code, rows } = await rowsOf(world, ["--quick"]);
    assert.equal(code, 1);
    assert.equal(rows.nearai.result, "FAIL");
    assert.match(rows.nearai.detail, /answered 503 HTTP 503: the Canary and Payables fail/);
  });

  test("the chain's own answer about an account fails the row; a host's error warns", async () => {
    const world = makeWorld();
    world.rpcErrors["percall.vaults.probarion.testnet"] = "UNKNOWN_ACCOUNT";
    const { code, rows } = await rowsOf(world, ["--quick"]);
    assert.equal(code, 1);
    assert.equal(rows["allowance-percall.vaults.probarion.testnet"].result, "FAIL");
    assert.match(rows["allowance-percall.vaults.probarion.testnet"].detail, /UNKNOWN_ACCOUNT/);
    assert.equal(rows["mandate-expiry"].result, "FAIL");
    const busy = makeWorld();
    busy.rpcErrors["percall.vaults.probarion.testnet"] = "TIMEOUT_ERROR";
    const again = await rowsOf(busy, ["--quick"]);
    assert.equal(again.code, 0);
    assert.equal(again.rows["allowance-percall.vaults.probarion.testnet"].result, "WARN");
    assert.match(
      again.rows["allowance-percall.vaults.probarion.testnet"].detail,
      /could not be read/,
    );
  });

  test("--tee asks once, with a fresh 64-hex nonce", async () => {
    const world = makeWorld();
    world.tee = (nonce) => ({
      nonce,
      model: "z-ai/glm-5.3-flash",
      elapsed_ms: 1200,
      checks: ["nonce", "signer", "o1", "o2"].map((id) => ({ id, status: "pass", detail: "" })),
    });
    const { rows } = await rowsOf(world, ["--quick", "--tee"]);
    const asked = world.calls.filter((c) => c.url.includes("/api/tee/check"));
    assert.equal(asked.length, 1);
    assert.match(new URL(asked[0].url).searchParams.get("nonce"), /^[0-9a-f]{64}$/);
    assert.equal(rows["tee-check"].result, "PASS");
  });
});
