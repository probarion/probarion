// `probarion-mcp demo`: a read-only tour of the five tools against a live testnet vault. It starts this
// package's own server over stdio with no key in its environment, so the server runs read-only and can sign
// nothing; every step is a read, a dry run or a refusal. Each step says what it expects, then what came back.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { isNearAccountId } from "@probarion/core";
import { envValue } from "@probarion/sdk";
import { safeMessage, TOOL_NAMES } from "./server.js";
import { formatUsdc, parseUsdc } from "./units.js";

type Env = Readonly<Record<string, string | undefined>>;

export const DEMO_VAULT = "demo.vaults.probarion.testnet";

/** Where the public proof page serves a testnet vault's signed ledger. */
export const ledgerUrl = (vault: string): string =>
  `https://probarion.xyz/proof/${vault}/ledger.jsonl`;

/** The settings the demo passes on to its server. Neither key variable is among them, whatever is set. */
const PASSED_ON = ["NEAR_RPC_URLS", "NEAR_ARCHIVAL_RPC_URLS"] as const;

/** A field name that could carry a recipient. No tool input may have one (see test/safety.test.ts). */
const ADDRESS_LIKE =
  /(address|recipient|receiver|payee|destination|account|wallet|beneficiary|memo|chain|^to$)/i;

/** Refusals that come from the vault as a whole (or its key list), which list_mandates does not show. */
const VAULT_WIDE: Readonly<Record<string, string>> = {
  Frozen: "the vault's owner has frozen it, so the contract refuses every spend",
  OverDailyBackstop: "the vault's daily backstop is used up for today",
  NotAgent: "the mandate's agent key is no longer one of the vault's agent keys",
};

const SPEND_STATUS_LIMIT = 10;
const VERIFY_TIMEOUT_MS = 300_000;
const LEDGER_TIMEOUT_MS = 20_000;
const LEDGER_MAX_BYTES = 32 * 1024 * 1024;

export interface DemoIo {
  env: Env;
  /** The transcript. */
  out: Writable;
  /** Usage errors. */
  err: Writable;
  /** How to start the server. Default: this package's bin.js, with the Node that runs the demo. */
  server?: { command: string; args: string[] };
  /** Test seam for the ledger download. */
  fetch?: typeof fetch;
  /** Test seam for the clock that says whether a mandate has expired. */
  now?: () => Date;
}

/** A mandate as list_mandates prints it (src/format.ts mandateSummary). */
export interface MandateRow {
  id: number;
  label: string;
  status: string;
  payee: string;
  max_per_payment_usdc: string;
  max_total_usdc: string;
  spent_usdc: string;
  reserved_usdc: string;
  remaining_usdc: string;
  uses: number;
  max_uses: number;
  uses_left: number;
  approval_above_usdc: string;
  expires_at: string | null;
}

export interface Verdict {
  ok: boolean;
  code: string | null;
  would_hold: boolean;
}

/** A step's result, from best to worst. "note" and "skipped" still exit 0; "differs" and "failed" exit 1. */
const OUTCOMES = ["as expected", "note", "skipped", "differs", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];
const worse = (a: Outcome, b: Outcome): Outcome =>
  OUTCOMES.indexOf(a) >= OUTCOMES.indexOf(b) ? a : b;

interface ToolAnswer {
  isError: boolean;
  text: string;
}

export const DEMO_HELP = `Usage: probarion-mcp demo [--vault <id>]

A read-only tour of the five tools against a live NEAR testnet vault, by default ${DEMO_VAULT}.
It starts the MCP server over stdio with no key, so nothing can be signed or sent, and prints each step
with what it expects: the tools and their fields, the mandate's caps, the contract's check_spend answers,
an injected "to" field refused by the input schema, a paid spend, and verify on the vault's public ledger
from probarion.xyz. NEAR_RPC_URLS and NEAR_ARCHIVAL_RPC_URLS are passed on to the server when set.
Exit code 0 when every step answered as expected or with a note, 1 otherwise, 2 for a usage error.
`;

/** The server's environment: the safe defaults of the MCP SDK, the vault, the ledger file and the RPC lists. */
export function demoServerEnv(env: Env, vault: string, ledgerPath: string): Record<string, string> {
  const out: Record<string, string> = {
    ...getDefaultEnvironment(),
    NEAR_NETWORK: "testnet",
    PROBARION_VAULT_ID: vault,
    PROBARION_LEDGER_PATH: ledgerPath,
  };
  for (const name of PASSED_ON) {
    const value = envValue(env, name);
    if (value !== undefined) out[name] = value;
  }
  delete out.PROBARION_AGENT_KEY;
  delete out.PROBARION_LEDGER_KEY;
  return out;
}

