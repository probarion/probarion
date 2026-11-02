import { NETWORKS, type NetworkId } from "@probarion/core";
import type { Command } from "commander";
import { type GlobalOpts, optionalAccount, requireVault, resolveNetwork } from "../context.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { ONE_YOCTO, printOwnerTx } from "../owner-tx.js";
import { assertPositive, positiveInt, toSmallestUnits } from "../units.js";
import { checkedPublicKey } from "./agent.js";

type CallOpts = GlobalOpts & {
  vault?: string;
  signAs?: string;
  outDir: string;
  pk?: string;
  mandate?: string;
  spend?: string;
  amount?: string;
  token?: string;
};

export interface CallSpec {
  group: string;
  name: string;
  description: string;
  method: string;
  /** Prepaid gas in Tgas, as docs/runbooks/testnet.md section 5 gives it (R8). */
  gasTgas: string;
  oneYocto: boolean;
  signer: "owner" | "approver";
  options: [flags: string, description: string][];
  args: (o: CallOpts, network: NetworkId) => Record<string, unknown>;
  note: string;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new CliError(`${flag} is required`);
  return value;
}

/** Ids start at 1 (interfaces v2 section 4.2), so 0 names nothing. */
function idArg(value: string | undefined, flag: string): number {
  return positiveInt(required(value, flag), flag);
}

function amountArg(value: string | undefined): string {
  return assertPositive(toSmallestUnits(required(value, "--amount"), "--amount"), "--amount");
}

/**
 * The amount is converted with USDC's 6 decimals, so only the network's two allowed USDC assets are
 * accepted: `base` and `solana` are short for them, and their account ids are taken as written.
 */
function intentsToken(value: string, network: NetworkId): string {
  const assets = NETWORKS[network].allowedAssets;
  if (value === "base" || value === assets.base) return assets.base;
  if (value === "solana" || value === assets.solana) return assets.solana;
  throw new CliError(
    `--token must be base, solana or one of this network's allowed USDC assets (${assets.base}, ${assets.solana}), got ${value}`,
  );
}

// Gas: docs/runbooks/testnet.md section 5. Approving and withdrawing cascade into cross-contract
// promises (a payout and its callback), so they carry more than the bare 30 Tgas; test/gas-table.test.ts
// pins every value here to that table.
export const OWNER_CALLS: readonly CallSpec[] = [
  {
    group: "agent",
    name: "remove",
    description: "print remove_agent for the OWNER to sign (deletes the agent's function-call key)",
    method: "remove_agent",
    gasTgas: "30.0",
    oneYocto: true,
    signer: "owner",
    options: [["--pk <pk>", "agent public key, ed25519:…"]],
    args: (o) => ({ public_key: checkedPublicKey(required(o.pk, "--pk"), "--pk") }),
    note: "The vault deletes the agent's key, so it can sign no further spends. Spends already held still wait for an approver.",
  },
  {
    group: "mandate",
    name: "revoke",
    description: "print revoke_mandate for the OWNER to sign",
    method: "revoke_mandate",
    gasTgas: "30.0",
    oneYocto: true,
    signer: "owner",
    options: [["--mandate <id>", "mandate id (ids start at 1)"]],
    args: (o) => ({ mandate_id: idArg(o.mandate, "--mandate") }),
    note: "Pending spends keep their reservation until they settle or fail; approve then refuses with MandateInactive.",
  },
  {
    group: "spend",
    name: "approve",
    description: "print approve for a held spend, for an APPROVER to sign",
    method: "approve",
    gasTgas: "150.0",
    oneYocto: true,
    signer: "approver",
    options: [["--spend <id>", "held spend id (ids start at 1)"]],
    args: (o) => ({ spend_id: idArg(o.spend, "--spend") }),
    note: "This executes the payout to the mandate's payee. It is valid until the hold expires and refused while the vault is frozen.",
  },
  {
    group: "spend",
    name: "reject",
    description: "print reject for a held spend, for an APPROVER to sign",
    method: "reject",
    gasTgas: "30.0",
    oneYocto: true,
    signer: "approver",
    options: [["--spend <id>", "held spend id (ids start at 1)"]],
    args: (o) => ({ spend_id: idArg(o.spend, "--spend") }),
    note: "This releases the reservation and the invoice hash. The ref stays consumed.",
  },
  {
    group: "vault",
    name: "freeze",
    description: "print freeze for the OWNER to sign (no deposit: any owner key may freeze)",
    method: "freeze",
    gasTgas: "30.0",
    oneYocto: false,
    signer: "owner",
    options: [],
    args: () => ({}),
    note: "Every spend and approval is refused until unfreeze.",
  },
  {
    group: "vault",
    name: "unfreeze",
    description: "print unfreeze for the OWNER to sign",
    method: "unfreeze",
    gasTgas: "30.0",
    oneYocto: true,
    signer: "owner",
    options: [],
    args: () => ({}),
    note: "The one-yocto deposit means only a full-access key, through a wallet prompt, can unfreeze.",
  },
  {
    group: "vault",
    name: "withdraw",
    description: "print withdraw (native USDC back to the owner) for the OWNER to sign",
    method: "withdraw",
    gasTgas: "100.0",
    oneYocto: true,
    signer: "owner",
    options: [["--amount <usdc>", "amount in USDC"]],
    args: (o) => ({ amount: amountArg(o.amount) }),
    note: "The USDC goes to the vault owner's account, nowhere else.",
  },
  {
    group: "vault",
    name: "withdraw-intents",
    description:
      "print withdraw_intents (the vault's POA balance in intents back to the owner) for the OWNER to sign",
    method: "withdraw_intents",
    gasTgas: "150.0",
    oneYocto: true,
    signer: "owner",
    options: [
      ["--token <token>", "base, solana, or the network's POA USDC asset id"],
      ["--amount <usdc>", "amount in USDC"],
    ],
    args: (o, network) => ({
      token: intentsToken(required(o.token, "--token"), network),
      amount: amountArg(o.amount),
    }),
    note: "The intents contract sends the tokens to the vault owner's account, nowhere else.",
  },
];

/** Adds the calls above to the existing command groups (and creates `spend`). Register after vault, mandate and agent. */
export function registerOwnerCalls(program: Command, io: CliIo): void {
  const group = (name: string): Command =>
    program.commands.find((c) => c.name() === name) ??
    program.command(name).description(`${name} commands (transactions are printed, never signed)`);
  for (const spec of OWNER_CALLS) {
    const cmd = group(spec.group)
      .command(spec.name)
      .description(spec.description)
      .option("--vault <id>", "vault account (default: PROBARION_VAULT_ID)");
    for (const [flags, description] of spec.options) cmd.option(flags, description);
    cmd
      .option("--sign-as <account>", `the ${spec.signer} account that signs`)
      .option("--out-dir <dir>", "directory for the args JSON", ".")
      .action(async (_options: unknown, command: Command) => {
        const o = command.optsWithGlobals<CallOpts>();
        const network = resolveNetwork(o, io.env);
        await printOwnerTx(
          io,
          {
            network,
            contractId: requireVault(o.vault, io.env),
            method: spec.method,
            args: spec.args(o, network),
            gasTgas: spec.gasTgas,
            deposit: spec.oneYocto ? ONE_YOCTO : "0 NEAR",
            signAs: optionalAccount(o.signAs, "--sign-as"),
            signer: spec.signer,
            note: spec.note,
          },
          o.outDir,
        );
      });
  }
}
