import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateKeyPair, KeyFormatError, parsePublicKey, utf8 } from "@probarion/core";
import type { Command } from "commander";
import { type GlobalOpts, optionalAccount, requireVault, resolveNetwork } from "../context.js";
import { CliError } from "../errors.js";
import { findGitWorkTree } from "../git-work-tree.js";
import type { CliIo } from "../io.js";
import { displayPath, ONE_YOCTO, printOwnerTx, shellQuote } from "../owner-tx.js";
import { assertPositive, nearToYocto } from "../units.js";

type KeyTxOpts = GlobalOpts & {
  vault?: string;
  pk: string;
  allowance: string;
  label?: string;
  signAs?: string;
  outDir: string;
};

export function checkedPublicKey(pk: string, flag: string): string {
  try {
    parsePublicKey(pk);
  } catch (error) {
    throw new CliError(
      `${flag}: ${error instanceof KeyFormatError ? error.message : String(error)}`,
    );
  }
  return pk;
}

export function registerAgent(program: Command, io: CliIo): void {
  const agent = program.command("agent").description("agent keys");
  agent
    .command("keygen")
    .description(
      "generate an ed25519 key pair; needs --out <file> (saved, not printed) or --print-secret (printed)",
    )
    .option("--json", "print JSON")
    .option(
      "--out <file>",
      "save the pair to this file (owner-only, never overwritten) and print only the public key",
    )
    .option(
      "--print-secret",
      "print the secret key to this terminal, where it stays in your scrollback",
    )
    .action(async (_options: unknown, command: Command) => {
      const options = command.opts<{ json?: boolean; out?: string; printSecret?: boolean }>();
      if (options.out === undefined && options.printSecret !== true) {
        throw new CliError(
          "agent keygen needs one of: --out <file> (saves the key pair to a file only you can read, never overwriting, and prints the public key only) or --print-secret (prints the secret key to this terminal, where it stays in your scrollback)",
        );
      }
      if (options.out !== undefined && options.printSecret === true) {
        throw new CliError("use --out <file> or --print-secret, not both");
      }
      const pair = generateKeyPair();
      if (options.out !== undefined) {
        const file = path.resolve(io.cwd, options.out);
        const shown = displayPath(io.cwd, file);
        const windows = (io.platform ?? process.platform) === "win32";
        await mkdir(path.dirname(file), { recursive: true });
        try {
          // "wx" never overwrites a key file; 0o600 keeps it to its owner where the OS enforces modes.
          await writeFile(
            file,
            `${JSON.stringify({ public_key: pair.publicKey, secret_key: pair.secretKey }, null, 2)}\n`,
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          throw new CliError(
            code === "EEXIST"
              ? `${shown} already exists; keygen never overwrites a key file`
              : `could not write ${shown}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (windows) {
          io.err(
            `warning: on Windows, file permissions are not restricted by mode bits: ${shown} gets the permissions of its folder, so other users or programs on this machine may be able to read it. Keep it in a folder only you can read.\n`,
          );
        }
        // Whether git ignores or tracks the file cannot be told reliably without running git, so any
        // file inside a work tree gets the warning, covered by a .gitignore or not.
        if ((await findGitWorkTree(file)) !== null) {
          const quoted = shellQuote(shown);
          io.err(
            `warning: this file is inside a git repository: make sure it is ignored and not tracked (git check-ignore -v ${quoted}; git ls-files ${quoted})\n`,
          );
        }
        if (options.json === true) {
          io.out(
            `${JSON.stringify({ public_key: pair.publicKey, secret_file: shown }, null, 2)}\n`,
          );
          return;
        }
        io.out(
          [
            `public_key: ${pair.publicKey}`,
            `secret_key: saved to ${shown}${windows ? "" : " (mode 0600)"}, not printed`,
            "",
            "Keep that file server-side only (read PROBARION_AGENT_KEY or PROBARION_LEDGER_KEY from it). Never commit it.",
            'Share only the public key with the vault owner, who adds it with "probarion agent add" or "probarion ledger set-key".',
            "",
          ].join("\n"),
        );
        return;
      }
      if (options.json === true) {
        io.out(
          `${JSON.stringify({ public_key: pair.publicKey, secret_key: pair.secretKey }, null, 2)}\n`,
        );
        return;
      }
      io.out(
        [
          `public_key: ${pair.publicKey}`,
          `secret_key: ${pair.secretKey}`,
          "",
          "Keep the secret server-side only (PROBARION_AGENT_KEY or PROBARION_LEDGER_KEY). Never commit it.",
          'Share only the public key with the vault owner, who adds it with "probarion agent add" or "probarion ledger set-key".',
          "The secret is now in your terminal scrollback. --out <file> keeps it off the screen.",
          "",
        ].join("\n"),
      );
    });
  agent
    .command("add")
    .description(
      "print the add_agent transaction for the OWNER to sign (FC key: receiver = vault, methods = spend)",
    )
    .option("--vault <id>", "vault account (default: PROBARION_VAULT_ID)")
    .requiredOption("--pk <pk>", "agent public key, ed25519:…")
    .option("--allowance <near>", "gas allowance of the key, in NEAR", "1")
    .option("--label <label>", "label, at most 64 bytes", "agent")
    .option("--sign-as <account>", "the owner account that signs")
    .option("--out-dir <dir>", "directory for the args JSON", ".")
    .action(async (_options: unknown, command: Command) => {
      const o = command.optsWithGlobals<KeyTxOpts>();
      const label = o.label ?? "agent";
      if (utf8(label).length > 64) throw new CliError("--label must be at most 64 bytes");
      await printOwnerTx(
        io,
        {
          network: resolveNetwork(o, io.env),
          contractId: requireVault(o.vault, io.env),
          method: "add_agent",
          args: {
            public_key: checkedPublicKey(o.pk, "--pk"),
            // The vault refuses an allowance of 0 (an unlimited key).
            allowance: assertPositive(nearToYocto(o.allowance, "--allowance"), "--allowance"),
            label,
          },
          gasTgas: "30.0",
          deposit: ONE_YOCTO,
          signAs: optionalAccount(o.signAs, "--sign-as"),
          note: "The vault adds a function-call key to itself that can only call spend and can never attach a deposit. The vault holds at most 16 agent keys, and a key cannot be both an agent and the ledger key.",
        },
        o.outDir,
      );
    });
}