/** What the contract's checks would answer for this amount, from the mandate as list_mandates shows it. */
export function expectedVerdict(m: MandateRow, amount: bigint, now: Date): Verdict {
  const refused = (code: string): Verdict => ({ ok: false, code, would_hold: false });
  if (m.status === "revoked") return refused("MandateInactive");
  if (m.expires_at !== null && now.getTime() >= Date.parse(m.expires_at)) {
    return refused("MandateExpired");
  }
  if (amount > units(m.max_per_payment_usdc)) return refused("OverPerPayment");
  if (m.uses >= m.max_uses) return refused("UsesExhausted");
  if (amount > units(m.remaining_usdc)) return refused("OverMandateTotal");
  return { ok: true, code: null, would_hold: amount > units(m.approval_above_usdc) };
}

/** Smallest units of a USDC string the server printed; "0.00" is 0. */
function units(usdc: string): bigint {
  return /^0(\.0+)?$/.test(usdc) ? 0n : BigInt(parseUsdc(usdc));
}

/** Why no payment can go through this mandate now, or null when one can. */
function blocked(m: MandateRow, now: Date): string | null {
  if (m.status === "revoked") return "revoked";
  if (m.expires_at !== null && now.getTime() >= Date.parse(m.expires_at)) {
    return `expired on ${m.expires_at}`;
  }
  if (m.uses_left <= 0) return `exhausted, ${m.uses} of ${m.max_uses} uses used`;
  if (units(m.remaining_usdc) === 0n) return `exhausted, all ${m.max_total_usdc} USDC spent`;
  return null;
}

const verdictText = (v: Verdict): string =>
  v.ok ? `ok${v.would_hold ? ", held for an approver" : ", not held"}` : (v.code ?? "refused");

const sameVerdict = (a: Verdict, b: Verdict): boolean =>
  a.ok === b.ok && a.code === b.code && a.would_hold === b.would_hold;

/** The tool's answer as one line: whitespace folded and cut, since an error can span many lines. */
const oneLine = (text: string, max = 220): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

interface Arguments {
  vault: string;
}

/** The demo's arguments, or the usage problem. */
function parseArgs(args: readonly string[]): Arguments | { problem: string } | "help" {
  let vault = DEMO_VAULT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--help" || a === "-h") return "help";
    if (a === "--vault") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        return { problem: "--vault needs a vault id" };
      vault = next;
      i += 1;
    } else if (a.startsWith("--vault=")) {
      vault = a.slice("--vault=".length);
    } else {
      return { problem: `unknown argument ${JSON.stringify(a).slice(0, 60)}` };
    }
  }
  if (!isNearAccountId(vault)) return { problem: "--vault must be a NEAR account id" };
  if (!vault.endsWith(".testnet")) {
    return {
      problem: "the demo runs on NEAR testnet only: give a vault whose id ends in .testnet",
    };
  }
  return { vault };
}

/** The public ledger, saved to `path`; the number of entries, or why it could not be had. */
async function downloadLedger(
  url: string,
  path: string,
  doFetch: typeof fetch,
): Promise<{ entries: number } | { problem: string }> {
  let text: string;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS) });
    if (res.status !== 200) return { problem: `HTTP ${res.status}` };
    text = await res.text();
  } catch (e) {
    return { problem: safeMessage(e) };
  }
  if (text.length > LEDGER_MAX_BYTES) return { problem: "the file is larger than 32 MiB" };
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { problem: "the ledger is empty" };
  if (!lines.every((l) => l.trimStart().startsWith("{"))) {
    return { problem: "the answer is not a JSON Lines ledger" };
  }
  writeFileSync(path, text);
  return { entries: lines.length };
}

