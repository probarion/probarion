import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { publicKeyFromSecret, ZERO_HEX32 } from "@probarion/core";
import { envValue, hashInvoice, VaultClient } from "@probarion/sdk";
import type { Command } from "commander";
import { type GlobalOpts, makeRpc, requireVault, resolveNetwork } from "../context.js";
import { asUsage, CliError, UsageError, usageExitCodes } from "../errors.js";
import type { CliIo } from "../io.js";
import { positiveInt, toSmallestUnits } from "../units.js";
import { checkedPublicKey } from "./agent.js";

type CheckOpts = GlobalOpts & {
  vault?: string;
  mandate: string;
  amount: string;
  invoice: string;
  ref: string;
  agentPk?: string;
  json?: boolean;
};

const CHECK_EXIT_CODES = `
Exit codes:
  0   the vault would accept the spend (it may hold it for an approver)
  1   the vault would refuse it (REFUSED: PROBARION:<Code>), or the check could not run (error: on stderr)
  64  usage error: a missing, malformed or conflicting flag, or an --invoice file that is not UTF-8 text
`;

/** The contract's `is_ref`: 1 to 64 bytes. */
function checkedRef(ref: string): string {
  const bytes = Buffer.byteLength(ref, "utf8");
  if (bytes === 0 || bytes > 64) throw new CliError(`--ref must be 1 to 64 bytes, got ${bytes}`);
  return ref;
}

/** The agent public key PROBARION_AGENT_KEY holds, or undefined when it is unset or empty (R12). Never echoes it. */
function envAgentPk(env: CliIo["env"]): string | undefined {
  const secret = envValue(env, "PROBARION_AGENT_KEY");
  if (secret === undefined) return undefined;
  try {
    return publicKeyFromSecret(secret);
  } catch {
    throw new UsageError(
      "PROBARION_AGENT_KEY is not a valid ed25519 secret key (ed25519:<base58>)",
    );
  }
}

export function registerCheck(program: Command, io: CliIo): void {
  const check = program
    .command("check")
    .description("dry-run check_spend for an invoice: a free view call; nothing is signed or sent")
    .option("--vault <id>", "vault account (default: PROBARION_VAULT_ID)")
    .requiredOption("--mandate <id>", "mandate id")
    .requiredOption("--amount <usdc>", "amount in USDC, up to 6 decimals")
    .requiredOption(
      "--invoice <file>",
      "the extracted invoice text (UTF-8), the text the agent processes; its hash is the invoice_hash",
    )
    .requiredOption("--ref <ref>", "idempotency reference, 1 to 64 bytes")
    .option(
      "--agent-pk <pk>",
      "agent public key to check as (default: from PROBARION_AGENT_KEY, else the mandate's agent)",
    )
    .option("--json", "print the request, the signer and the verdict as JSON")
    .addHelpText("after", CHECK_EXIT_CODES);
  usageExitCodes(check).action(async (_options: unknown, command: Command) => {
    const o = command.optsWithGlobals<CheckOpts>();
    const parsed = asUsage(() => {
      const network = resolveNetwork(o, io.env);
      return {
        rpc: makeRpc(o, io.env, network),
        vaultId: requireVault(o.vault, io.env),
        mandateId: positiveInt(o.mandate, "--mandate"),
        amount: toSmallestUnits(o.amount, "--amount"),
        ref: checkedRef(o.ref),
        agentPk: o.agentPk === undefined ? undefined : checkedPublicKey(o.agentPk, "--agent-pk"),
      };
    });
    const agentPk = parsed.agentPk ?? envAgentPk(io.env);
    let invoiceBytes: Uint8Array;
    try {
      invoiceBytes = new Uint8Array(await readFile(resolve(io.cwd, o.invoice)));
    } catch {
      throw new CliError(`--invoice ${o.invoice} is not a readable file`);
    }
    // The SDK's hash (ICR-3b): the sha256 of the invoice text, so the dry run names the invoice the agent pays.
    let invoiceHash: string;
    try {
      invoiceHash = hashInvoice(invoiceBytes);
    } catch {
      throw new UsageError(
        `--invoice ${o.invoice} is not UTF-8 text: pass the extracted invoice text, the text the agent processes`,
      );
    }
    const vault = new VaultClient(parsed.vaultId, parsed.rpc);
    let signerPk = agentPk;
    if (signerPk === undefined) {
      const mandate = await vault.getMandate(parsed.mandateId);
      if (mandate === null) {
        throw new CliError(
          `mandate ${parsed.mandateId} does not exist on ${parsed.vaultId}, and no --agent-pk or PROBARION_AGENT_KEY says who would sign`,
        );
      }
      signerPk = mandate.agent_pk;
    }
    const request = {
      mandate_id: parsed.mandateId,
      amount: parsed.amount,
      invoice_hash: invoiceHash,
      ref: parsed.ref,
      decision_hash: ZERO_HEX32,
    };
    const verdict = await vault.checkSpend(request, signerPk);
    if (o.json === true) {
      io.out(`${JSON.stringify({ request, signer_pk: signerPk, verdict }, null, 2)}\n`);
    } else {
      const head = verdict.ok
        ? `OK: the vault would accept this spend${verdict.would_hold ? " and hold it for an approver" : ""}.`
        : `REFUSED: PROBARION:${verdict.code ?? "unknown"}`;
      io.out(
        `${head}\nchecked as agent ${signerPk} against the vault's state now (a dry run: nothing was signed)\ninvoice_hash ${invoiceHash}\n`,
      );
    }
    io.setExitCode(verdict.ok ? 0 : 1);
  });
}
