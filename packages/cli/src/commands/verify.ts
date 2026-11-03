import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isNearTxHash, runChecks, type Snapshot, type VerifyReport } from "@probarion/core";
import {
  type BurnTxHint,
  FileLedgerStore,
  isPreLedgerVault,
  loadBurnTxHints,
  loadDefaultOnlineVerifier,
  Probarion,
  type ProbarionDeps,
  readPreLedgerDecisionHashes,
} from "@probarion/sdk";
import type { Command } from "commander";
import {
  alreadyExists,
  fileExists,
  type GlobalOpts,
  ledgerFile,
  makeRpc,
  requireVault,
  resolveNetwork,
  sameFile,
  writeNewFile,
} from "../context.js";
import { asUsage, CliError, UsageError, usageExitCodes } from "../errors.js";
import type { CliIo } from "../io.js";
import { displayPath } from "../owner-tx.js";
import { NEAR_ACCOUNT_RE } from "../payee.js";
import { onlineDidNotRun, type RenderOptions, renderReport, verifyExitCode } from "../report.js";

type VerifyOpts = GlobalOpts & {
  vault?: string;
  online?: boolean;
  snapshot?: string;
  offline?: string;
  json?: boolean;
  ledger?: string;
  evidence: string;
  archivalRpc?: string;
  burnTx?: string[];
  proof?: string;
};

/** A burn tx hint in the SDK's object form (`BurnTxHint`): the tx hash, and its signer when that is known. */
type Hint = Exclude<BurnTxHint, string>;

const VERIFY_HELP = `
Exit codes:
  0   every check passes
  1   a check fails (a fail always wins over unproven), or verify could not run (error: on stderr, no RESULT line)
  2   no check fails, but at least one is unproven: each UNPROVEN row names the spends and what to supply
  64  usage error: a missing, malformed or conflicting flag

--offline verifies a saved snapshot as it is, with no network at all, so it refuses the flags that shape a
snapshot: --vault, --ledger, --evidence, --burn-tx, --proof, --archival-rpc, --online, --rpc and --network.
Without --proof, verify reads no evidence file, not even a docs/mainnet-proof.json in the working directory.
`;

const MAX_SPEND_ID = Number.MAX_SAFE_INTEGER;

/** `<spend_id>=<tx hash>[@<signer>]`, as `--burn-tx` takes it. Anything else is a usage error (exit 64). */
export function parseBurnTx(value: string): { spendId: number; hint: Hint } {
  const bad = (why: string): never => {
    throw new UsageError(
      `--burn-tx ${JSON.stringify(value)}: ${why}; expected <spend_id>=<tx hash>[@<signer>]`,
    );
  };
  const eq = value.indexOf("=");
  if (eq === -1) return bad("there is no =");
  const id = value.slice(0, eq).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return bad(`the spend id must be a whole number from 0 to ${MAX_SPEND_ID}`);
  }
  const parts = value
    .slice(eq + 1)
    .trim()
    .split("@");
  if (parts.length > 2) return bad("there is more than one @");
  const [hash = "", signer] = parts;
  if (!isNearTxHash(hash)) return bad("the tx hash is not a NEAR tx hash (base58 of 32 bytes)");
  if (signer !== undefined && !NEAR_ACCOUNT_RE.test(signer)) {
    return bad("the signer is not a NEAR account id");
  }
  return { spendId: Number(id), hint: signer === undefined ? { hash } : { hash, signer } };
}

function addHint(hints: Map<number, Hint[]>, spendId: number, hint: Hint) {
  const list = hints.get(spendId) ?? [];
  if (!list.some((h) => h.hash === hint.hash)) list.push(hint);
  hints.set(spendId, list);
}

function parseSnapshot(text: string, file: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(`--offline ${file} is not JSON`);
  }
  const rec =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    rec === null ||
    rec.v !== 1 ||
    !Array.isArray(rec.ledger) ||
    typeof rec.chain !== "object" ||
    rec.chain === null
  ) {
    throw new CliError(`--offline ${file} is not a Probarion snapshot (v: 1)`);
  }
  // A snapshot written before the field existed lists no pre-ledger hashes: check d exempts nothing.
  if (!Array.isArray(rec.pre_ledger_decision_hashes)) rec.pre_ledger_decision_hashes = [];
  return value as Snapshot;
}

/** `--snapshot` goes to a new file that is not the ledger: checked before anything is read (exit 64). */
async function snapshotTarget(io: CliIo, given: string, ledgerPath: string): Promise<string> {
  const path = resolve(io.cwd, given);
  if (await sameFile(path, ledgerPath, io.platform ?? process.platform)) {
    throw new UsageError("--snapshot must be a different file from the ledger");
  }
  if (await fileExists(path)) throw new UsageError(alreadyExists("--snapshot", given).message);
  return path;
}

