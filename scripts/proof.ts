import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  addTx,
  emptyProof,
  getValue,
  readProof,
  type Scalar,
  SECTIONS,
  SIGNED_BY,
  type SignedBy,
  setValue,
  TX_KINDS,
  type TxKind,
  writeProof,
} from "./lib/proof.js";

export const PROOF_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "mainnet-proof.json",
);

function usage(): string {
  return [
    "usage:",
    "  pnpm proof init",
    "  pnpm proof add-tx --id <id> --hash <base58> [--network mainnet|testnet] --signer <account> --receiver <account>",
    '                    --kind <kind> --signed-by <who> --what "<one line>" [--expect success|failure]',
    "                    [--error-code <Code>] [--spend-id <n>] [--amount <usdc>] [--base-tx <0x...>]",
    '  pnpm proof set <section>.<key> <value> --source "<command or URL>" [--type string|number|boolean]',
    "  pnpm proof show",
    `kinds: ${TX_KINDS.join(", ")}`,
    `signed-by: ${SIGNED_BY.join(", ")}`,
    `sections: ${SECTIONS.join(", ")}`,
  ].join("\n");
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const SPEND_ID_RE = /^\d+$/;

export function main(argv: string[], now: Date = new Date(), path: string = PROOF_PATH): number {
  const [command, ...rest] = argv;
  try {
    if (command === "init") {
      if (existsSync(path)) {
        console.error(`${path} already exists`);
        return 1;
      }
      writeProof(path, emptyProof(now));
      console.log(`created ${path}`);
      return 0;
    }
    if (command === "add-tx") {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        options: {
          id: { type: "string" },
          hash: { type: "string" },
          network: { type: "string", default: "mainnet" },
          signer: { type: "string" },
          receiver: { type: "string" },
          kind: { type: "string" },
          "signed-by": { type: "string" },
          what: { type: "string" },
          expect: { type: "string", default: "success" },
          "error-code": { type: "string" },
          "spend-id": { type: "string" },
          amount: { type: "string" },
          "base-tx": { type: "string" },
        },
      });
      const missing = (
        ["id", "hash", "signer", "receiver", "kind", "signed-by", "what"] as const
      ).filter((k) => !values[k]);
      if (missing.length) {
        console.error(`missing --${missing.join(", --")}\n${usage()}`);
        return 2;
      }
      const spendId = values["spend-id"];
      if (
        spendId !== undefined &&
        !(SPEND_ID_RE.test(spendId) && Number.isSafeInteger(Number(spendId)))
      ) {
        console.error(`--spend-id must be a non-negative integer, got "${spendId}"`);
        return 2;
      }
      const next = addTx(
        readProof(path),
        values.id as string,
        {
          hash: values.hash as string,
          network: values.network as "mainnet" | "testnet",
          signer_id: values.signer as string,
          receiver_id: values.receiver as string,
          kind: values.kind as TxKind,
          what: values.what as string,
          signed_by: values["signed-by"] as SignedBy,
          expect: values.expect as "success" | "failure",
          error_code: values["error-code"] ?? null,
          spend_id: spendId === undefined ? null : Number(spendId),
          amount_usdc: values.amount ?? null,
          base_tx: values["base-tx"] ?? null,
        },
        now,
      );
      writeProof(path, next);
      console.log(`recorded txs.${values.id}`);
      return 0;
    }
    if (command === "set") {
      const { values, positionals } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: true,
        options: { source: { type: "string" }, type: { type: "string", default: "string" } },
      });
      const [key, raw] = positionals;
      if (!key || raw === undefined || !values.source) {
        console.error(usage());
        return 2;
      }
      let value: Scalar = raw;
      if (values.type === "number") {
        value = NUMBER_RE.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isFinite(value)) {
          console.error(`not a number: "${raw}" (digits with an optional minus sign and decimals)`);
          return 2;
        }
      } else if (values.type === "boolean") {
        if (raw !== "true" && raw !== "false") {
          console.error("a boolean must be true or false");
          return 2;
        }
        value = raw === "true";
      } else if (values.type !== "string") {
        console.error("--type must be string, number or boolean");
        return 2;
      }
      const before = readProof(path);
      const previous = getValue(before, key);
      writeProof(path, setValue(before, key, value, values.source, now));
      console.log(
        `set ${key} = ${String(value)}${previous === undefined ? "" : ` (was ${String(previous)})`}`,
      );
      return 0;
    }
    if (command === "show") {
      const p = readProof(path);
      console.log(`updated_at ${p.updated_at}`);
      for (const [id, t] of Object.entries(p.txs).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(
          `${id.padEnd(32)} ${t.network.padEnd(8)} ${t.expect.padEnd(8)} ${t.hash}  ${t.what}`,
        );
      }
      for (const s of SECTIONS)
        for (const [k, v] of Object.entries(p[s])) console.log(`${s}.${k} = ${String(v)}`);
      return 0;
    }
    console.error(usage());
    return 2;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
