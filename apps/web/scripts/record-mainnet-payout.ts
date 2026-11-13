/**
 * By hand, never in CI: builds the landing page's mainnet payouts from docs/mainnet-proof.json,
 * contracts/deployments/mainnet.json and the evidence folders (lib/site/mainnet-payout-sources.ts), reads each one
 * from public mainnet RPC the way the page does, runs the seven checks and writes
 * src/lib/site/mainnet-payout-recorded.json, what the page shows with no JavaScript or no network.
 *
 *   pnpm --filter @probarion/web record-mainnet-payout
 *
 * Reads the chain, signs nothing. It writes nothing when a read fails or a check does not pass: run it again. Then
 * format the file with
 *   pnpm exec biome format --write apps/web/src/lib/site/mainnet-payout-recorded.json
 * (the repository lint checks its layout) and commit it.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BASE_RPC_URLS,
  CHECKS,
  checkNumber,
  evaluateAll,
  NEAR_RPC_URLS,
  nsToIso,
  type Payout,
  READ_NAMES,
  type ReadName,
  type RecordedFile,
  type RecordedPayout,
  recordedReads,
  rpc,
  startReads,
  trimRead,
} from "../src/lib/site/mainnet-payout";
import { draftPayouts, readSources } from "../src/lib/site/mainnet-payout-sources";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = fileURLToPath(new URL("../src/lib/site/mainnet-payout-recorded.json", import.meta.url));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
function field(v: unknown, ...path: string[]): unknown {
  let x = v;
  for (const k of path) x = isObj(x) ? x[k] : undefined;
  return x;
}

/** The two blocks that the chain alone knows: the spend's NEAR block (the views' pin) and the Base block of the release. */
async function blocks(
  d: ReturnType<typeof draftPayouts>[number],
): Promise<Pick<Payout, "pin" | "base">> {
  const spend = await rpc(NEAR_RPC_URLS, "EXPERIMENTAL_tx_status", {
    tx_hash: d.tx.spend.hash,
    sender_account_id: d.tx.spend.sender,
    wait_until: "NONE",
  });
  const pinHash = field(spend.value, "transaction_outcome", "block_hash");
  if (typeof pinHash !== "string") throw new Error("the spend has no outcome block");
  const block = await rpc(NEAR_RPC_URLS, "block", { block_id: pinHash });
  const height = field(block.value, "header", "height");
  const ns = field(block.value, "header", "timestamp_nanosec");
  if (!Number.isSafeInteger(height) || typeof ns !== "string") throw new Error("unreadable block");
  const receipt = await rpc(BASE_RPC_URLS, "eth_getTransactionReceipt", [d.tx.base]);
  const number = field(receipt.value, "blockNumber");
  if (typeof number !== "string") throw new Error("the Base receipt has no block");
  const baseBlock = await rpc(BASE_RPC_URLS, "eth_getBlockByNumber", [number, false]);
  const ts = field(baseBlock.value, "timestamp");
  if (typeof ts !== "string") throw new Error("the Base block has no timestamp");
  return {
    pin: { hash: pinHash, height: height as number, at: nsToIso(ns) },
    base: {
      block: Number.parseInt(number, 16),
      at: new Date(Number.parseInt(ts, 16) * 1000).toISOString(),
    },
  };
}

async function record(d: ReturnType<typeof draftPayouts>[number]): Promise<RecordedPayout> {
  const payout: Payout = { ...d, ...(await blocks(d)) };
  const pending = startReads(payout);
  const reads = {} as RecordedPayout["reads"];
  const hosts = {} as RecordedPayout["hosts"];
  for (const name of READ_NAMES) {
    const r = await pending[name];
    if (!r.ok)
      throw new Error(`${payout.id}: ${name} could not be read: ${JSON.stringify(r.failures)}`);
    reads[name] = trimRead(name, r.value);
    hosts[name] = r.host;
  }
  const entry: RecordedPayout = { payout, reads, hosts };
  // The checks run on the trimmed reads, as the page runs them on the recorded file.
  const outcomes = evaluateAll(recordedReads(entry), payout);
  const bad = outcomes.flatMap((o, i) =>
    o.state === "pass" ? [] : [`${checkNumber(CHECKS[i]?.id ?? "owner")} ${JSON.stringify(o)}`],
  );
  if (bad.length > 0) throw new Error(`${payout.id}: checks did not pass:\n${bad.join("\n")}`);
  return entry;
}

const drafts = draftPayouts(readSources(ROOT));
if (drafts.length === 0) throw new Error("docs/mainnet-proof.json names no mainnet payout to Base");
const payouts: RecordedPayout[] = [];
for (const d of drafts) payouts.push(await record(d));

const file: RecordedFile = { recordedAt: new Date().toISOString(), payouts };
writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  JSON.stringify({
    wrote: OUT,
    payouts: payouts.map((p) => ({
      id: p.payout.id,
      pin: p.payout.pin,
      base: p.payout.base,
      hosts: Object.fromEntries((Object.keys(p.hosts) as ReadName[]).map((n) => [n, p.hosts[n]])),
    })),
  }),
);
