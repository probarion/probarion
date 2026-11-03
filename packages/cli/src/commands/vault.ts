import { FactoryClient } from "@probarion/sdk";
import type { Command } from "commander";
import {
  factoryIdFor,
  type GlobalOpts,
  makeRpc,
  optionalAccount,
  resolveNetwork,
  splitList,
} from "../context.js";
import { CliError } from "../errors.js";
import type { CliIo } from "../io.js";
import { printOwnerTx } from "../owner-tx.js";
import { NEAR_ACCOUNT_RE } from "../payee.js";
import {
  assertPositive,
  canonicalNear,
  hoursToNs,
  nearToYocto,
  positiveInt,
  toSmallestUnits,
  yoctoToNear,
} from "../units.js";

/** contracts/factory/src/lib.rs `valid_name`: `^[a-z0-9][a-z0-9_-]{1,30}$`. */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,30}$/;
/** contracts/factory/src/lib.rs `MAX_APPROVERS` (the vault's own limit). */
const MAX_APPROVERS = 10;
/** contracts/factory/src/lib.rs `MAX_HELD_TTL_NS`: 30 days. */
const MAX_HELD_TTL_HOURS = 720;

type VaultCreateOpts = GlobalOpts & {
  name: string;
  approvers: string;
  dailyBackstop: string;
  heldTtlHours: string;
  deposit?: string;
  signAs?: string;
  outDir: string;
};

export function registerVault(program: Command, io: CliIo): void {
  const vault = program
    .command("vault")
    .description("vault commands (owner transactions are printed, never signed)");
  vault
    .command("create")
    .description("print the factory create_vault transaction for the OWNER to sign")
    .requiredOption("--name <name>", "vault name; the account becomes <name>.<factory>")
    .requiredOption("--approvers <list>", "comma-separated approver accounts (1 to 10)")
    .option("--daily-backstop <usdc>", "daily backstop in USDC", "500")
    .option(
      "--held-ttl-hours <hours>",
      "how long a held spend waits for an approver (1 to 720)",
      "72",
    )
    .option(
      "--deposit <near>",
      "attached deposit in NEAR (default: the factory's min_deposit; required for an embedded factory version)",
    )
    .option("--sign-as <account>", "the owner account that signs; it becomes the vault owner")
    .option("--out-dir <dir>", "directory for the args JSON", ".")
    .action(async (_options: unknown, command: Command) => {
      const o = command.optsWithGlobals<VaultCreateOpts>();
      const network = resolveNetwork(o, io.env);

      // Everything the factory checks before it creates anything, checked here before anything is read.
      if (!VAULT_NAME_RE.test(o.name)) {
        throw new CliError("--name must match ^[a-z0-9][a-z0-9_-]{1,30}$ (2 to 31 characters)");
      }
      const factoryId = factoryIdFor(network, io.env);
      const account = `${o.name}.${factoryId}`;
      if (!NEAR_ACCOUNT_RE.test(account)) {
        throw new CliError(
          `--name ${o.name} would make ${account}, which is not a valid NEAR account id (at most 64 characters, no trailing - or _)`,
        );
      }
      const approvers = splitList(o.approvers);
      if (approvers.length === 0) throw new CliError("--approvers needs at least one account");
      if (approvers.length > MAX_APPROVERS) {
        throw new CliError(
          `--approvers takes at most ${MAX_APPROVERS} accounts, got ${approvers.length}`,
        );
      }
      for (const [index, approver] of approvers.entries()) {
        if (!NEAR_ACCOUNT_RE.test(approver)) {
          throw new CliError(`approver ${approver} is not a valid NEAR account id`);
        }
        if (approvers.indexOf(approver) !== index) {
          throw new CliError(`approver ${approver} is listed twice in --approvers`);
        }
      }
      const dailyBackstop = assertPositive(
        toSmallestUnits(o.dailyBackstop, "--daily-backstop"),
        "--daily-backstop",
      );
      // 1 to 720 hours: the vault refuses a hold longer than 30 days.
      const heldTtlHours = positiveInt(o.heldTtlHours, "--held-ttl-hours", MAX_HELD_TTL_HOURS);
      const heldTtlNs = hoursToNs(String(heldTtlHours));
      const signAs = optionalAccount(o.signAs, "--sign-as");
      const requested = o.deposit === undefined ? undefined : canonicalNear(o.deposit, "--deposit");

      // The factory's current version decides the deposit.
      const factory = new FactoryClient(factoryId, makeRpc(o, io.env, network));
      const config = await factory.getConfig();
      if (config.current_version === null) {
        throw new CliError(
          `factory ${factoryId} has no vault version registered yet (get_config.current_version is null), so create_vault would be refused with PROBARION:InvalidInput`,
        );
      }
      const version = (await factory.versions()).find((v) => v.index === config.current_version);
      if (version === undefined) {
        throw new CliError(
          `factory ${factoryId} reports current version ${config.current_version}, which is not in its versions list`,
        );
      }
      if (version.mode !== "global" && version.mode !== "embedded") {
        throw new CliError(
          `factory ${factoryId} version ${version.index} has the unknown mode ${JSON.stringify(version.mode)}`,
        );
      }
      if (!/^[0-9]+$/.test(config.min_deposit)) {
        throw new CliError(`factory ${factoryId} reports a malformed min_deposit`);
      }
      const minDeposit = yoctoToNear(config.min_deposit);

      let deposit: string;
      if (requested === undefined) {
        if (version.mode === "embedded") {
          throw new CliError(
            `factory ${factoryId} version ${version.index} is embedded: the new vault stores its own copy of the vault wasm, and the deposit must pay for that storage on top of min_deposit (${minDeposit} NEAR); pass --deposit (min_deposit + about 1 NEAR per 100 KB of vault wasm, 2.49 NEAR at 248,501 bytes)`,
          );
        }
        deposit = minDeposit;
      } else {
        if (BigInt(nearToYocto(requested, "--deposit")) < BigInt(config.min_deposit)) {
          throw new CliError(
            `--deposit ${requested} NEAR is below the factory's min_deposit (${minDeposit} NEAR); create_vault would be refused with PROBARION:InsufficientDeposit`,
          );
        }
        deposit = requested;
      }

      const notes = [
        `The signing account becomes the owner of ${account}. The vault starts with no access keys.`,
        `Factory ${factoryId} version ${version.index} (${version.mode}); its min_deposit is ${minDeposit} NEAR.`,
      ];
      if (version.mode === "embedded") {
        notes.push(
          "An embedded version also charges the storage of the vault wasm. A deposit that falls short is refused with PROBARION:InsufficientDeposit and nothing is created.",
        );
      }
      notes.push(
        "The deposit stays in the vault as its NEAR runway for storage and gas; the vault has no method to withdraw NEAR. If the name is taken, the creation fails and the factory refunds the deposit.",
      );
      await printOwnerTx(
        io,
        {
          network,
          contractId: factoryId,
          method: "create_vault",
          args: {
            name: o.name,
            approvers,
            daily_backstop: dailyBackstop,
            held_ttl_ns: heldTtlNs,
          },
          gasTgas: "300.0",
          deposit: `${deposit} NEAR`,
          signAs,
          note: notes.join("\n"),
        },
        o.outDir,
      );
    });
}
