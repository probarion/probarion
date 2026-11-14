// `probarion account audit`: N3 of @probarion/near, the account lock audit. It reads view_account and
// view_access_key_list at one block over JSON-RPC, says what each access key can do if it leaks and whether the code is
// a recorded build, and signs nothing.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KNOWN_VAULT_CODE_HASHES } from "@probarion/core";
import {
  type AccountLockReport,
  type KeyPolicy,
  matchRecordedBuild,
  type RecordedBuild,
  readAccountLock,
} from "@probarion/near";
import type { Command } from "commander";
import { type GlobalOpts, resolveNetwork, rpcUrlsFor } from "../context.js";
import { asUsage, CliError, UsageError, usageExitCodes } from "../errors.js";
import type { CliIo } from "../io.js";
import { checkedAccount, messageOf, nearRpc, toJson } from "../near.js";
import { printable } from "../report.js";

type AccountAuditOpts = GlobalOpts & { vaultPolicy?: boolean; builds?: string; json?: boolean };
type Builds = readonly RecordedBuild[] | { entries: readonly RecordedBuild[] };

const ACCOUNT_AUDIT_EXIT_CODES = `
Exit codes:
  0   locked: no key acts as full access, and the key policy and the recorded build match when given
  2   locked, with a warning to read (a key that can call any method, an unlimited allowance)
  1   not locked, a blocking finding (a key outside the policy, code that is not a recorded build), or a failed read (error: on stderr)
  64  usage error: a malformed account or flag, or a --builds file that cannot be read
`;

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

export function registerAccount(program: Command, io: CliIo): void {
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
}
