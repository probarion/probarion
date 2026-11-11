// pnpm --filter @probarion/example-402 run demo [--testnet]
// Three calls: a counter below the floor walked away from, a negotiated sale with its payout, and a call the
// mandate refuses. Offline unless --testnet is given, even when keys are in the environment (the SDK's test
// double chain, no network, no keys of yours). With --testnet, and PROBARION_VAULT_ID, PROBARION_AGENT_KEY
// and PROBARION_LEDGER_KEY set, the same calls run on NEAR testnet; run `pnpm build` in the repository first
// for that, since it starts packages/mcp/dist/bin.js.
import { DemoUsageError, runDemo, testnetFlag } from "./demo.js";

try {
  const testnet = testnetFlag(process.argv.slice(2));
  const summary = await runDemo({ env: process.env, out: (line) => console.log(line), testnet });
  process.exitCode = summary.ok ? 0 : 1;
} catch (e) {
  if (!(e instanceof DemoUsageError)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}
