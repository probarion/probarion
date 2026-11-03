import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FileLedgerStore } from "@probarion/sdk";
import type { Command } from "commander";
import {
  type GlobalOpts,
  ledgerFile,
  optionalAccount,
  requireVault,
  resolveNetwork,
  sameFile,
} from "../context.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { displayPath, ONE_YOCTO, printOwnerTx } from "../owner-tx.js";
import { assertPositive, nearToYocto } from "../units.js";
import { checkedPublicKey } from "./agent.js";

type SetKeyOpts = GlobalOpts & {
  vault?: string;
  pk: string;
  allowance: string;
  signAs?: string;
  outDir: string;
};

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

export function registerLedger(program: Command, io: CliIo): Command {
  const ledger = program.command("ledger").description("ledger commands");
  ledger
    .command("set-key")
    .description(
      "print the set_ledger_key transaction for the OWNER to sign (FC key: methods = anchor)",
    )
    .option("--vault <id>", "vault account (default: PROBARION_VAULT_ID)")
    .requiredOption("--pk <pk>", "ledger public key, ed25519:…")
    .option("--allowance <near>", "gas allowance of the key, in NEAR", "0.25")
    .option("--sign-as <account>", "the owner account that signs")
    .option("--out-dir <dir>", "directory for the args JSON", ".")
    .action(async (_options: unknown, command: Command) => {
      const o = command.optsWithGlobals<SetKeyOpts>();
      await printOwnerTx(
        io,
        {
          network: resolveNetwork(o, io.env),
          contractId: requireVault(o.vault, io.env),
          method: "set_ledger_key",
          args: {
            public_key: checkedPublicKey(o.pk, "--pk"),
            // The vault refuses an allowance of 0 (an unlimited key).
            allowance: assertPositive(nearToYocto(o.allowance, "--allowance"), "--allowance"),
          },
          gasTgas: "30.0",
          deposit: ONE_YOCTO,
          signAs: optionalAccount(o.signAs, "--sign-as"),
          note: "This replaces any previous ledger key: the vault deletes the old one. Entries already covered by an anchor stay verifiable against the key recorded with that anchor; entries after the last anchor must be signed by the new key, so anchor the ledger before you rotate. The key must not already be an agent key.",
        },
        o.outDir,
      );
    });
  ledger
    .command("export")
    .description("export the ledger as JSONL, one entry per line, to a new file")
    .requiredOption("--out <file>", "output file; it must not exist yet")
    .option(
      "--ledger <path>",
      "ledger JSONL file (default: PROBARION_LEDGER_PATH, else .probarion/ledger.jsonl)",
    )
    .action(async (options: { out: string; ledger?: string }) => {
      const source = ledgerFile(options.ledger, io.env, io.cwd);
      const target = resolve(io.cwd, options.out);
      if (await sameFile(source, target, io.platform ?? process.platform)) {
        throw new CliError("--out must be a different file from the ledger (--ledger)");
      }
      try {
        await stat(source);
      } catch {
        throw new CliError(`the ledger file ${displayPath(io.cwd, source)} does not exist`);
      }
      const entries = await new FileLedgerStore(source).all();
      try {
        // "wx": a ledger is an audit trail; never write over a file that is already there.
        await writeFile(target, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new CliError(`--out ${options.out} already exists: choose a new file`);
        }
        throw error;
      }
      const noun = entries.length === 1 ? "entry" : "entries";
      io.out(`exported ${entries.length} ${noun} to ${displayPath(io.cwd, target)}\n`);
    });
  return ledger;
}
