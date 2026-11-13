#!/usr/bin/env node
// smoke-live: does the live site still answer the way the README and the landing say? One read-only command, for
// the days between the freeze and the end of judging. docs/ops/judging-days.md gives the run schedule and the checks
// only the owner can do (the NEAR AI credit, the Vercel and Supabase usage).
//
// It reads probarion.xyz, GitHub, npm and both NEAR networks and prints one row per check:
//
//   PASS   it holds
//   WARN   look at it today: it still works but will not for long, or it could not be read this time (re-run it)
//   FAIL   a judge would see it broken, or a public sentence about it no longer holds
//   SKIP   not run, with the flag that runs it
//
//   node scripts/smoke-live.mjs                  every row but the TEE check
//   node scripts/smoke-live.mjs --tee            also asks /api/tee/check once, from the rate limit all visitors share
//   node scripts/smoke-live.mjs --quick          without the two npx rows (no npm download)
//   node scripts/smoke-live.mjs --site <origin>  another address of the same deployment
//   node scripts/smoke-live.mjs --until <day>    warn on an active mandate that expires before this UTC day
//   node scripts/smoke-live.mjs --json           the rows as JSON on stdout, the table on stderr
//
// Read-only. It needs no key and signs and sends nothing: HTTP GETs, NEAR RPC view queries (call_function and
// view_access_key_list), and two npx runs of the published packages, each in an empty temp folder, with an empty
// home for the MCP demo and no variable whose name looks like a secret (judge.mjs's childEnv). It is not part of
// any test run: scripts/smoke-live.test.mjs checks its rules with a fake fetch and a fake exec.
// Exit codes: 0 no row failed, 1 a row failed, 2 usage error.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_PASS,
  childEnv,
  execCommand,
  locate,
  looksLikeNetworkError,
  matchVerify,
  mcpDemoOutcome,
} from "./judge.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RESULTS = ["PASS", "WARN", "FAIL", "SKIP"];

const SITE = "https://probarion.xyz";
const REPO = "probarion/probarion";
const UA = "probarion-smoke-live";
/** The day before which an active mandate's expiry is a warning: past the last judging day. */
export const DEFAULT_UNTIL = "2026-11-20";

export const RPC = {
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
  testnet: ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"],
};
const HTTP_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 10_000;
const TEE_TIMEOUT_MS = 40_000;
const VERIFY_TIMEOUT_MS = 5 * 60_000;
const DEMO_TIMEOUT_MS = 8 * 60_000;

const NEAR = 10n ** 24n;
/** The watcher's `allowance_low` line (docs/ops/watcher.md), and the Canary's raw-mode stop for its agent key. */
export const MIN_ALLOWANCE = 2n * 10n ** 23n;
/** Below this the Canary does not run at all: its ledger key's level (apps/web/src/lib/canary/limits.ts). */
export const CANARY_MIN_LEDGER_ALLOWANCE = 5n * 10n ** 23n;
/** A key with an `anchorMin` warns under this many times that level: the RUNBOOK keeps a margin above it. */
export const ANCHOR_MARGIN = 2n;

/** The vaults the site, the README and the demos lean on. `keys`: its agent and ledger keys pay gas for them. */
export const VAULTS = [
  { net: "mainnet", id: "v0.probarion.near", role: "the mainnet vault", keys: true },
  { net: "testnet", id: "v0.probarion.testnet", role: "the landing's live check", keys: false },
  {
    net: "testnet",
    id: "demo.vaults.probarion.testnet",
    role: "the demo vault of /proof and the MCP demo",
    keys: true,
  },
  {
    net: "testnet",
    id: "canary.vaults.probarion.testnet",
    role: "the Canary",
    keys: true,
    anchorMin: CANARY_MIN_LEDGER_ALLOWANCE,
  },
  { net: "testnet", id: "percall.vaults.probarion.testnet", role: "the 402 example", keys: true },
];

/**
 * What README.md's mainnet runs and JUDGES.md's "Worst case, priced" say of mainnet mandate 1 after the runs of
 * 2026-11-13: it pays probarion-duong.near at most 1 USDC a payment, 1 of its 2 payments is used, the other mandates
 * are exhausted (so the worst case is 1 USDC plus gas), and the vault holds 2 USDC. A new mainnet spend changes
 * these, and the public copy with them, in the same pull request.
 */
export const MAINNET_MANDATE_1 = {
  vault: "v0.probarion.near",
  id: 1,
  payee: "probarion-duong.near",
  maxPerPayment: "1000000",
  uses: 1,
  maxUses: 2,
  vaultUsdc: "2000000",
};
/** USDC on NEAR mainnet (contracts/deployments/mainnet.json `constants.usdc`). */
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/**
 * Two dry runs per vault, asked of `check_spend` with the mandate's own agent key: an amount the mandate allows, and
 * one over its per-payment cap. The testnet pair is the landing's live check (apps/web/src/lib/site/live-check.ts);
 * the mainnet pair is mandate 1's 1 USDC cap (README.md's mainnet runs).
 */
