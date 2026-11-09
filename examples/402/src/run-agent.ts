// pnpm --filter @probarion/example-402 agent
// Calls PAYWALL_URL (default http://127.0.0.1:4020/forecast) CALLS times (default 21), paying each 402
// through the probarion-mcp server, which it starts over stdio with the vault's two function-call keys.
// Testnet only. Run `pnpm build` in the repository first: this starts packages/mcp/dist/bin.js.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { envValue } from "@probarion/sdk";
import { type CallResult, fetchWithMandate } from "./agent.js";

const env = process.env;
const vault = envValue(env, "PROBARION_VAULT_ID") ?? "";
if ((envValue(env, "NEAR_NETWORK") ?? "testnet") !== "testnet" || !vault.endsWith(".testnet")) {
  console.error("This example runs on testnet only: set PROBARION_VAULT_ID to a .testnet vault.");
  process.exit(2);
}
const url = envValue(env, "PAYWALL_URL") ?? "http://127.0.0.1:4020/forecast";
const calls = Number(envValue(env, "CALLS") ?? "21");

const childEnv: Record<string, string> = { ...getDefaultEnvironment(), NEAR_NETWORK: "testnet" };
for (const name of [
  "PROBARION_VAULT_ID",
  "PROBARION_AGENT_KEY",
  "PROBARION_LEDGER_KEY",
  "PROBARION_LEDGER_PATH",
  "NEAR_RPC_URLS",
]) {
  const value = envValue(env, name);
  if (value !== undefined) childEnv[name] = value;
}

const bin = fileURLToPath(new URL("bin.js", import.meta.resolve("@probarion/mcp")));
const client = new Client({ name: "probarion-402-example", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [bin], env: childEnv }),
);

function describe(n: number, r: CallResult): string {
  const tag = `#${String(n).padStart(2, "0")}`;
  switch (r.kind) {
    case "free":
      return `${tag} ${r.status} without payment`;
    case "no_mandate":
      return `${tag} 402, but no mandate of this vault pays ${r.payee}: nothing was sent`;
    case "paid":
      return `${tag} 402 for ${r.priceUsdc} USDC -> paid, spend ${r.spend.spend_id} ${r.spend.explorer ?? ""} -> ${r.status} ${JSON.stringify(r.body)}`;
    case "refused":
      return `${tag} 402 for ${r.priceUsdc} USDC -> ${r.spend.status} (${r.spend.code}): ${r.spend.note} The contract's own check_spend says: ${r.contract.ok ? "ok" : r.contract.code}.`;
  }
}

let paid = 0;
let refused = 0;
try {
  for (let n = 1; n <= calls; n++) {
    const r = await fetchWithMandate(url, client);
    console.log(describe(n, r));
    if (r.kind === "paid" && r.status === 200) paid += 1;
    if (r.kind === "refused") refused += 1;
  }
  console.log(`\n${paid} calls paid and served, ${refused} refused under the mandate.`);
} finally {
  await client.close();
}
