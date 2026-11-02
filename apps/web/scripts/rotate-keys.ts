/**
 * OWNER only. Re-seals every agent/ledger key and every retained invoice under a new master key.
 * Runbook: docs/ops/key-rotation.md. Read it first: it never generates the new master, and losing that
 * master after --apply loses every sealed secret.
 *
 *   # both masters come from your secret manager; nothing is typed on the command line
 *   OLD_KEY_ENCRYPTION_SECRET=… NEW_KEY_ENCRYPTION_SECRET=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     pnpm --filter @probarion/web rotate-keys            # dry run: verifies every row, writes nothing
 *   … pnpm --filter @probarion/web rotate-keys --apply    # writes, only after a clean dry run in the same process
 *
 * Prints one JSON line of counts. Exit 0 = done, 1 = not clean / refused / failed, 2 = bad input.
 */
import { createClient } from "@supabase/supabase-js";
import { type Db, toDbError } from "../src/lib/db/port";
import { runRotateCli } from "../src/lib/keys/rotate-cli";

function makeDb(url: string, serviceRoleKey: string): Db {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async rpc<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
      const { data, error } = await client.rpc(fn, { p });
      if (error) throw toDbError(error);
      return data as T;
    },
  };
}

process.exitCode = await runRotateCli(process.argv.slice(2), process.env, {
  makeDb,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
