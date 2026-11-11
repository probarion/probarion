// pnpm --filter @probarion/example-402 run agent
// Calls PAYWALL_URL (default http://127.0.0.1:4020/forecast) CALLS times (default 21), paying each 402
// through the probarion-mcp server, which it starts over stdio with the vault's two function-call keys.
// After each paid 200 it appends a receipt line to RECEIPTS_PATH (default examples/402/receipts.jsonl).
// Relative paths in RECEIPTS_PATH and PROBARION_LEDGER_PATH are read from the folder pnpm was started in.
// Testnet only. Run `pnpm build` in the repository first: this starts packages/mcp/dist/bin.js.
import { envValue } from "@probarion/sdk";
import { fetchWithMandate } from "./agent.js";
import { describeCall } from "./describe.js";
import { connectMcp, ledgerLine, receiptsPathOf, testnetVault } from "./mcp-stdio.js";

const env = process.env;
const vault = testnetVault(env);
if (vault === null) {
  console.error("This example runs on testnet only: set PROBARION_VAULT_ID to a .testnet vault.");
  process.exit(2);
}
const url = envValue(env, "PAYWALL_URL") ?? "http://127.0.0.1:4020/forecast";
const calls = Number(envValue(env, "CALLS") ?? "21");
const receiptsPath = receiptsPathOf(env);
console.log(ledgerLine(env, vault));
console.log(`Receipts: ${receiptsPath}`);

const client = await connectMcp(env, "probarion-402-example");

let paid = 0;
let refused = 0;
let pending = 0;
let walked = 0;
try {
  for (let n = 1; n <= calls; n++) {
    const r = await fetchWithMandate(url, client, { receiptsPath });
    console.log(describeCall(`#${String(n).padStart(2, "0")}`, r));
    if (r.kind === "paid" && r.status === 200) paid += 1;
    if (r.kind === "refused") refused += 1;
    if (r.kind === "pending") pending += 1;
    if (r.kind === "walked_away") walked += 1;
  }
  const held = pending > 0 ? `, ${pending} held or unconfirmed` : "";
  const away = walked > 0 ? `, ${walked} walked away from after a refused counter` : "";
  console.log(
    `\n${paid} calls paid and served, ${refused} refused under the mandate${held}${away}.`,
  );
  if (paid > 0) console.log(`Receipts: ${receiptsPath}`);
} finally {
  await client.close();
}
