import type { Command } from "commander";
import { type GlobalOpts, optionalAccount, requireVault, resolveNetwork } from "../context.js";
import type { CliIo } from "../io.js";
import { ONE_YOCTO, printOwnerTx } from "../owner-tx.js";
import { assertPositive, nearToYocto } from "../units.js";
import { checkedPublicKey } from "./agent.js";

type SetKeyOpts = GlobalOpts & {
  vault?: string;
  pk: string;
  allowance: string;
  signAs?: string;
  outDir: string;
};

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
  return ledger;
}
