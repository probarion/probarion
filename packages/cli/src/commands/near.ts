// The NEAR builder primitives of @probarion/near, run by the CLI: `account audit` (N3, the account lock audit) and
// `tx prove` (N1, the outcome proof verifier, with N2's receipt-bound event reader on the proven outcomes). Both
// read views and proofs over JSON-RPC and sign nothing.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isNearTxHash, KNOWN_VAULT_CODE_HASHES } from "@probarion/core";
import {
  type AccountLockReport,
  type BoundEvent,
  type EventProblem,
  type KeyPolicy,
  matchRecordedBuild,
  type NearRpc,
  NearRpcError,
  type OutcomeTreeResult,
  type ProvenOutcome,
  type ProvenStatus,
  proveTransaction,
  type RecordedBuild,
  readAccountLock,
  readCrossCheckedHead,
  scanAllEvents,
} from "@probarion/near";
import { RpcClient, resolveArchivalRpcUrls } from "@probarion/sdk";
import type { Command } from "commander";
import { type GlobalOpts, resolveNetwork, rpcUrlsFor, splitList } from "../context.js";
import { asUsage, CliError, UsageError, usageExitCodes } from "../errors.js";
import type { CliIo } from "../io.js";
import { NEAR_ACCOUNT_RE } from "../payee.js";
import { printable } from "../report.js";

type AccountAuditOpts = GlobalOpts & { vaultPolicy?: boolean; builds?: string; json?: boolean };
type TxProveOpts = GlobalOpts & {
  signer: string;
  headRpc?: string;
  archivalRpc?: string;
  json?: boolean;
};
type Builds = readonly RecordedBuild[] | { entries: readonly RecordedBuild[] };

const ACCOUNT_AUDIT_EXIT_CODES = `
Exit codes:
  0   locked: no key acts as full access, and the key policy and the recorded build match when given
  2   locked, with a warning to read (a key that can call any method, an unlimited allowance)
  1   not locked, a blocking finding (a key outside the policy, code that is not a recorded build), or the
      account could not be read (error: on stderr)
  64  usage error: a malformed account or flag, or a --builds file that cannot be read
`;

const TX_PROVE_EXIT_CODES = `
Exit codes:
  0   proven: the transaction and every receipt it led to are committed under the head (a failed receipt is
      reported, and still proven: the proof shows it ran and failed)
  1   not proven: a proof did not verify, the two head providers disagree, or a read failed (error: on stderr)
  64  usage error: a malformed hash, account or flag, or head URLs on fewer than two origins
`;

/** Bounds the node's `result.error` text kept in a message; the whole answer stays in `rpcError`. */
const MAX_DETAIL = 300;
/** A success value longer than this is printed as its length; `--json` carries all of it. */
const MAX_VALUE_TEXT = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SDK's RpcClient (failover across `urls`, retries) as a NearRpc. RpcClient hands a legacy `query` failure
 * (HTTP 200 with a `result.error` text, which older nodes send for a missing account) back as a result; here it
 * throws a NearRpcError, as `httpJsonRpc` does, so such an answer does not pass for a view.
 */
function nearRpc(urls: readonly string[], io: CliIo): NearRpc {
  const fetchImpl = io.nearDeps?.fetch;
  const client = new RpcClient({ urls, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  return {
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
      const result = await client.call<unknown>(method, params);
      if (isRecord(result) && typeof result.error === "string") {
        const text =
          result.error.length > MAX_DETAIL
            ? `${result.error.slice(0, MAX_DETAIL)}...`
            : result.error;
        throw new NearRpcError(method, result, `${method}: ${text}`);
      }
      return result as T;
    },
  };
}

/** JSON with every bigint as its decimal string and every byte array as base64 (a success value). */
function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
      return v;
    },
    2,
  );
}

function checkedAccount(value: string, what: string): string {
  if (!NEAR_ACCOUNT_RE.test(value))
    throw new UsageError(`${what} ${value} is not a valid NEAR account id`);
  return value;
}

/**
 * The key policy of a Probarion vault: every key is a function-call key on the vault itself for `spend` (an agent
 * key) or for `anchor` (the ledger key), with a limited allowance (the vault refuses a zero, unlimited one) and no
 * gas key. No full-access key. The anchor rule names no public key: pinning it to the vault's current ledger key
 * (`get_config`) is check f of `probarion verify`.
 */
export function vaultKeyPolicy(vault: string): KeyPolicy {
  return {
    fullAccess: "forbid",
    rules: [
      { receiverId: vault, methods: ["spend"] },
      { receiverId: vault, methods: ["anchor"] },
    ],
  };
}

