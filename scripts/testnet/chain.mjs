#!/usr/bin/env node
// Read-only helpers for scripts/testnet/*.sh and docs/runbooks/testnet.md.
//
// jq is not installed with Git Bash on Windows, and this repo already requires Node 24, so the
// scripts read JSON with this file instead. Nothing here signs or sends a transaction, and nothing
// here prints a private key.
//
//   node scripts/testnet/chain.mjs exists <account>               yes | no (exit 0 | 1)
//   node scripts/testnet/chain.mjs balance <account>              the balance, in NEAR
//   node scripts/testnet/chain.mjs enough <account> <near>...     exit 0 if the balance covers the sum plus a gas margin
//   node scripts/testnet/chain.mjs full-access-keys <account>     the full-access public keys, comma separated
//   node scripts/testnet/chain.mjs key-count <account>            the number of access keys
//   node scripts/testnet/chain.mjs code-hash <account>            the base58 code hash of the deployed contract
//   node scripts/testnet/chain.mjs protocol-version <testnet|mainnet>
//   node scripts/testnet/chain.mjs public-key <key-file.json>     the public_key of a near-cli-rs key file
//
// RPC (env) overrides the testnet RPC url for the account queries. Queries use `optimistic` finality
// so that a check right after a transaction sees it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ONE_NEAR = 10n ** 24n;
const GAS_MARGIN = 3n * 10n ** 23n; // 0.3 NEAR for the gas of the ~25 transactions
const RPC_URLS = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

/** "1.8" -> 1_800_000_000_000_000_000_000_000n yoctoNEAR. */
export function parseNear(text) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text);
  if (!m) throw new Error(`not an amount in NEAR: ${text}`);
  return BigInt(m[1]) * ONE_NEAR + BigInt((m[2] ?? "").padEnd(24, "0"));
}

/** 1_800_000_000_000_000_000_000_000n -> "1.8". */
export function formatNear(yocto) {
  const whole = yocto / ONE_NEAR;
  const frac = (yocto % ONE_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The full-access public keys in the `result` of a view_access_key_list query. */
export function fullAccessKeys(result) {
  return (result?.keys ?? [])
    .filter((k) => k.access_key?.permission === "FullAccess")
    .map((k) => k.public_key);
}

/** True when an RPC reply says the account does not exist. */
export function isUnknownAccount(reply) {
  return reply?.error?.cause?.name === "UNKNOWN_ACCOUNT";
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
}

function accountUrl() {
  return process.env.RPC ?? RPC_URLS.testnet;
}

function query(requestType, accountId) {
  return rpc(accountUrl(), "query", {
    request_type: requestType,
    finality: "optimistic",
    account_id: accountId,
  });
}

async function viewAccount(accountId) {
  const reply = await query("view_account", accountId);
  if (isUnknownAccount(reply)) return null;
  if (!reply.result) throw new Error(`view_account ${accountId}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function accessKeys(accountId) {
  const reply = await query("view_access_key_list", accountId);
  if (!reply.result)
    throw new Error(`view_access_key_list ${accountId}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

function need(value, usage) {
  if (!value) throw new Error(`usage: chain.mjs ${usage}`);
  return value;
}

/** Runs one command; returns { out, code }. */
export async function main([cmd, ...args]) {
  switch (cmd) {
    case "exists": {
      const account = await viewAccount(need(args[0], "exists <account>"));
      return { out: account ? "yes" : "no", code: account ? 0 : 1 };
    }
    case "balance": {
      const account = await viewAccount(need(args[0], "balance <account>"));
      if (!account) return { out: "no such account", code: 1 };
      return { out: formatNear(BigInt(account.amount)), code: 0 };
    }
    case "enough": {
      const id = need(args[0], "enough <account> <near>...");
      const amounts = args.slice(1).map(parseNear);
      if (amounts.length === 0) throw new Error("usage: chain.mjs enough <account> <near>...");
      const account = await viewAccount(id);
      if (!account) return { out: `${id} does not exist`, code: 1 };
      const have = BigInt(account.amount);
      const total = amounts.reduce((a, b) => a + b, 0n);
      const out = `${id} has ${formatNear(have)} NEAR; the accounts need ${formatNear(total)} NEAR plus ${formatNear(GAS_MARGIN)} NEAR for gas`;
      return { out, code: have >= total + GAS_MARGIN ? 0 : 1 };
    }
    case "full-access-keys": {
      const keys = fullAccessKeys(await accessKeys(need(args[0], "full-access-keys <account>")));
      return { out: keys.join(","), code: 0 };
    }
    case "key-count": {
      const result = await accessKeys(need(args[0], "key-count <account>"));
      return { out: String(result.keys.length), code: 0 };
    }
    case "code-hash": {
      const account = await viewAccount(need(args[0], "code-hash <account>"));
      if (!account) return { out: "no such account", code: 1 };
      return { out: account.code_hash, code: 0 };
    }
    case "protocol-version": {
      const network = need(args[0], "protocol-version <testnet|mainnet>");
      if (!(network in RPC_URLS)) throw new Error(`unknown network: ${network}`);
      const reply = await rpc(RPC_URLS[network], "status", []);
      return { out: String(reply.result.protocol_version), code: 0 };
    }
    case "public-key": {
      const file = need(args[0], "public-key <key-file.json>");
      const publicKey = JSON.parse(readFileSync(file, "utf8")).public_key;
      if (typeof publicKey !== "string" || !publicKey.startsWith("ed25519:")) {
        throw new Error(`${file} has no ed25519 public_key`);
      }
      return { out: publicKey, code: 0 };
    }
    default:
      throw new Error(
        "usage: chain.mjs exists|balance|enough|full-access-keys|key-count|code-hash|protocol-version|public-key ...",
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    ({ out, code }) => {
      console.log(out);
      process.exitCode = code;
    },
    (e) => {
      console.error(`chain: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 2;
    },
  );
}
