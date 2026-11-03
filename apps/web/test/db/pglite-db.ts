import type { PGlite } from "@electric-sql/pglite";
import { type Db, toDbError } from "@/lib/db/port";
import { asRole, type Role } from "./harness";

export function pgliteDb(
  pg: PGlite,
  role: Role = "service_role",
  account: string | null = null,
): Db {
  return {
    async rpc<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`bad function name: ${fn}`);
      try {
        const r = await asRole(pg, role, account, (tx) =>
          tx.query<{ r: T }>(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)]),
        );
        const row = r.rows[0];
        if (!row) throw new Error(`rpc ${fn} returned no row`);
        return row.r;
      } catch (e) {
        throw toDbError(e);
      }
    },
  };
}