/** core's KNOWN_VAULT_CODE_HASHES (the recorded reproducible vault builds) as recorded builds. */
function knownVaultBuilds(): readonly RecordedBuild[] {
  return KNOWN_VAULT_CODE_HASHES.map((codeHash) => ({
    code_hash: codeHash,
    crate: "probarion-vault",
  }));
}

/**
 * A `--builds` file: a list of recorded builds, or a code-hashes record (`{ "entries": [...] }`, the shape of
 * contracts/code-hashes.json). Each entry needs a `code_hash` in base58 or hex; anything else is a usage error
 * (64), found before the chain is read.
 */
async function readBuilds(io: CliIo, file: string): Promise<Builds> {
  let text: string;
  try {
    text = await readFile(resolve(io.cwd, file), "utf8");
  } catch {
    throw new UsageError(`--builds ${file} is not a readable file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`--builds ${file} is not JSON`);
  }
  const builds = parsed as Builds;
  try {
    // The library reads the list as the audit will: a list or an entry it cannot read is a TypeError.
    matchRecordedBuild({ kind: "none" }, builds);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new UsageError(
        `--builds ${file} is not a list of builds nor a code-hashes record ({ "entries": [{ "code_hash": ... }] }): ${error.message}`,
      );
    }
    throw error;
  }
  return builds;
}

/**
 * The exit code of `account audit`: 1 when the account is not locked, a finding blocks, or the report is not ok
 * (a key outside the policy, code that is not a recorded build); else 2 when a finding warns; else 0.
 */
export function accountAuditExitCode(report: AccountLockReport): number {
  const findings = report.keys.findings;
  if (!report.locked || !report.ok || findings.some((f) => f.severity === "block")) return 1;
  return findings.some((f) => f.severity === "warn") ? 2 : 0;
}

/** The report's own sentences, then where and when the views were read. */
export function formatAccountAudit(report: AccountLockReport, network: string): string {
  const lines = report.lines.map((line) => printable(line));
  const at =
    report.keys.blockHeight === null
      ? "at a final block"
      : `at block ${report.keys.blockHeight}${report.keys.blockHash === null ? "" : ` (${printable(report.keys.blockHash)})`}`;
  lines.push(
    `Views read on NEAR ${network} ${at}: view_account and view_access_key_list. Nothing was signed or sent.`,
  );
  return `${lines.join("\n")}\n`;
}

/** The URLs grouped by origin, in the order each origin is named. A URL that is not http(s) is a usage error. */
function byOrigin(urls: readonly string[], flag: string): string[][] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    let origin: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
      origin = parsed.origin;
    } catch {
      // The URL is not repeated: it may carry an API key.
      throw new UsageError(`${flag}: a URL is not an http or https URL`);
    }
    const group = groups.get(origin) ?? [];
    group.push(url);
    groups.set(origin, group);
  }
  return [...groups.values()];
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function statusText(status: ProvenStatus): string {
  switch (status.kind) {
    case "success_value": {
      if (status.value.length === 0) return "success (no value)";
      let text: string | null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(status.value);
      } catch {
        text = null;
      }
      return text !== null && text.length <= MAX_VALUE_TEXT
        ? `success (value ${printable(text)})`
        : `success (a value of ${status.value.length} bytes)`;
    }
    case "success_receipt_id":
      return `success (continues in receipt ${printable(status.receiptId)})`;
    case "failure":
      return "failure (the proof does not carry the reason)";
    default:
      return "unknown";
  }
}

function eventLine(e: BoundEvent): string {
  const data = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
  return `    event ${printable(e.standard)} ${printable(e.event)} ${printable(e.version)}${printable(data)}`;
}

function problemLine(p: EventProblem): string {
  return `    malformed EVENT_JSON log ${p.logIndex}: ${printable(p.problem)}`;
}

interface ProveContext {
  txHash: string;
  signer: string;
  network: string;
  head: { hash: string; height: number; blockMerkleRoot: string };
  /** The origin the head was read on, and the origins it was matched on (one of them answered). */
  headOrigins: { read: string; matched: readonly string[] };
  /** The origins of the archival URLs (one of them answered each read). */
  archivalOrigins: readonly string[];
}

/** A proven tree: the verdict, one line per outcome with its events, then what was trusted and read. */
export function formatProvenTree(ctx: ProveContext, outcomes: readonly ProvenOutcome[]): string {
  const { events, malformed } = scanAllEvents(outcomes);
  const failed = outcomes.filter((o) => o.status.kind === "failure").length;
  const lines = [
    `PROVEN: tx ${printable(ctx.txHash)} signed by ${printable(ctx.signer)} on ${ctx.network}: ${outcomes.length} outcome(s) committed under block ${ctx.head.height} (${printable(ctx.head.hash)})`,
  ];
  for (const o of outcomes) {
    lines.push(
      `  ${printable(o.id)}  ${printable(o.executorId)}  block ${o.block.height}  ${statusText(o.status)}`,
    );
    for (const e of events.filter((x) => x.receiptId === o.id)) lines.push(eventLine(e));
    for (const p of malformed.filter((x) => x.receiptId === o.id)) lines.push(problemLine(p));
  }
  if (failed > 0) {
    lines.push(
      `${failed} receipt(s) failed: the proof shows they ran and failed, and their logs are still listed above.`,
    );
  }
  lines.push(
    "Events are listed as each executor logged them: an event speaks for a token when its executor is that token's contract.",
    `Head block ${ctx.head.height} read from ${ctx.headOrigins.read} and matched on ${ctx.headOrigins.matched.join(" or ")}: the head is trusted, not proven (validator signatures are not checked).`,
    `Proofs read with light_client_proof from ${ctx.archivalOrigins.join(" or ")}. Nothing was signed or sent.`,
  );
  return `${lines.join("\n")}\n`;
}

/** The JSON of `tx prove`: the verdict, the head and its origins, and per proven outcome its fields and events. */
function provenJson(ctx: ProveContext, result: OutcomeTreeResult): unknown {
  const base = {
    tx_hash: ctx.txHash,
    signer_id: ctx.signer,
    network: ctx.network,
    head: ctx.head,
    head_origins: ctx.headOrigins,
    archival_origins: ctx.archivalOrigins,
  };
  if (!result.ok) {
    return {
      proven: false,
      ...base,
      index: result.index,
      code: result.code,
      detail: result.detail,
    };
  }
  const { events, malformed } = scanAllEvents(result.outcomes);
  return {
    proven: true,
    ...base,
    // Each outcome without its `head`: every one is proven under the one head printed above.
    outcomes: result.outcomes.map(({ head: _head, ...o }) => ({
      ...o,
      events: events.filter((e) => e.receiptId === o.id),
      malformed_events: malformed.filter((p) => p.receiptId === o.id),
    })),
  };
}

export function registerNear(program: Command, io: CliIo): void {
  const account = program
    .command("account")
    .description("account commands (views over JSON-RPC: nothing is signed or sent)");
  const audit = account
    .command("audit")
    .description(
      "audit what each access key of an account can do if it leaks (full access, receiver and methods, allowance, gas keys) and whether its code is a recorded build, read at one block",
    )
    .argument("<account>", "the NEAR account to audit")
    .option(
      "--vault-policy",
      "hold the keys to a Probarion vault's policy (function-call keys on the account itself for spend or anchor, a limited allowance, no gas key) and the code to the recorded vault builds",
    )
    .option(
      "--builds <file>",
      "a code-hashes record file ({ entries: [{ code_hash, ... }] }, as contracts/code-hashes.json) or a list of builds the code must match (default with --vault-policy: the recorded vault builds)",
    )
    .option("--json", "print the report as JSON (amounts as decimal strings)")
    .addHelpText("after", ACCOUNT_AUDIT_EXIT_CODES);
  usageExitCodes(audit).action(async (arg: string, _options: unknown, command: Command) => {
    const o = command.optsWithGlobals<AccountAuditOpts>();
    const parsed = asUsage(() => {
      const network = resolveNetwork(o, io.env);
      return {
        network,
        accountId: checkedAccount(arg, "account"),
        rpcUrls: rpcUrlsFor(o, io.env, network),
      };
    });
    const vaultPolicy = o.vaultPolicy === true;
    const builds =
      o.builds !== undefined
        ? await readBuilds(io, o.builds)
        : vaultPolicy
          ? knownVaultBuilds()
          : undefined;
    const report = await readAccountLock(nearRpc(parsed.rpcUrls, io), parsed.accountId, {
      ...(vaultPolicy ? { policy: vaultKeyPolicy(parsed.accountId) } : {}),
      ...(builds === undefined ? {} : { builds }),
    }).catch((error: unknown) => {
      throw new CliError(`account audit could not read ${parsed.accountId}: ${messageOf(error)}`);
    });
    if (o.json === true) {
      io.out(`${toJson(report)}\n`);
    } else {
      io.out(formatAccountAudit(report, parsed.network));
      if (vaultPolicy) {
        io.out(
          "The vault policy does not pin the anchor key to the vault's current ledger key: probarion verify (check f) does.\n",
        );
      }
    }
    io.setExitCode(accountAuditExitCode(report));
  });

  const tx = program
    .command("tx")
    .description("transaction commands (proofs over JSON-RPC: nothing is signed or sent)");
  const prove = tx
    .command("prove")
    .description(
      "prove a transaction and every receipt it led to (executor, status, logs, receipt ids) from light_client_proof answers under a head that two providers agree on, and list the NEP-297 events of the proven outcomes",
    )
    .argument("<tx-hash>", "the transaction hash (base58)")
    .requiredOption("--signer <account>", "the account that signed the transaction")
    .option(
      "--head-rpc <urls>",
      "comma-separated NEAR RPC URLs on at least two origins for the head block, read on one and matched on another (default: --rpc, NEAR_RPC_URLS, else the network defaults)",
    )
    .option(
      "--archival-rpc <urls>",
      "comma-separated archival NEAR RPC URLs for the tx and its proofs (default: NEAR_ARCHIVAL_RPC_URLS, else FastNEAR's archival node)",
    )
    .option("--json", "print the proven outcomes and their events as JSON")
    .addHelpText("after", TX_PROVE_EXIT_CODES);
  usageExitCodes(prove).action(async (arg: string, _options: unknown, command: Command) => {
    const o = command.optsWithGlobals<TxProveOpts>();
    const parsed = asUsage(() => {
      const network = resolveNetwork(o, io.env);
      if (!isNearTxHash(arg)) {
        throw new UsageError(`tx hash ${arg} is not base58 for 32 bytes`);
      }
      const headUrls =
        o.headRpc === undefined ? rpcUrlsFor(o, io.env, network) : splitList(o.headRpc);
      if (headUrls.length === 0) throw new UsageError("--head-rpc needs at least one URL");
      const groups = byOrigin(headUrls, o.headRpc === undefined ? "--rpc" : "--head-rpc");
      const [primary, ...others] = groups;
      if (primary === undefined || others.length === 0) {
        throw new UsageError(
          `tx prove reads the head on one provider and matches it on another: give --head-rpc with URLs on at least two origins (got ${groups.length})`,
        );
      }
      const archivalUrls =
        o.archivalRpc === undefined
          ? resolveArchivalRpcUrls(network, io.env)
          : splitList(o.archivalRpc);
      if (archivalUrls.length === 0) throw new UsageError("--archival-rpc needs at least one URL");
      byOrigin(archivalUrls, "--archival-rpc");
      return {
        network,
        txHash: arg,
        signer: checkedAccount(o.signer, "--signer"),
        primary,
        // Every other origin: a failover of the second read stays off the provider of the first.
        secondary: others.flat(),
        archivalUrls,
      };
    });
    const head = await readCrossCheckedHead(
      nearRpc(parsed.primary, io),
      nearRpc(parsed.secondary, io),
    ).catch((error: unknown) => {
      throw new CliError(
        `tx prove could not read a head both providers agree on: ${messageOf(error)}`,
      );
    });
    const result = await proveTransaction(nearRpc(parsed.archivalUrls, io), {
      txHash: parsed.txHash,
      senderId: parsed.signer,
      head,
    }).catch((error: unknown) => {
      throw new CliError(`tx prove could not read the proofs: ${messageOf(error)}`);
    });
    const ctx: ProveContext = {
      txHash: parsed.txHash,
      signer: parsed.signer,
      network: parsed.network,
      head,
      headOrigins: {
        read: originOf(parsed.primary[0] as string),
        matched: [...new Set(parsed.secondary.map(originOf))],
      },
      archivalOrigins: [...new Set(parsed.archivalUrls.map(originOf))],
    };
    if (o.json === true) {
      io.out(`${toJson(provenJson(ctx, result))}\n`);
    } else if (result.ok) {
      io.out(formatProvenTree(ctx, result.outcomes));
    } else {
      io.out(
        `NOT PROVEN: tx ${printable(parsed.txHash)} signed by ${printable(parsed.signer)} on ${parsed.network}: ${result.index >= 0 ? `proof ${result.index}: ` : ""}${result.code}: ${printable(result.detail)}\n`,
      );
    }
    io.setExitCode(result.ok ? 0 : 1);
  });
}
