/**
 * By hand only, never in CI: asks the testnet vault the four scenarios and writes what it answered to
 * src/lib/site/live-check-recorded.json, the answers the landing page shows with no JavaScript or no RPC.
 *
 *   pnpm --filter @probarion/web record-live-check
 *
 * Reads the chain, signs nothing. Re-run it when the vault's answers change, and commit the file.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkSpendArgs,
  LIVE_RPC_URLS,
  LIVE_VAULT,
  MANDATE_IDS,
  OTHER_PK,
  parseMandate,
  parseUsdc,
  type RecordedFile,
  SCENARIO_INPUTS,
  type ScenarioId,
  viewCall,
} from "../src/lib/site/live-check";

const OUT = fileURLToPath(new URL("../src/lib/site/live-check-recorded.json", import.meta.url));

async function rpc(
  body: unknown,
): Promise<{ result: { keys: RecordedFile["accessKeys"]; block_height: number } }> {
  const res = await fetch(LIVE_RPC_URLS[0] ?? "", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as {
    result: { keys: RecordedFile["accessKeys"]; block_height: number };
  };
}

const mandates: Record<string, unknown> = {};
let height = 0;
for (const id of MANDATE_IDS) {
  const a = await viewCall(LIVE_RPC_URLS, LIVE_VAULT, "get_mandate", { mandate_id: id });
  parseMandate(a.value); // throws on a shape the page could not read
  mandates[String(id)] = a.value;
  height = Math.max(height, a.blockHeight);
}
const agent = parseMandate(mandates["1"]);
if (agent === null) throw new Error("mandate 1 is gone: the page has no agent key to show");

const answers = {} as RecordedFile["answers"];
for (const s of SCENARIO_INPUTS) {
  const units = parseUsdc(s.amount);
  if (units === null) throw new Error(`bad amount in scenario ${s.id}`);
  const key = s.key === "agent" ? agent.agentPk : OTHER_PK;
  const a = await viewCall(
    LIVE_RPC_URLS,
    LIVE_VAULT,
    "check_spend",
    checkSpendArgs(s.mandateId, units, key),
  );
  answers[s.id as ScenarioId] = { value: a.value, blockHeight: a.blockHeight };
  height = Math.max(height, a.blockHeight);
}

const keys = await rpc({
  jsonrpc: "2.0",
  id: "keys",
  method: "query",
  params: { request_type: "view_access_key_list", finality: "final", account_id: LIVE_VAULT },
});

const file: RecordedFile = {
  recordedAt: new Date().toISOString(),
  blockHeight: Math.max(height, keys.result.block_height),
  vault: LIVE_VAULT,
  accessKeys: keys.result.keys,
  mandates,
  answers,
};
writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(JSON.stringify({ wrote: OUT, blockHeight: file.blockHeight, answers }));
