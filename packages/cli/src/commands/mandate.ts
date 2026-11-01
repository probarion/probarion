import { type MandateInput, utf8 } from "@probarion/core";
import type { Command } from "commander";
import {
  type GlobalOpts,
  optionalAccount,
  readPurpose,
  requireVault,
  resolveNetwork,
} from "../context.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { printOwnerTx } from "../owner-tx.js";
import { parsePayeeArg } from "../payee.js";
import {
  assertPositive,
  canonicalNear,
  nearToYocto,
  parseExpiry,
  positiveInt,
  toSmallestUnits,
} from "../units.js";
import { checkedPublicKey } from "./agent.js";

type MandateCreateOpts = GlobalOpts & {
  vault?: string;
  payee: string;
  maxPer: string;
  maxTotal: string;
  uses: string;
  expires: string;
  approvalAbove: string;
  agentPk: string;
  purpose: string;
  label: string;
  deposit: string;
  signAs?: string;
  outDir: string;
};

export function registerMandate(program: Command, io: CliIo): void {
  const mandate = program
    .command("mandate")
    .description("mandate commands (owner transactions are printed, never signed)");
  mandate
    .command("create")
    .description("print the create_mandate transaction for the OWNER to sign")
    .option("--vault <id>", "vault account (default: PROBARION_VAULT_ID)")
    .requiredOption("--payee <payee>", "near:<account> | base:<0x address> | solana:<address>")
    .requiredOption("--max-per <usdc>", "maximum per payment, in USDC")
    .requiredOption("--max-total <usdc>", "maximum in total, in USDC")
    .requiredOption("--uses <n>", "maximum number of payments")
    .requiredOption(
      "--expires <date>",
      "YYYY-MM-DD (end of that UTC day) or an ISO-8601 time with its zone",
    )
    .requiredOption("--approval-above <usdc>", "spends above this amount are held for an approver")
    .requiredOption("--agent-pk <pk>", "the only agent key allowed to spend against this mandate")
    .requiredOption(
      "--purpose <file|hex>",
      "PO or contract file (hashed with sha256), or its 64-hex hash",
    )
    .requiredOption("--label <label>", "label, at most 64 bytes")
    .option("--deposit <near>", "attached deposit in NEAR; the vault refunds the excess", "0.1")
    .option("--sign-as <account>", "the owner account that signs")
    .option("--out-dir <dir>", "directory for the args JSON", ".")
    .action(async (_options: unknown, command: Command) => {
      const o = command.optsWithGlobals<MandateCreateOpts>();
      const network = resolveNetwork(o, io.env);
      const vault = requireVault(o.vault, io.env);
      const agentPk = checkedPublicKey(o.agentPk, "--agent-pk");
      const maxPer = toSmallestUnits(o.maxPer, "--max-per");
      const maxTotal = toSmallestUnits(o.maxTotal, "--max-total");
      if (BigInt(maxPer) === 0n || BigInt(maxPer) > BigInt(maxTotal)) {
        throw new CliError("--max-per must be above 0 and at most --max-total");
      }
      if (utf8(o.label).length > 64) throw new CliError("--label must be at most 64 bytes");
      const payee = parsePayeeArg(o.payee, network);
      if (payee.type === "near" && payee.account_id === vault) {
        throw new CliError(
          `--payee near:${vault} is the vault itself; the vault refuses to pay itself`,
        );
      }
      const approvalAbove = toSmallestUnits(o.approvalAbove, "--approval-above");
      assertPositive(nearToYocto(o.deposit, "--deposit"), "--deposit");
      const deposit = canonicalNear(o.deposit, "--deposit");
      const signAs = optionalAccount(o.signAs, "--sign-as");
      const input: MandateInput = {
        payee,
        purpose_hash: await readPurpose(o.purpose, io.cwd),
        max_per_payment: maxPer,
        max_total: maxTotal,
        max_uses: positiveInt(o.uses, "--uses"),
        expires_at_ns: parseExpiry(o.expires, io.now()),
        approval_above: approvalAbove,
        agent_pk: agentPk,
        label: o.label,
      };
      const notes = ["The payee of a mandate never changes: a new payee needs a new mandate."];
      if (payee.type === "near") {
        notes.push(
          "The vault registers the payee's storage on the USDC contract (0.00125 NEAR) out of the deposit; the excess is refunded to you.",
        );
      }
      if (BigInt(approvalAbove) >= BigInt(maxPer)) {
        notes.push(
          "--approval-above is not below --max-per, so no spend is ever held for an approver: every payment up to --max-per pays out at once.",
        );
      }
      await printOwnerTx(
        io,
        {
          network,
          contractId: vault,
          method: "create_mandate",
          args: { input },
          gasTgas: "100.0",
          deposit: `${deposit} NEAR`,
          signAs,
          note: notes.join("\n"),
        },
        o.outDir,
      );
    });
}
