// pnpm --filter @probarion/example-402 run demo
// Three calls: a negotiated sale with its payout, a counter below the floor walked away from, and a call the
// mandate refuses. Offline by default (the SDK's test double chain, no network, no keys of yours). With
// PROBARION_VAULT_ID, PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY set, the same calls run on NEAR testnet;
// run `pnpm build` in the repository first for that, since it starts packages/mcp/dist/bin.js.
import { DemoUsageError, runDemo } from "./demo.js";

try {
  const summary = await runDemo({ env: process.env, out: (line) => console.log(line) });
  process.exitCode = summary.ok ? 0 : 1;
} catch (e) {
  if (!(e instanceof DemoUsageError)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}
