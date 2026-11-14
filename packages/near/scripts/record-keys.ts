// Opt-in recorder for the N3 fixtures. It reads public NEAR state with view queries and signs nothing; unit tests
// never run it (they read what it wrote). It writes two files under test/fixtures/keys/:
//
//   mainnet-v0.json              v0.probarion.near on mainnet: view_account at final, then view_access_key_list and
//                                view_access_key of every listed key at that view's block hash (one block for all)
//   testnet-factory-vault.json   smoke-embedded.vaults.probarion.testnet (a vault the testnet factory created), read
//                                the same way
//
//   pnpm --filter @probarion/near run record:keys
//
// RPC method: query, with request_type view_account, view_access_key_list or view_access_key (ALLOWED_REQUESTS: any
// other call throws before it is sent). Each file is checked with the audit before it is written, so a run that
// records something the audit cannot read fails instead.
import { mkdir, writeFile } from "node:fs/promises";
import { auditAccessKeys, parseAccessKey } from "../src/access-keys.js";
import { codeIdentityOf } from "../src/code-identity.js";
import { httpJsonRpc, type NearRpc } from "../src/rpc.js";

const ALLOWED_REQUESTS: readonly string[] = [
  "view_account",
  "view_access_key_list",
  "view_access_key",
];
const OUT_DIR = new URL("../test/fixtures/keys/", import.meta.url);

interface Target {
  file: string;
  network: "mainnet" | "testnet";
  rpcUrl: string;
  accountId: string;
  what: string;
}

const TARGETS: readonly Target[] = [
  {
    file: "mainnet-v0.json",
    network: "mainnet",
    rpcUrl: "https://rpc.mainnet.fastnear.com",
    accountId: "v0.probarion.near",
    what: "Probarion's mainnet vault",
  },
  {
    file: "testnet-factory-vault.json",
    network: "testnet",
    rpcUrl: "https://rpc.testnet.fastnear.com",
    accountId: "smoke-embedded.vaults.probarion.testnet",
    what: "the smoke vault that the testnet factory vaults.probarion.testnet created",
  },
];

type Json = Record<string, unknown>;

/** Allows `query` with the three view request types and nothing else. */
function guarded(rpc: NearRpc): NearRpc {
  return {
    call<T = unknown>(method: string, params: unknown): Promise<T> {
      const request = (params as Json | null)?.request_type;
      if (
        method !== "query" ||
        typeof request !== "string" ||
        !ALLOWED_REQUESTS.includes(request)
      ) {
        throw new Error(`record-keys: refusing ${method} ${String(request)}`);
      }
      return rpc.call<T>(method, params);
    },
  };
}

async function record(target: Target): Promise<Json> {
  const rpc = guarded(httpJsonRpc(target.rpcUrl));
  const account = await rpc.call<Json>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: target.accountId,
  });
  const blockHash = account.block_hash;
  if (typeof blockHash !== "string") throw new Error("record-keys: view_account has no block_hash");
  const list = await rpc.call<Json>("query", {
    request_type: "view_access_key_list",
    block_id: blockHash,
    account_id: target.accountId,
  });
  if (list.block_hash !== blockHash)
    throw new Error("record-keys: the key list is for another block");
  const keys = Array.isArray(list.keys) ? (list.keys as Json[]) : [];
  const single: Json[] = [];
  for (const key of keys) {
    const publicKey = String(key.public_key);
    const view = await rpc.call<Json>("query", {
      request_type: "view_access_key",
      block_id: blockHash,
      account_id: target.accountId,
      public_key: publicKey,
    });
    parseAccessKey(view, publicKey);
    single.push({ public_key: publicKey, result: view });
  }
  const audit = auditAccessKeys(target.accountId, list);
  if (audit.findings.some((f) => f.code === "malformed_list")) {
    throw new Error(`record-keys: the audit cannot read the key list of ${target.accountId}`);
  }
  if (codeIdentityOf(account).kind === "malformed") {
    throw new Error(`record-keys: the code identity of ${target.accountId} does not read`);
  }
  const at = new Date().toISOString();
  return {
    _source: `${target.what}, ${target.accountId} on NEAR ${target.network}, read on ${at} from ${target.rpcUrl} by packages/near/scripts/record-keys.ts: method query, view_account at finality final, then view_access_key_list and view_access_key of each listed key at block ${String(list.block_height)} (${blockHash}), the block of the view_account answer. View queries of public state; nothing was signed or sent.`,
    network: target.network,
    account_id: target.accountId,
    view_account: account,
    view_access_key_list: list,
    view_access_key: single,
  };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  for (const target of TARGETS) {
    const fixture = await record(target);
    await writeFile(new URL(target.file, OUT_DIR), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote test/fixtures/keys/${target.file}`);
  }
}

if (/record-keys\.ts$/.test(process.argv[1] ?? "")) await main();
