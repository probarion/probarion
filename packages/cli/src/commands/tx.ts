// `probarion tx prove`: N1 of @probarion/near, the outcome proof verifier, with N2's receipt-bound event reader on
// the proven outcomes. It reads a head on two providers, the transaction and a light_client_proof for it and for each
// receipt over JSON-RPC, and signs nothing.
import { isNearTxHash } from "@probarion/core";
import {
  type BoundEvent,
  type EventProblem,
  HeadMismatchError,
  type OutcomeTreeResult,
  type ProvenOutcome,
  type ProvenStatus,
  proveTransaction,
  readCrossCheckedHead,
  scanAllEvents,
} from "@probarion/near";
import { resolveArchivalRpcUrls } from "@probarion/sdk";
import type { Command } from "commander";
import { type GlobalOpts, resolveNetwork, rpcUrlsFor, splitList } from "../context.js";
import { asUsage, CliError, UsageError, usageExitCodes } from "../errors.js";
import type { CliIo } from "../io.js";
import { checkedAccount, messageOf, nearRpc, toJson } from "../near.js";
import { printable } from "../report.js";

type TxProveOpts = GlobalOpts & {
  signer: string;
  headRpc?: string;
  archivalRpc?: string;
  json?: boolean;
};

const TX_PROVE_EXIT_CODES = `
Exit codes:
  0   proven: the transaction and every receipt it led to are committed under the head (a failed receipt is proven as a failure)
  1   not proven: a proof did not verify, the two head providers disagree, or a read failed (error: on stderr)
  64  usage error: a malformed hash, account or flag, or head URLs on fewer than two origins
`;

/** A success value longer than this is printed as its length; `--json` carries all of it. */
const MAX_VALUE_TEXT = 120;

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
      `${failed} receipt(s) failed: the proof shows they ran and failed, and an event a failed receipt logged did not take effect.`,
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

export function registerTx(program: Command, io: CliIo): void {
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
      // A provider a few blocks behind does not know the other's final block yet: that clears on a second run.
      const hint =
        error instanceof HeadMismatchError
          ? ""
          : " (a provider a few blocks behind may not know the head yet: run it again)";
      throw new CliError(
        `tx prove could not read a head both providers agree on: ${messageOf(error)}${hint}`,
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
