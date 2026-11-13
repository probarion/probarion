import {
  assessPayee,
  formatPayeeRef,
  type PayeeAssessment,
  type PayeeLevel,
  type PayeeRef,
  parsePayeeRef,
} from "@probarion/core";
import { envValue, readPayeeSignals, resolveArchivalRpcUrls } from "@probarion/sdk";
import type { Command } from "commander";
import { type GlobalOpts, resolveNetwork, rpcUrlsFor, splitList } from "../context.js";
import { asUsage, CliError, UsageError, usageExitCodes } from "../errors.js";
import type { CliIo } from "../io.js";
import { NEAR_ACCOUNT_RE } from "../payee.js";
import { printable } from "../report.js";

type PayeeCheckOpts = GlobalOpts & {
  vault?: string;
  archivalRpc?: string;
  baseRpc?: string;
  json?: boolean;
};

const PAYEE_CHECK_EXIT_CODES = `
Exit codes:
  0   allow: every check passed
  2   warn: confirm something with the payee first, or a signal could not be read
  1   block: a reason not to pay, or the check could not run (error: on stderr)
  64  usage error: a malformed payee or flag
`;

const EXIT: Readonly<Record<PayeeAssessment["verdict"], number>> = { allow: 0, warn: 2, block: 1 };
const LEVEL_WIDTH = 6;
const ID_WIDTH = 20;

function checkedPayee(arg: string): PayeeRef {
  const parsed = parsePayeeRef(arg);
  if (!parsed.ok) throw new UsageError(`payee ${arg}: ${parsed.problem}`);
  return parsed.payee;
}

/** `--vault`, else PROBARION_VAULT_ID, else none: without a vault, past payments and lookalikes are not checked. */
function optionalVault(vault: string | undefined, env: CliIo["env"]): string | undefined {
  const id = vault ?? envValue(env, "PROBARION_VAULT_ID");
  if (id === undefined) return undefined;
  if (!NEAR_ACCOUNT_RE.test(id))
    throw new UsageError(`--vault ${id} is not a valid NEAR account id`);
  return id;
}

function urlList(value: string, flag: string): string[] {
  const urls = splitList(value);
  if (urls.length === 0) throw new UsageError(`${flag} needs at least one URL`);
  return urls;
}

/** The assessment in lines: the verdict, then one line per reason, in the order block, warn, info. */
export function formatPayeeAssessment(a: PayeeAssessment): string {
  const lines = [
    `${a.verdict.toUpperCase()}: ${printable(formatPayeeRef(a.payee))} on ${a.network}`,
  ];
  for (const r of a.reasons) {
    const level: PayeeLevel = r.level;
    lines.push(`  ${level.padEnd(LEVEL_WIDTH)}${r.id.padEnd(ID_WIDTH)}${printable(r.text)}`);
    if (r.evidence !== undefined) {
      lines.push(`  ${"".padEnd(LEVEL_WIDTH + ID_WIDTH)}evidence: ${printable(r.evidence)}`);
    }
  }
  lines.push(
    `Read-only at ${a.checked_at}: views and block headers, nothing signed or sent.`,
    "The verdict is advice for the owner who writes this payee into a mandate. It changes nothing on chain.",
  );
  return `${lines.join("\n")}\n`;
}

export function registerPayee(program: Command, io: CliIo): void {
  const payee = program
    .command("payee")
    .description("payee commands (read-only: nothing is signed or sent)");
  const check = payee
    .command("check")
    .description(
      "check a payee before a mandate names it: allow, warn or block, with the reasons (exists, contract, new or changed in about 7 days, past payments, lookalikes, blocklist)",
    )
    .argument("<payee>", "near:<account> | base:<0x address> | solana:<address>")
    .option(
      "--vault <id>",
      "the vault whose mandates and spends give past payments and lookalikes (default: PROBARION_VAULT_ID, else none)",
    )
    .option(
      "--archival-rpc <urls>",
      "comma-separated archival NEAR RPC URLs for the block about 7 days back (default: NEAR_ARCHIVAL_RPC_URLS, else FastNEAR's archival node)",
    )
    .option(
      "--base-rpc <url>",
      "Base JSON-RPC URL for a Base payee (default: on mainnet https://mainnet.base.org; on testnet none)",
    )
    .option("--json", "print the assessment and the signals it was made from as JSON")
    .addHelpText("after", PAYEE_CHECK_EXIT_CODES);
  usageExitCodes(check).action(async (arg: string, _options: unknown, command: Command) => {
    const o = command.optsWithGlobals<PayeeCheckOpts>();
    const parsed = asUsage(() => {
      const network = resolveNetwork(o, io.env);
      return {
        network,
        payee: checkedPayee(arg),
        vault: optionalVault(o.vault, io.env),
        rpcUrls: rpcUrlsFor(o, io.env, network),
        archivalRpcUrls:
          o.archivalRpc === undefined
            ? resolveArchivalRpcUrls(network, io.env)
            : urlList(o.archivalRpc, "--archival-rpc"),
        baseRpcUrl:
          o.baseRpc === undefined ? undefined : (urlList(o.baseRpc, "--base-rpc")[0] ?? null),
      };
    });
    const signals = await readPayeeSignals(
      { network: parsed.network, payee: parsed.payee, vault: parsed.vault },
      {
        rpcUrls: parsed.rpcUrls,
        archivalRpcUrls: parsed.archivalRpcUrls,
        ...(parsed.baseRpcUrl === undefined ? {} : { baseRpcUrl: parsed.baseRpcUrl }),
        fetch: io.payeeDeps?.fetch,
        now: () => io.now(),
      },
    ).catch((error: unknown) => {
      // readPayeeSignals turns every failed read into "unknown"; anything it throws is a bug, never an allow.
      throw new CliError(
        `payee check could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const assessment = assessPayee(signals);
    if (o.json === true) {
      io.out(`${JSON.stringify({ ...assessment, signals }, null, 2)}\n`);
    } else {
      io.out(formatPayeeAssessment(assessment));
    }
    io.setExitCode(EXIT[assessment.verdict]);
  });
}