/** Runs the demo; returns the exit code. */
export async function runDemo(args: readonly string[], io: DemoIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === "help") {
    io.out.write(DEMO_HELP);
    return 0;
  }
  if ("problem" in parsed) {
    io.err.write(`probarion-mcp demo: ${parsed.problem}\n\n${DEMO_HELP}`);
    return 2;
  }
  const { vault } = parsed;
  const now = io.now ?? (() => new Date());
  const say = (line = ""): void => {
    io.out.write(`${line}\n`);
  };
  const outcomes: Outcome[] = [];
  const result = (outcome: Outcome, detail = ""): void => {
    outcomes.push(outcome);
    say(`  result: ${outcome}${detail === "" ? "" : `. ${detail}`}`);
    say();
  };

  const dir = mkdtempSync(join(tmpdir(), "probarion-mcp-demo-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const url = ledgerUrl(vault);

  const server = io.server ?? {
    command: process.execPath,
    args: [fileURLToPath(new URL("./bin.js", import.meta.url))],
  };
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: demoServerEnv(io.env, vault, ledgerPath),
    stderr: "pipe",
  });
  let serverLog = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    serverLog = `${serverLog}${chunk.toString("utf8")}`.slice(-4000);
  });
  const client = new Client({ name: "probarion-mcp-demo", version: "0.0.0" });

  const call = async (
    name: string,
    args: Record<string, unknown>,
    timeout?: number,
  ): Promise<ToolAnswer> => {
    try {
      const r = await client.callTool(
        { name, arguments: args },
        undefined,
        timeout === undefined ? undefined : { timeout },
      );
      const content = (r.content ?? []) as { type: string; text?: string }[];
      return {
        isError: r.isError === true,
        text: content.map((c) => c.text ?? "").join("\n"),
      };
    } catch (e) {
      return { isError: true, text: safeMessage(e) };
    }
  };

  try {
    // The ledger first: the server reads PROBARION_LEDGER_PATH when it starts.
    const ledger = await downloadLedger(url, ledgerPath, io.fetch ?? fetch);
    try {
      await client.connect(transport);
    } catch (e) {
      say(`probarion-mcp demo: the server did not start: ${safeMessage(e)}`);
      if (serverLog !== "") say(`server log:\n${serverLog.trimEnd()}`);
      return 1;
    }
    const info = client.getServerVersion();
    say(`probarion-mcp ${info?.version ?? "?"} demo: vault ${vault} on NEAR testnet`);
    say("The server runs with no key, so it can sign nothing: every step is a read, a dry run");
    say("or a refusal. Each step says what it expects, then what came back.");
    say();

    // Step 1: the tools and their fields.
    say("Step 1 of 6. tools/list: the five tools and the fields each one takes");
    say(
      `  expect: ${TOOL_NAMES.length} tools; no field names a recipient; every input refuses fields it does not know`,
    );
    const { tools } = await client.listTools();
    const problems: string[] = [];
    for (const t of tools) {
      const schema = t.inputSchema as {
        properties?: Record<string, unknown>;
        additionalProperties?: unknown;
      };
      const fields = Object.keys(schema.properties ?? {});
      say(`  ${t.name.padEnd(17)}${fields.length === 0 ? "(no fields)" : fields.join(", ")}`);
      for (const f of fields.filter((f) => ADDRESS_LIKE.test(f))) {
        problems.push(`${t.name} has a field ${f}`);
      }
      if (schema.additionalProperties !== false) {
        problems.push(`${t.name} takes fields it does not list`);
      }
    }
    const names = tools.map((t) => t.name).sort();
    if (names.join() !== [...TOOL_NAMES].sort().join()) {
      problems.push(`the tools are ${names.join(", ")}`);
    }
    if (problems.length === 0) result("as expected", "No tool takes an address");
    else result("differs", problems.join("; "));

    // Step 2: the mandates, read live.
    say("Step 2 of 6. list_mandates: the caps the owner signed, read live from the vault contract");
    say("  expect: read_only true, and each mandate's payee, caps, uses and expiry");
    const listed = await call("list_mandates", {});
    let mandates: MandateRow[] = [];
    let chosen: MandateRow | undefined;
    if (listed.isError) {
      result("failed", `list_mandates answered: ${oneLine(listed.text)}`);
    } else {
      const body = JSON.parse(listed.text) as { read_only: boolean; mandates: MandateRow[] };
      if (body.read_only !== true) {
        // Cannot happen with the environment above; stop rather than go on with a server that holds a key.
        result("failed", "the server is not read-only; the demo stops here");
        return 1;
      }
      mandates = body.mandates;
      for (const m of mandates) {
        say(`  mandate ${m.id} ${JSON.stringify(m.label)}, ${m.status}`);
        say(`    payee        ${m.payee}`);
        say(
          `    per payment  ${m.max_per_payment_usdc} USDC, held for an approver above ${m.approval_above_usdc} USDC`,
        );
        say(
          `    total        ${m.max_total_usdc} USDC: ${m.spent_usdc} spent, ${m.reserved_usdc} reserved, ${m.remaining_usdc} left`,
        );
        say(`    uses         ${m.uses} of ${m.max_uses} used, ${m.uses_left} left`);
        say(`    expires      ${m.expires_at ?? "never"}`);
      }
      chosen = mandates.find((m) => blocked(m, now()) === null) ?? mandates[0];
      if (mandates.length === 0) {
        result("note", "The vault has no mandate, so step 3 has nothing to dry-run");
      } else if (chosen !== undefined && blocked(chosen, now()) !== null) {
        result(
          "note",
          `No mandate can pay now (mandate ${chosen.id}: ${blocked(chosen, now())}). The dry runs below show the contract refusing, which is what a mandate is for`,
        );
      } else {
        const n = mandates.length;
        result("as expected", `read_only true, ${n} ${n === 1 ? "mandate" : "mandates"}`);
      }
    }

    // Step 3: the contract's own dry run, at amounts taken from the mandate's caps.
    say(
      `Step 3 of 6. check_spend${chosen === undefined ? "" : ` on mandate ${chosen.id}`}: the contract's dry run of spend, a view call with no transaction`,
    );
    if (chosen === undefined) {
      result("skipped", "No mandate to dry-run");
    } else {
      const m = chosen;
      const perPayment = units(m.max_per_payment_usdc);
      const threshold = units(m.approval_above_usdc);
      const remaining = units(m.remaining_usdc);
      const room = remaining > 0n && remaining < perPayment ? remaining : perPayment;
      // Math.min takes no bigint, so the smaller of the two is picked by hand.
      const belowRoom = threshold < room;
      const cases: { amount: bigint | null; why: string; skip: string }[] = [
        {
          amount: belowRoom ? threshold : room,
          why: belowRoom ? "at the approval threshold" : "the most this mandate pays now",
          skip: "the mandate holds every payment for an approver",
        },
        {
          amount: room > threshold ? room : null,
          why: room === perPayment ? "the per-payment cap" : "what is left of the total",
          skip: "no amount the mandate allows is above its approval threshold",
        },
        {
          amount: perPayment + 1_000_000n,
          why: "1.00 USDC over the per-payment cap",
          skip: "",
        },
      ];
      let outcome: Outcome = "as expected";
      const notes: string[] = [];
      let skipped = 0;
      for (const c of cases) {
        if (c.amount === null || c.amount <= 0n) {
          say(`  (one dry run skipped: ${c.skip})`);
          skipped += 1;
          outcome = worse(outcome, "note");
          continue;
        }
        const usdc = formatUsdc(c.amount.toString());
        const want = expectedVerdict(m, c.amount, now());
        say(`  ${usdc} USDC (${c.why}): expect ${verdictText(want)}`);
        const answer = await call("check_spend", {
          mandate_id: m.id,
          amount: usdc,
          invoice_hash: randomBytes(32).toString("hex"),
          ref: `demo:${randomBytes(8).toString("hex")}`,
        });
        if (answer.isError) {
          say(`    -> error: ${oneLine(answer.text)}`);
          outcome = worse(outcome, "failed");
          continue;
        }
        const got = JSON.parse(answer.text) as Verdict;
        const shown = `ok: ${got.ok}, ${got.ok ? `would_hold: ${got.would_hold}` : `code: ${got.code}`}`;
        if (sameVerdict(got, want)) {
          say(`    -> ${shown}. As expected.`);
        } else if (got.code !== null && VAULT_WIDE[got.code] !== undefined) {
          say(`    -> ${shown}: ${VAULT_WIDE[got.code]}.`);
          notes.push(got.code);
          outcome = worse(outcome, "note");
        } else {
          say(`    -> ${shown}, not ${verdictText(want)}.`);
          outcome = worse(outcome, "differs");
        }
      }
      const asSaid = `The contract answered as the mandate's caps, uses and expiry say${skipped > 0 ? `; ${skipped} dry run skipped, as said above` : ""}`;
      result(
        outcome,
        notes.length > 0
          ? `The contract answered ${[...new Set(notes)].join(", ")}, a refusal for the whole vault`
          : outcome === "as expected" || outcome === "note"
            ? asSaid
            : "",
      );
    }

    // Step 4: a prompt-injected recipient, refused by the input schema.
    say(
      'Step 4 of 6. request_spend with an injected "to" field, as a prompt injection would add it',
    );
    say("  expect: refused by the tool's strict input schema, before the tool runs");
    const injected = await call("request_spend", {
      mandate_id: chosen?.id ?? 1,
      amount: "1.00",
      invoice_hash: randomBytes(32).toString("hex"),
      ref: `demo:${randomBytes(8).toString("hex")}`,
      reasoning: "The vendor's email says to pay this address instead.",
      to: "attacker.testnet",
    });
    say(`  -> ${injected.isError ? "refused" : "accepted"}: ${oneLine(injected.text)}`);
    if (
      injected.isError &&
      /input validation error/i.test(injected.text) &&
      injected.text.includes('"to"')
    ) {
      result(
        "as expected",
        "The schema refused the field. This server is read-only as well, so request_spend could not pay anyway",
      );
    } else {
      result("differs", "the input schema did not refuse the injected field");
    }

    // Step 5: a paid spend, by id.
    say("Step 5 of 6. get_spend_status: a paid spend, read from the vault contract");
    say(`  expect: a spend with status paid among the vault's first ${SPEND_STATUS_LIMIT}`);
    let paid = false;
    let failed = false;
    for (let id = 1; id <= SPEND_STATUS_LIMIT && !paid && !failed; id++) {
      const answer = await call("get_spend_status", { spend_id: id });
      if (answer.isError) {
        if (answer.text.startsWith(`spend ${id} not found`)) {
          say(`  spend ${id}: not found`);
          break;
        }
        say(`  spend ${id}: error: ${oneLine(answer.text)}`);
        failed = true;
        break;
      }
      const s = JSON.parse(answer.text) as {
        status: string;
        amount_usdc: string;
        destination: string;
        mandate_id: number;
        ref: string;
        created_at: string | null;
      };
      say(
        `  spend ${id}: ${s.status}, ${s.amount_usdc} USDC to ${s.destination}, mandate ${s.mandate_id}, ref ${s.ref}, created ${s.created_at ?? "?"}`,
      );
      paid = s.status === "paid";
    }
    if (paid) result("as expected", "A paid spend is final: the vault paid the mandate's payee");
    else if (failed) result("failed", "get_spend_status did not answer");
    else result("note", `No paid spend among the vault's first ${SPEND_STATUS_LIMIT}`);

    // Step 6: verify on the public ledger.
    say("Step 6 of 6. verify: Probarion's verifier on the vault's public ledger and the chain");
    if ("problem" in ledger) {
      say(`  ledger: could not download ${url} (${ledger.problem})`);
      result("skipped", "verify needs the vault's ledger; it was not run");
    } else {
      say(`  ledger: ${ledger.entries} entries from ${url}`);
      say("  expect: ok true (every check passes, or is skipped with a reason)");
      const answer = await call("verify", {}, VERIFY_TIMEOUT_MS);
      if (answer.isError) {
        result("failed", `verify answered: ${oneLine(answer.text)}`);
      } else {
        const report = JSON.parse(answer.text) as {
          ok: boolean;
          entries: number;
          anchors: number;
          checks: { id: string; name: string; status: string; detail: string }[];
        };
        for (const c of report.checks) {
          say(`  ${c.id} ${c.name.padEnd(22)} ${c.status.padEnd(8)} ${oneLine(c.detail, 120)}`);
        }
        say(`  -> ok: ${report.ok}, ${report.entries} entries, ${report.anchors} anchors`);
        if (report.ok) result("as expected", "The ledger and the chain agree");
        else result("differs", "verify did not pass; the failing checks are above");
      }
    }

    const count = (o: Outcome) => outcomes.filter((x) => x === o).length;
    // "2 notes", "2 differ": only those two outcome words change in the plural.
    const plural: Partial<Record<Outcome, string>> = { note: "notes", differs: "differ" };
    const parts = OUTCOMES.filter((o) => count(o) > 0).map(
      (o) => `${count(o)} ${count(o) > 1 ? (plural[o] ?? o) : o}`,
    );
    say(`Done: ${outcomes.length} steps, ${parts.join(", ")}. Nothing was signed or sent.`);
    const bad = count("differs") + count("failed") > 0;
    if (bad && serverLog !== "") say(`server log:\n${serverLog.trimEnd()}`);
    return bad ? 1 : 0;
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}