/** `--proof <file>`: the vault's burn tx hints in a plan 05 evidence file. A file that is not there is an error. */
async function proofHints(
  file: string,
  io: CliIo,
  opts: { vault: string; network: "mainnet" | "testnet" },
): Promise<Map<number, Hint[]>> {
  const path = resolve(io.cwd, file);
  let isFile = false;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    throw new CliError(`--proof ${file} does not exist or cannot be read`);
  }
  if (!isFile) throw new CliError(`--proof ${file} is not a file`);
  try {
    return await loadBurnTxHints(path, opts);
  } catch (error) {
    const why = error instanceof SyntaxError ? "it is not JSON" : String(error);
    throw new CliError(`--proof ${file} cannot be read as an evidence file: ${why}`);
  }
}

export function registerVerify(program: Command, io: CliIo): void {
  const verify = program
    .command("verify")
    .description(
      "verify a vault's ledger signatures, hash links, anchors, decisions, attestations, keys, burn memos and factory version",
    )
    .option("--vault <id>", "vault account (default: PROBARION_VAULT_ID)")
    .option(
      "--online",
      "also run O1 (Intel DCAP on each TDX quote) and O2 (NVIDIA NRAS on each GPU payload), and look burns up in FastNEAR's tx index; uses the network",
    )
    .option(
      "--snapshot <out>",
      "write the snapshot that was verified to a new file (refused when the file exists or is the ledger)",
    )
    .option("--offline <file>", "verify a saved snapshot, with no network at all")
    .option("--json", "print the report as JSON")
    .option(
      "--ledger <path>",
      "ledger JSONL file (default: PROBARION_LEDGER_PATH, else .probarion/ledger.jsonl)",
    )
    .option(
      "--evidence <dir>",
      "directory of the Day-4 v0-decision-*.json records (read for v0.probarion.near on mainnet only)",
      "docs/evidence",
    )
    .option(
      "--archival-rpc <urls>",
      "comma-separated archival NEAR RPC URLs for burn txs older than about 2.5 days (default: NEAR_ARCHIVAL_RPC_URLS, else FastNEAR's archival node)",
    )
    .option(
      "--burn-tx <spend_id=hash[@signer]>",
      "a tx that holds a spend's burn, for example an approver's approve tx; repeatable",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option(
      "--proof <file>",
      "an evidence file (docs/mainnet-proof.json format) whose txs of this vault are burn tx hints",
    )
    .addHelpText("after", VERIFY_HELP);

  usageExitCodes(verify).action(async (_options: unknown, command: Command) => {
    const o = command.optsWithGlobals<VerifyOpts>();
    const online = o.online === true;
    const burnTx = o.burnTx ?? [];
    if (o.snapshot !== undefined && o.snapshot.trim() === "") {
      throw new UsageError("--snapshot needs a file");
    }
    if (o.offline !== undefined) {
      const file = o.offline;
      asUsage(() => {
        const refused = (
          [
            ["--online", online],
            ["--vault", o.vault !== undefined],
            ["--ledger", o.ledger !== undefined],
            ["--evidence", command.getOptionValueSource("evidence") === "cli"],
            ["--burn-tx", burnTx.length > 0],
            ["--proof", o.proof !== undefined],
            ["--archival-rpc", o.archivalRpc !== undefined],
            ["--rpc", o.rpc !== undefined],
            ["--network", o.network !== undefined],
          ] as const
        )
          .filter(([, given]) => given)
          .map(([flag]) => flag);
        if (refused.length > 0) {
          throw new UsageError(
            `--offline verifies the saved snapshot as it is, with no network; it cannot take ${refused.join(", ")}`,
          );
        }
      });
      // --ledger is refused here, so the ledger to protect is the one PROBARION_LEDGER_PATH (or the default) names.
      const target =
        o.snapshot === undefined
          ? undefined
          : await snapshotTarget(io, o.snapshot, ledgerFile(undefined, io.env, io.cwd));
      let text: string;
      try {
        text = await readFile(resolve(io.cwd, file), "utf8");
      } catch {
        throw new CliError(`--offline ${file} is not a readable file`);
      }
      const snapshot = parseSnapshot(text, file);
      if (target !== undefined) await saveSnapshot(target, o.snapshot ?? "", snapshot);
      const report = await runChecks(snapshot, { now: io.now() });
      print(io, o, report, { offline: { takenAt: String(snapshot.taken_at) } });
      return;
    }

    // Everything the command line says is checked before the first file or RPC read (exit 64).
    const parsed = asUsage(() => {
      const network = resolveNetwork(o, io.env);
      const vault = requireVault(o.vault, io.env);
      const rpc = makeRpc(o, io.env, network);
      const archivalRpc =
        o.archivalRpc === undefined
          ? undefined
          : makeRpc({ rpc: o.archivalRpc }, io.env, network, "--archival-rpc");
      if (o.evidence.trim() === "") throw new UsageError("--evidence needs a directory");
      const hints = new Map<number, Hint[]>();
      for (const value of burnTx) {
        const { spendId, hint } = parseBurnTx(value);
        addHint(hints, spendId, hint);
      }
      return {
        network,
        vault,
        rpc,
        archivalRpc,
        hints,
        ledgerPath: ledgerFile(o.ledger, io.env, io.cwd),
        evidenceDir: resolve(io.cwd, o.evidence),
      };
    });
    const target =
      o.snapshot === undefined
        ? undefined
        : await snapshotTarget(io, o.snapshot, parsed.ledgerPath);

    const hints = parsed.hints;
    if (o.proof !== undefined) {
      const fromProof = await proofHints(o.proof, io, {
        vault: parsed.vault,
        network: parsed.network,
      });
      if (fromProof.size === 0) {
        io.err(
          `warning: --proof ${o.proof} records no tx of ${parsed.vault} on ${parsed.network}: it adds no burn tx hint\n`,
        );
      }
      // --burn-tx first, then the evidence file: each one is checked on chain, in that order.
      for (const [spendId, list] of fromProof) {
        for (const hint of list) addHint(hints, spendId, hint);
      }
    }
    if (!(await fileExists(parsed.ledgerPath))) {
      io.err(
        `warning: the ledger file ${displayPath(io.cwd, parsed.ledgerPath)} does not exist: verifying the chain against an empty ledger\n`,
      );
    }
    if (
      isPreLedgerVault(parsed.network, parsed.vault) &&
      (await readPreLedgerDecisionHashes(parsed.evidenceDir)).length === 0
    ) {
      io.err(
        `warning: no v0-decision-*.json in ${displayPath(io.cwd, parsed.evidenceDir)}: check d cannot exempt the documented Day-4 spends of ${parsed.vault} (run from the probarion repository, or pass --evidence <dir>)\n`,
      );
    }

    const deps: ProbarionDeps = {
      rpc: parsed.rpc,
      env: io.env,
      now: () => io.now(),
      evidenceDir: parsed.evidenceDir,
      // Always a map, never undefined: the SDK would otherwise read docs/mainnet-proof.json from the process cwd.
      burnTxHints: hints,
      logger: { warn: (message) => io.err(`warning: ${message}\n`) },
    };
    if (parsed.archivalRpc !== undefined) deps.archivalRpc = parsed.archivalRpc;
    if (io.verifyDeps?.txIndex !== undefined) deps.txIndex = io.verifyDeps.txIndex;
    let onlineNotRun: string | undefined;
    if (online) {
      // The CLI loads the verifier itself, from its own optional dependency, so that an npm-installed probarion
      // finds it. An injected null (tests, hosts) means "no verifier", as it does in the SDK.
      const injected = io.verifyDeps?.onlineVerifier;
      const verifier =
        injected !== undefined
          ? injected
          : await loadDefaultOnlineVerifier((specifier) => import(specifier));
      deps.onlineVerifier = verifier;
      if (verifier === null) {
        onlineNotRun =
          injected === null
            ? "no online verifier was given"
            : "@nearai/inference-sdk could not be loaded; probarion installs it as an optional dependency, and it declares Node 24.22.1 or newer";
        io.err(`warning: ${onlineDidNotRun(onlineNotRun)}\n`);
      }
    }
    const pb = new Probarion(
      {
        network: parsed.network,
        vault: parsed.vault,
        model: null,
        ledger: new FileLedgerStore(parsed.ledgerPath),
      },
      deps,
    );
    let report: VerifyReport;
    if (o.snapshot === undefined) {
      // One gather, and the SDK's notes on what it could not look up stay in the details.
      report = await pb.verify({ online });
    } else {
      const snapshot = await pb.snapshot({ online });
      await saveSnapshot(target ?? resolve(io.cwd, o.snapshot), o.snapshot, snapshot);
      report = await pb.verify({ snapshot, online });
    }
    print(io, o, report, onlineNotRun === undefined ? { online } : { online, onlineNotRun });
  });
}

/** Written with "wx": a file that appeared after the check is refused too, never replaced. */
async function saveSnapshot(path: string, given: string, snapshot: Snapshot): Promise<void> {
  await writeNewFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "--snapshot", given);
}

function print(io: CliIo, o: VerifyOpts, report: VerifyReport, opts: RenderOptions): void {
  io.out(o.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, opts));
  io.setExitCode(verifyExitCode(report));
}
