// Example: audit a Probarion vault's lock with the N3 primitives. `auditVault` reads view_account and
// view_access_key_list at one block over any NearRpc, checks the keys against the vault's key shapes (agent keys may
// call `spend` on the vault, ledger keys `anchor`) and the code against a code-hashes record file, and returns the
// report's lines. It reads public state and signs nothing.
//
//   pnpm --filter @probarion/near exec tsx examples/audit-account.ts v0.probarion.near
//
// run directly, it reads mainnet through https://rpc.mainnet.fastnear.com and the repository's
// contracts/code-hashes.json, and prints the lines (exit 0 when the report is ok, 1 when not).
import { readFile } from "node:fs/promises";
import { readAccountLock } from "../src/account-rpc.js";
import type { RecordedBuild } from "../src/code-identity.js";
import { httpJsonRpc, type NearRpc } from "../src/rpc.js";

/** The lines of the account lock report for `accountId` under the vault's key policy and the recorded builds. */
export async function auditVault(
  rpc: NearRpc,
  accountId: string,
  codeHashesJson: { entries: readonly RecordedBuild[] },
): Promise<readonly string[]> {
  const report = await readAccountLock(rpc, accountId, {
    policy: {
      rules: [
        { receiverId: accountId, methods: ["spend"] },
        { receiverId: accountId, methods: ["anchor"] },
      ],
    },
    builds: codeHashesJson,
  });
  return report.lines;
}

if (/audit-account\.ts$/.test(process.argv[1] ?? "")) {
  const accountId = process.argv[2] ?? "v0.probarion.near";
  const codeHashes = JSON.parse(
    await readFile(new URL("../../../contracts/code-hashes.json", import.meta.url), "utf8"),
  ) as { entries: RecordedBuild[] };
  const lines = await auditVault(
    httpJsonRpc("https://rpc.mainnet.fastnear.com"),
    accountId,
    codeHashes,
  );
  for (const line of lines) console.log(line);
  process.exitCode = lines.at(-1)?.startsWith("Verdict: ok") ? 0 : 1;
}