export const CHECK_SPEND = [
  {
    id: "check-spend-mainnet",
    net: "mainnet",
    vault: "v0.probarion.near",
    mandate: 1,
    cases: [
      { amount: "1000000", want: "ok" },
      { amount: "2000000", want: "OverPerPayment" },
    ],
  },
  {
    id: "check-spend-testnet",
    net: "testnet",
    vault: "v0.probarion.testnet",
    mandate: 1,
    cases: [
      { amount: "2000000", want: "ok" },
      { amount: "50000000", want: "OverPerPayment" },
    ],
  },
];

/** The served copies of the mainnet ledger and the files verify reads beside it (apps/web/public/samples/mainnet). */
export const SAMPLES = ["ledger.jsonl", "mainnet-proof.json", "evidence/v0-decision-m001.json"];
const SAMPLES_DIR = "apps/web/public/samples/mainnet";
/**
 * The no-clone mainnet verify of .github/workflows/no-clone-verify.yml and its record
 * (docs/evidence/mainnet-v0/no-clone-verify-2026-11-14.txt), with --json added so the row can read each check.
 */
export const VERIFY_ARGS = [
  "-y",
  "probarion@0.1.1",
  "verify",
  "--network",
  "mainnet",
  "--vault",
  "v0.probarion.near",
  "--ledger",
  "ledger.jsonl",
  "--evidence",
  "evidence",
  "--proof",
  "mainnet-proof.json",
  "--json",
];
/** Checks a to h pass, i skips: no factory made the vault (judge.mjs LIVE_VAULTS.mainnetV0, without A8's invoices). */
export const VERIFY_EXPECT = { exit: 0, checks: { ...ALL_PASS, i: "skip" } };
export const MCP_DEMO_ARGS = ["-y", "@probarion/mcp@0.1.1", "demo"];

/** The pages a judge opens first, and the ledger file the MCP demo downloads. */
export const PAGES = [
  "/",
  "/proof",
  "/proof/demo.vaults.probarion.testnet",
  "/proof/demo.vaults.probarion.testnet/ledger.jsonl",
  "/status",
  "/docs",
  "/llms.txt",
];

/**
 * The banners /canary shows instead of its form (apps/web/src/lib/canary/copy.ts, `replay`). Paused and replay are
 * CANARY_MODE settings the OWNER chose (WARN). Not open and closed mean the Canary stopped itself: its settings, a
 * failed read, its ledger key under 0.5 NEAR, or a full ledger (FAIL).
 */
export const CANARY_BANNERS = [
  { text: "The live Canary is paused.", result: "WARN" },
  { text: "This is a replay of recorded attacks.", result: "WARN" },
  { text: "The live Canary is not open yet.", result: "FAIL" },
  { text: "The live Canary is closed", result: "FAIL" },
];

export const USAGE = `Usage: node scripts/smoke-live.mjs [--tee] [--quick] [--site <origin>] [--until <YYYY-MM-DD>] [--json]

Reads the live site, GitHub, npm and both NEAR networks, and prints one row per check: PASS, WARN (look at it
today, or re-run it), FAIL (a judge would see it broken) or SKIP. Read-only: it signs and sends nothing and
needs no key. docs/ops/judging-days.md says when to run it and what to do with each row.

  --tee            also ask the site's /api/tee/check once. The site sends NEAR AI no API key for it, so it
                   spends no NEAR AI credit, but it takes one of the 30 checks a minute all visitors share
  --quick          skip the two npx rows (the no-clone mainnet verify and the MCP demo)
  --site <origin>  check another address of the deployment (default ${SITE})
  --until <day>    warn on an active mandate that expires before this UTC day (default ${DEFAULT_UNTIL})
  --json           print the rows as JSON on stdout and the table on stderr

Exit codes: 0 no row failed, 1 a row failed, 2 usage error.
`;

const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/** An https origin, or an http one on a loopback host (a local `next start`); null for anything else. */
export function siteOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
  return scheme && bare ? url.origin : null;
}

/** The flags, or the usage problem. */
export function parseArgs(argv) {
  const flags = {
    site: SITE,
    until: DEFAULT_UNTIL,
    tee: false,
    quick: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tee") flags.tee = true;
    else if (a === "--quick") flags.quick = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--") continue;
    else if (a === "--site" || a === "--until") {
      const value = argv[i + 1];
      if (value === undefined) return { problem: `${a} needs a value` };
      i += 1;
      if (a === "--site") {
        const origin = siteOrigin(value);
        if (origin === null) {
          return {
            problem: `--site takes an origin such as ${SITE}, not ${JSON.stringify(value)}`,
          };
        }
        flags.site = origin;
      } else {
        if (!isDay(value))
          return { problem: `--until takes a day as YYYY-MM-DD, not ${JSON.stringify(value)}` };
        flags.until = value;
      }
    } else {
      return { problem: `unknown argument ${JSON.stringify(a)}` };
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Units and short forms

/** yoctoNEAR as NEAR with 4 decimals, rounded down ("0.2462"). */
export function nearText(yocto) {
  const y = BigInt(yocto);
  return `${y / NEAR}.${((y % NEAR) / 10n ** 20n).toString().padStart(4, "0")}`;
}

/** USDC base units (6 decimals) as a decimal with no trailing zeros ("1", "0.25"). */
export function usdcText(units) {
  const u = BigInt(units);
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? `${u / 1_000_000n}` : `${u / 1_000_000n}.${frac}`;
}

/** A nanosecond timestamp as its UTC day. */
export const dayOfNs = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 10);
const shortKey = (pk) => `${String(pk).slice(0, 16)}...`;
const message = (e) => (e instanceof Error ? e.message : String(e));
const oneLine = (text, max = 240) => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

// ---------------------------------------------------------------------------------------------
// Reading: HTTP GETs and NEAR view queries

/** An endpoint that did not answer, or answered too busy: the row could not be read this time (WARN). */
export class Unreachable extends Error {}

/** A GET: its status and body. A network error or a timeout is Unreachable. */
async function get(ctx, url, { timeoutMs = HTTP_TIMEOUT_MS, accept } = {}) {
  try {
    const res = await ctx.fetch(url, {
      headers: { "user-agent": UA, ...(accept ? { accept } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new Unreachable(`${url} did not answer: ${message(e)}`);
  }
}

const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** JSON-RPC causes that are the chain's answer about the target: another host would say the same. */
const CHAIN_CAUSES = new Set([
  "UNKNOWN_ACCOUNT",
  "NO_CONTRACT_CODE",
  "CONTRACT_EXECUTION_ERROR",
  "UNKNOWN_ACCESS_KEY",
]);

/**
 * A `query` at final finality on `net`, each host in turn: a host that does not answer, answers HTTP 429 or 5xx, or
 * answers an RPC error that is not the chain's own moves on to the next. Every answer is logged for the RPC row.
 */
async function rpc(ctx, net, params) {
  let last = "no host";
  for (const url of RPC[net]) {
    const host = new URL(url).host;
    let res;
    let body = null;
    try {
      res = await ctx.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "smoke-live",
          method: "query",
          params: { finality: "final", ...params },
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (res.ok) body = await res.json();
    } catch (e) {
      ctx.rpcLog.push({ host, status: "error" });
      last = `${host}: ${message(e)}`;
      continue;
    }
    ctx.rpcLog.push({ host, status: res.status });
    if (!res.ok) {
      last = `${host} answered HTTP ${res.status}`;
      continue;
    }
    if (body?.error) {
      const cause = body.error.cause?.name ?? body.error.name ?? "an error";
      if (CHAIN_CAUSES.has(cause)) throw new Error(`${params.account_id} on ${net}: ${cause}`);
      last = `${host} answered ${cause}`;
      continue;
    }
    if (body?.result === undefined) {
      last = `${host} answered no result`;
      continue;
    }
    return body.result;
  }
  throw new Unreachable(`no ${net} RPC answered (${last})`);
}

/** A contract view method's JSON answer. A contract error is the chain's answer, not a busy host. */
async function view(ctx, net, account, method, args) {
  const r = await rpc(ctx, net, {
    request_type: "call_function",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (typeof r.error === "string")
    throw new Error(`${account}.${method} on ${net}: ${oneLine(r.error)}`);
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

const listMandates = (ctx, v) =>
  view(ctx, v.net, v.id, "list_mandates", { from_index: 0, limit: 100 });

// ---------------------------------------------------------------------------------------------
// The rules, pure: each takes what was read and gives { result, detail }

/** Whether /api/health serves main's head. `main` is null when GitHub could not be read. */
export function healthVerdict(status, body, main) {
  if (status !== 200 || body?.ok !== true) {
    return {
      result: "FAIL",
      detail: `/api/health answered ${status} ${oneLine(JSON.stringify(body), 120)}`,
    };
  }
  const commit = body.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) {
    return { result: "FAIL", detail: `/api/health is ok on ${body.network} and names no commit` };
  }
  if (main === null) {
    return {
      result: "WARN",
      detail: `serves ${commit} on ${body.network}; main's head could not be read from GitHub, so re-run it`,
    };
  }
  if (main.startsWith(commit)) {
    return { result: "PASS", detail: `serves ${commit} on ${body.network}, the head of main` };
  }
  return {
    result: "FAIL",
    detail: `serves ${commit} on ${body.network}, and main is at ${main.slice(0, 12)}: the last promote has not deployed yet, or its deploy failed (the Vercel dashboard says which)`,
  };
}

/** Each `check_spend` answer against the one the landing and the README show. */
export function checkSpendVerdict(spec, answers) {
  const parts = [];
  const wrong = [];
  for (const [i, c] of spec.cases.entries()) {
    const v = answers[i];
    const got = v.ok ? "ok" : String(v.code).replace(/^PROBARION:/, "");
    parts.push(`${usdcText(c.amount)} USDC ${got}${v.would_hold ? " (would hold)" : ""}`);
    if (got !== c.want) wrong.push(`${usdcText(c.amount)} USDC answered ${got}, not ${c.want}`);
  }
  const what = `mandate ${spec.mandate} with its own agent key: ${parts.join("; ")}`;
  return wrong.length === 0
    ? { result: "PASS", detail: what }
    : { result: "FAIL", detail: `${what}. ${wrong.join("; ")}` };
}

/**
 * The gas allowance left on each function-call key of a vault. WARN when a key is under 0.2 NEAR, or under
 * ANCHOR_MARGIN times the vault's `anchorMin` for its ledger key, or the vault has no agent key. FAIL on a full-access
 * key, and on a ledger key under `anchorMin`: the Canary has stopped.
 */
export function allowanceVerdict(vault, keys) {
  const full = keys.filter((k) => k.access_key?.permission === "FullAccess");
  if (full.length > 0) {
    return { result: "FAIL", detail: `${vault.id} has a full-access key: ${full[0].public_key}` };
  }
  const parts = [];
  const stopped = [];
  const low = [];
  let agents = 0;
  for (const k of keys) {
    const fc = k.access_key?.permission?.FunctionCall;
    const method = fc?.method_names?.[0] ?? "?";
    if (method === "spend") agents += 1;
    const stop = method === "anchor" ? vault.anchorMin : undefined;
    const level = stop === undefined ? MIN_ALLOWANCE : stop * ANCHOR_MARGIN;
    if (fc?.allowance === null || fc?.allowance === undefined) {
      parts.push(`${method} key ${shortKey(k.public_key)} no limit`);
      continue;
    }
    const left = BigInt(fc.allowance);
    parts.push(`${method} key ${shortKey(k.public_key)} ${nearText(left)} NEAR`);
    const has = `the ${method} key has ${nearText(left)} NEAR`;
    if (stop !== undefined && left < stop) stopped.push(`${has}, under ${nearText(stop)}`);
    else if (left < level) {
      low.push(
        stop === undefined
          ? `${has}, under ${nearText(level)}`
          : `${has}, under ${nearText(level)} (${ANCHOR_MARGIN} times its ${nearText(stop)} NEAR stop)`,
      );
    }
  }
  const what = `${vault.role}: ${parts.join("; ") || "no keys"}`;
  if (stopped.length > 0) {
    return {
      result: "FAIL",
      detail: `${what}. ${stopped.join("; ")}: the Canary does not run, and /canary says it is not open yet. Replace the key (docs/RUNBOOK.md, Canary levels)`,
    };
  }
  if (low.length > 0) {
    return {
      result: "WARN",
      detail: `${what}. ${low.join("; ")}: replace it (docs/RUNBOOK.md, Agent key's allowance nearly used up)`,
    };
  }
  if (agents === 0)
    return { result: "WARN", detail: `${what}. No agent key: nothing can pay from it` };
  return { result: "PASS", detail: what };
}

/** Every active mandate's expiry against `until`. `byVault` pairs each vault with its mandate list. */
export function expiryVerdict(byVault, until, nowMs) {
  const cutoff = BigInt(Date.parse(`${until}T00:00:00Z`)) * 1_000_000n;
  const now = BigInt(nowMs) * 1_000_000n;
  const active = [];
  for (const { vault, mandates } of byVault) {
    for (const m of mandates) {
      if (m.status === "active") active.push({ vault: vault.id, m });
    }
  }
  if (active.length === 0) {
    return { result: "WARN", detail: `no active mandate on the ${byVault.length} vaults` };
  }
  const soon = active.filter((a) => BigInt(a.m.expires_at_ns) < cutoff);
  if (soon.length > 0) {
    const named = soon.map(
      (a) =>
        `${a.vault} mandate ${a.m.id} ${BigInt(a.m.expires_at_ns) < now ? "expired" : "expires"} ${dayOfNs(a.m.expires_at_ns)}`,
    );
    return {
      result: "WARN",
      detail: `${named.join("; ")}: before ${until}. After its expiry, a spend on it is refused with MandateExpired`,
    };
  }
  active.sort((a, b) => (BigInt(a.m.expires_at_ns) < BigInt(b.m.expires_at_ns) ? -1 : 1));
  const first = active[0];
  return {
    result: "PASS",
    detail: `${active.length} active mandates on the ${byVault.length} vaults, each expiring on or after ${until}; the first, ${first.vault} mandate ${first.m.id}, on ${dayOfNs(first.m.expires_at_ns)}`,
  };
}

/** Mainnet mandate 1 and the vault against what the public copy says (MAINNET_MANDATE_1). */
export function mainnetMandateVerdict(mandates, usdc, frozen, want = MAINNET_MANDATE_1) {
  const m = mandates.find((x) => x.id === want.id);
  if (m === undefined) return { result: "FAIL", detail: `${want.vault} has no mandate ${want.id}` };
  const diffs = [];
  if (m.status !== "active") diffs.push(`it is ${m.status}`);
  if (m.uses !== want.uses || m.max_uses !== want.maxUses) {
    diffs.push(
      `${m.uses} of its ${m.max_uses} payments are used, not ${want.uses} of ${want.maxUses}`,
    );
  }
  if (m.max_per_payment !== want.maxPerPayment) {
    diffs.push(
      `it allows ${usdcText(m.max_per_payment)} USDC a payment, not ${usdcText(want.maxPerPayment)}`,
    );
  }
  if (m.payee?.type !== "near" || m.payee.account_id !== want.payee) {
    diffs.push(`it pays ${JSON.stringify(m.payee)}, not ${want.payee}`);
  }
  const others = mandates.filter((x) => x.id !== want.id && x.status === "active").map((x) => x.id);
  if (others.length > 0) diffs.push(`mandate ${others.join(", ")} is active too`);
  if (diffs.length > 0) {
    return {
      result: "FAIL",
      detail: `mandate ${want.id}: ${diffs.join("; ")}. README.md and JUDGES.md (Worst case, priced) say it has 1 USDC and 1 payment left and the other mandates are exhausted: find what changed, then update the copy`,
    };
  }
  const what = `mandate ${want.id} is active: ${m.uses} of ${m.max_uses} payments used, at most ${usdcText(m.max_per_payment)} USDC a payment to ${want.payee}, expires ${dayOfNs(m.expires_at_ns)}; the only active mandate; the vault holds ${usdcText(usdc)} USDC`;
  if (frozen)
    return { result: "WARN", detail: `${what}; the vault is frozen, so every spend is refused` };
  if (usdc !== want.vaultUsdc) {
    return {
      result: "WARN",
      detail: `${what}, and the README says ${usdcText(want.vaultUsdc)} USDC after the last run`,
    };
  }
  return { result: "PASS", detail: `${what}; not frozen` };
}

/** /api/tee/check's answer for our nonce: 4 of 4 pass, or which did not. */
export function teeVerdict(status, body, nonce) {
  if (status === 429) {
    return {
      result: "WARN",
      detail: "rate limited: all visitors share one bucket, so try again in a minute",
    };
  }
  if (status !== 200 || !Array.isArray(body?.checks)) {
    return {
      result: "FAIL",
      detail: `/api/tee/check answered ${status} ${oneLine(JSON.stringify(body), 160)}`,
    };
  }
  if (body.nonce !== nonce)
    return { result: "FAIL", detail: "the answer is not for the nonce sent" };
  const ids = ["nonce", "signer", "o1", "o2"];
  const by = Object.fromEntries(body.checks.map((c) => [c.id, c]));
  const passed = ids.filter((id) => by[id]?.status === "pass");
  const failed = ids.filter((id) => by[id]?.status === "fail");
  const where = `${body.model ?? "no model"}, ${body.elapsed_ms} ms`;
  if (passed.length === 4) {
    return {
      result: "PASS",
      detail: `4 of 4 pass (nonce, signer, O1, O2) for ${where}; the TEE measurement is not pinned`,
    };
  }
  const rest = ids
    .filter((id) => !passed.includes(id))
    .map((id) => `${id} ${by[id]?.status ?? "missing"}: ${oneLine(by[id]?.detail, 100)}`);
  return {
    result: failed.length > 0 ? "FAIL" : "WARN",
    detail: `${passed.length} of 4 pass for ${where}; ${rest.join("; ")}`,
  };
}

/**
 * The site's own RPC probes, one answer per provider of its network (/api/health/rpc): WARN while one is down and
 * another answers (the readers fail over), FAIL when none does.
 */
export function siteRpcVerdict(answers) {
  const up = answers.filter((a) => a.status === 200 && a.body?.ok === true);
  const parts = answers.map(
    (a, i) =>
      `${a.body?.name ?? `provider ${i}`} ${a.body?.ok === true ? "ok" : "down"} (${a.body?.detail ?? `HTTP ${a.status}`})`,
  );
  const what = `${answers[0]?.body?.network ?? "its network"}: ${parts.join("; ")}`;
  if (up.length === answers.length) return { result: "PASS", detail: what };
  if (up.length > 0) {
    return {
      result: "WARN",
      detail: `${what}. The readers fail over to the next provider (docs/RUNBOOK.md, RPC failover)`,
    };
  }
  return {
    result: "FAIL",
    detail: `${what}. No provider answers, so the console and /proof cannot read the chain (docs/RUNBOOK.md, RPC failover, step 3)`,
  };
}

/** The RPC answers this run got: WARN when a host was busy or down, so the site's own reads may be too. */
export function rpcVerdict(log) {
  if (log.length === 0) return { result: "SKIP", detail: "this run made no RPC call" };
  const hosts = new Map();
  for (const { host, status } of log) {
    const h = hosts.get(host) ?? { ok: 0, busy: 0, other: 0 };
    if (status === 200) h.ok += 1;
    else if (status === 429) h.busy += 1;
    else h.other += 1;
    hosts.set(host, h);
  }
  const parts = [...hosts].map(
    ([host, h]) =>
      `${host} ${h.ok} ok${h.busy ? `, ${h.busy} HTTP 429` : ""}${h.other ? `, ${h.other} other` : ""}`,
  );
  const bad = [...hosts.values()].some((h) => h.busy > 0 || h.other > 0);
  return {
    result: bad ? "WARN" : "PASS",
    detail: `${log.length} answers: ${parts.join("; ")}${bad ? ". The site reads the same hosts: see docs/RUNBOOK.md, RPC failover" : ""}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The rows

/** main's head on GitHub, or null: the API first, then `git ls-remote` (both read-only). */
async function mainHead(ctx) {
  try {
    const r = await get(ctx, `https://api.github.com/repos/${REPO}/commits/main`, {
      accept: "application/vnd.github.sha",
    });
    if (r.status === 200 && /^[0-9a-f]{40}$/.test(r.text.trim())) return r.text.trim();
  } catch {
    // try git below
  }
  const r = await ctx.exec(
    "git",
    ["ls-remote", `https://github.com/${REPO}.git`, "refs/heads/main"],
    {
      cwd: ctx.tmp,
      env: ctx.env,
      timeoutMs: HTTP_TIMEOUT_MS,
    },
  );
  const sha = /^([0-9a-f]{40})\s/.exec(r.stdout ?? "")?.[1];
  return r.code === 0 && sha ? sha : null;
}

/** The npx command: npx.cmd on Windows runs only through cmd.exe. */
const npx = (ctx) => ({ cmd: "npx", shell: ctx.platform === "win32" });

async function samplesRow(ctx) {
  if (ctx.flags.quick) return { result: "SKIP", detail: "not run with --quick" };
  const base = `${ctx.site}/samples/mainnet`;
  const dir = join(ctx.tmp, "verify");
  for (const file of SAMPLES) {
    const got = await get(ctx, `${base}/${file}`);
    if (got.status === 404) return notServedYet(ctx, file);
    if (got.status !== 200)
      return { result: "FAIL", detail: `${base}/${file} answered HTTP ${got.status}` };
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), got.text);
  }
  const { cmd, shell } = npx(ctx);
  const r = await ctx.exec(cmd, VERIFY_ARGS, {
    cwd: dir,
    env: ctx.env,
    timeoutMs: VERIFY_TIMEOUT_MS,
    shell,
  });
  const out = String(r.stdout ?? "");
  const report = jsonOf(out) ?? jsonOf(out.slice(out.indexOf("{")));
  if (report === null && (r.timedOut || looksLikeNetworkError(r.all ?? r.stderr))) {
    return {
      result: "WARN",
      detail: `the network failed, so re-run it: ${oneLine(
        String(r.stderr ?? "")
          .trim()
          .split("\n")
          .pop(),
      )}`,
    };
  }
  const v = matchVerify(VERIFY_EXPECT, { code: r.code, report, stderr: r.stderr ?? "" });
  // A new mainnet anchor fails c on an older copy of the ledger, and a new spend fails d.
  const stale = v.result === "FAIL" && /check [cd] is fail/.test(v.detail);
  return {
    result: v.result,
    detail: `npx probarion@0.1.1 verify on ${base}: ${v.detail}${stale ? `. The served ledger may be older than the chain: refresh ${SAMPLES_DIR}` : ""}`,
  };
}

/**
 * A served sample answered 404. Before the promote that ships the samples deploys, that is expected (WARN); once the
 * deployed commit holds the file, it is a FAIL.
 */
async function notServedYet(ctx, file) {
  const url = `${ctx.site}/samples/mainnet/${file}`;
  if (ctx.deployed === null) {
    return {
      result: "FAIL",
      detail: `${url} answered 404, and /api/health named no deployed commit to compare with. Before the promote that ships ${SAMPLES_DIR} deploys, this 404 is expected`,
    };
  }
  const raw = await get(
    ctx,
    `https://raw.githubusercontent.com/${REPO}/${ctx.deployed}/${SAMPLES_DIR}/${file}`,
  );
  if (raw.status === 404) {
    return {
      result: "WARN",
      detail: `not deployed yet, as expected: ${url} answers 404 because the deployed commit ${ctx.deployed} has no ${SAMPLES_DIR}/${file}. Re-run after the promote that ships it deploys; then this row must PASS`,
    };
  }
  if (raw.status !== 200) {
    return {
      result: "WARN",
      detail: `${url} answers 404, and GitHub answered ${raw.status} for the deployed commit's copy, so it could not tell whether that commit ships it: re-run it`,
    };
  }
  return {
    result: "FAIL",
    detail: `${url} answers 404, yet the deployed commit ${ctx.deployed} holds ${SAMPLES_DIR}/${file} (GitHub answered ${raw.status})`,
  };
}

async function mcpDemoRow(ctx) {
  if (ctx.flags.quick) return { result: "SKIP", detail: "not run with --quick" };
  // The demo's MCP server loads ~/.probarion/<vault>/keys.json when it exists: give it an empty home.
  const home = join(ctx.tmp, "empty-home");
  mkdirSync(home, { recursive: true });
  const { HOMEDRIVE: _drive, HOMEPATH: _path, ...env } = ctx.env;
  const { cmd, shell } = npx(ctx);
  const r = await ctx.exec(cmd, MCP_DEMO_ARGS, {
    cwd: home,
    env: { ...env, HOME: home, USERPROFILE: home },
    timeoutMs: DEMO_TIMEOUT_MS,
    shell,
  });
  const o = mcpDemoOutcome(r, ctx.readmeLine("Give an AI agent the vault."));
  return o.result === "SKIPPED" ? { result: "WARN", detail: `${o.detail}; re-run it` } : o;
}

async function teeRow(ctx) {
  if (!ctx.flags.tee) {
    return {
      result: "SKIP",
      detail:
        "not run: it takes a place in the TEE check's rate limit, which all visitors share; run with --tee",
    };
  }
  const nonce = randomBytes(32).toString("hex");
  const got = await get(ctx, `${ctx.site}/api/tee/check?nonce=${nonce}`, {
    timeoutMs: TEE_TIMEOUT_MS,
  });
  return teeVerdict(got.status, jsonOf(got.text), nonce);
}

const ZERO_HASH = "0".repeat(64);

async function checkSpendRow(ctx, spec) {
  const m = await view(ctx, spec.net, spec.vault, "get_mandate", { mandate_id: spec.mandate });
  if (m === null) return { result: "FAIL", detail: `${spec.vault} has no mandate ${spec.mandate}` };
  const answers = [];
  for (const c of spec.cases) {
    answers.push(
      await view(ctx, spec.net, spec.vault, "check_spend", {
        request: {
          mandate_id: spec.mandate,
          amount: c.amount,
          invoice_hash: ZERO_HASH,
          ref: "smoke-live",
          decision_hash: ZERO_HASH,
        },
        signer_pk: m.agent_pk,
      }),
    );
  }
  return checkSpendVerdict(spec, answers);
}

async function mainnetMandateRow(ctx) {
  const v = VAULTS[0];
  const mandates = await listMandates(ctx, v);
  const usdc = await view(ctx, "mainnet", MAINNET_USDC, "ft_balance_of", { account_id: v.id });
  const config = await view(ctx, "mainnet", v.id, "get_config", {});
  return mainnetMandateVerdict(mandates, String(usdc), config.frozen === true);
}

async function allowanceRow(ctx, vault) {
  const r = await rpc(ctx, vault.net, {
    request_type: "view_access_key_list",
    account_id: vault.id,
  });
  return allowanceVerdict(vault, r.keys ?? []);
}

async function expiryRow(ctx) {
  const byVault = [];
  for (const vault of VAULTS) byVault.push({ vault, mandates: await listMandates(ctx, vault) });
  return expiryVerdict(byVault, ctx.flags.until, ctx.now());
}

async function pagesRow(ctx) {
  const bad = [];
  for (const path of PAGES) {
    const r = await get(ctx, `${ctx.site}${path}`);
    if (r.status !== 200) bad.push(`${path} answered ${r.status}`);
  }
  return bad.length === 0
    ? {
        result: "PASS",
        detail: `${PAGES.length} of ${PAGES.length} answer 200: ${PAGES.join(", ")}`,
      }
    : { result: "FAIL", detail: `${bad.join("; ")} (docs/RUNBOOK.md, App down)` };
}

async function canaryRow(ctx) {
  const r = await get(ctx, `${ctx.site}/canary`);
  if (r.status !== 200) return { result: "FAIL", detail: `/canary answered ${r.status}` };
  const banner = CANARY_BANNERS.find((b) => r.text.includes(b.text));
  if (banner !== undefined) {
    const why =
      banner.result === "WARN"
        ? "a CANARY_MODE setting"
        : "the Canary stopped itself; a failed read shows it for one view, so re-run it once";
    return {
      result: banner.result,
      detail: `/canary shows "${banner.text}" in place of its form: ${why} (docs/RUNBOOK.md, Canary levels)`,
    };
  }
  if (!r.text.includes("<textarea"))
    return { result: "FAIL", detail: "/canary shows no attempt form" };
  return {
    result: "PASS",
    detail: "/canary shows the live attempt form, with no paused or closed banner",
  };
}

async function nearaiRow(ctx) {
  const r = await get(ctx, `${ctx.site}/api/health/nearai`);
  const body = jsonOf(r.text);
  const note = "the public model list, read with no key: it does not show the NEAR AI credit";
  if (r.status === 200 && body?.ok === true)
    return { result: "PASS", detail: `${body.detail}; ${note}` };
  return {
    result: "FAIL",
    detail: `/api/health/nearai answered ${r.status} ${oneLine(body?.detail ?? r.text, 120)}: the Canary and Payables fail without NEAR AI Cloud, and the TEE card shows unavailable`,
  };
}

async function siteRpcRow(ctx) {
  const answers = [];
  for (let i = 0; i < (answers[0]?.body?.providers ?? 1) && i < 8; i++) {
    const r = await get(ctx, `${ctx.site}/api/health/rpc?provider=${i}`);
    answers.push({ status: r.status, body: jsonOf(r.text) });
  }
  return siteRpcVerdict(answers);
}

async function healthRow(ctx) {
  const r = await get(ctx, `${ctx.site}/api/health`);
  const body = jsonOf(r.text);
  if (r.status === 200 && typeof body?.commit === "string") ctx.deployed = body.commit;
  return healthVerdict(r.status, body, await mainHead(ctx));
}

/** Every row, in the order it prints. */
export const ROWS = [
  { id: "health", title: "/api/health is ok and serves the head of main", run: healthRow },
  { id: "pages", title: "the pages a judge opens first answer 200", run: pagesRow },
  {
    id: "samples-verify",
    title: "no-clone mainnet verify of the served samples: a to h pass, i skips",
    run: samplesRow,
  },
  {
    id: "mcp-demo",
    title: "npx -y @probarion/mcp@0.1.1 demo exits 0, nothing signed",
    run: mcpDemoRow,
  },
  { id: "tee-check", title: "/api/tee/check: 4 of 4 checks pass", run: teeRow },
  ...CHECK_SPEND.map((spec) => ({
    id: spec.id,
    title: `check_spend on ${spec.vault}: ${spec.cases.map((c) => `${usdcText(c.amount)} USDC ${c.want}`).join(", ")}`,
    run: (ctx) => checkSpendRow(ctx, spec),
  })),
  {
    id: "mainnet-mandate-1",
    title: "mainnet mandate 1: 1 of 2 payments used, the only active mandate",
    run: mainnetMandateRow,
  },
  ...VAULTS.filter((v) => v.keys).map((vault) => ({
    id: `allowance-${vault.id}`,
    title: `gas allowance of each key on ${vault.id}`,
    run: (ctx) => allowanceRow(ctx, vault),
  })),
  {
    id: "mandate-expiry",
    title: "no active mandate expires before the cutoff day",
    run: expiryRow,
  },
  {
    id: "canary-page",
    title: "/canary is open: its form, no paused or closed banner",
    run: canaryRow,
  },
  { id: "nearai", title: "/api/health/nearai reaches NEAR AI Cloud", run: nearaiRow },
  { id: "site-rpc", title: "/api/health/rpc: the site's RPC providers answer", run: siteRpcRow },
  {
    id: "rpc",
    title: "the RPC hosts this run read answered",
    run: (ctx) => rpcVerdict(ctx.rpcLog),
  },
];

// ---------------------------------------------------------------------------------------------
// Running

async function runRow(ctx, row) {
  const started = performance.now();
  let out;
  try {
    out = await row.run(ctx);
  } catch (e) {
    out =
      e instanceof Unreachable
        ? { result: "WARN", detail: `could not be read this time, so re-run it: ${e.message}` }
        : { result: "FAIL", detail: message(e) };
  }
  return { id: row.id, title: row.title, ...out, ms: Math.round(performance.now() - started) };
}

export const formatRow = (r) => `${r.result.padEnd(4)}  ${r.title}\n      ${r.detail}\n`;

export function countResults(rows) {
  return Object.fromEntries(RESULTS.map((s) => [s, rows.filter((r) => r.result === s).length]));
}

/**
 * The whole run: the rows in order, each printed as it ends. `deps` gives fetch, exec (judge.mjs execCommand's
 * shape), now, env, platform, out and err, so a test runs it with fakes.
 */
export async function runSmoke(argv, deps) {
  const flags = parseArgs(argv);
  if ("problem" in flags) {
    deps.err(`smoke-live: ${flags.problem}\n\n${USAGE}`);
    return 2;
  }
  if (flags.help) {
    deps.out(USAGE);
    return 0;
  }
  const show = flags.json ? deps.err : deps.out;
  const at = new Date(deps.now()).toISOString();
  const readme = (() => {
    try {
      return readFileSync(join(ROOT, "README.md"), "utf8");
    } catch {
      return null;
    }
  })();
  const ctx = {
    flags,
    site: flags.site,
    fetch: deps.fetch,
    exec: deps.exec,
    now: deps.now,
    env: childEnv(deps.env),
    platform: deps.platform,
    tmp: mkdtempSync(join(os.tmpdir(), "probarion-smoke-")),
    rpcLog: [],
    deployed: null,
    readmeLine: (quote) => locate(readme, quote),
  };
  show(`Probarion live smoke of ${flags.site}, ${at}. Read-only: it signs and sends nothing.\n\n`);
  const started = performance.now();
  const rows = [];
  try {
    for (const row of ROWS) {
      const r = await runRow(ctx, row);
      rows.push(r);
      show(formatRow(r));
    }
  } finally {
    try {
      rmSync(ctx.tmp, { recursive: true, force: true });
    } catch {
      // a file an npx child still holds on Windows; the folder is in the system temp folder
    }
  }
  const counts = countResults(rows);
  const code = counts.FAIL > 0 ? 1 : 0;
  const took = Math.round((performance.now() - started) / 1000);
  show(`\n${RESULTS.map((s) => `${counts[s]} ${s}`).join(", ")} in ${took} s. Exit ${code}.\n`);
  if (flags.json) {
    deps.out(
      `${JSON.stringify({ site: flags.site, at, until: flags.until, rows, counts, exit: code }, null, 2)}\n`,
    );
  }
  return code;
}

/** True when node runs this file (not when a test imports it). */
function isMain() {
  try {
    return relative(resolve(process.argv[1] ?? ""), fileURLToPath(import.meta.url)) === "";
  } catch {
    return false;
  }
}

if (isMain()) {
  runSmoke(process.argv.slice(2), {
    fetch: globalThis.fetch,
    exec: execCommand,
    now: Date.now,
    env: process.env,
    platform: process.platform,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`smoke-live: ${e instanceof Error ? e.stack : e}\n`);
      process.exitCode = 2;
    },
  );
}
