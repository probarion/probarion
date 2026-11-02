// The OWNER's `pnpm --filter @probarion/web rotate-keys [--apply]` (scripts/rotate-keys.ts wraps this).
// Runbook: docs/ops/key-rotation.md. No "server-only" import: it runs under tsx in a shell.
import { parseMasterKey, sameKey } from "@/lib/crypto/sodium";
import { type Db, DbError } from "@/lib/db/port";
import { RotationRefusedError, rotateAll } from "./rotate";

export interface RotateCliDeps {
  /** Builds the service-role database client. Called only after every input check passed. */
  makeDb(url: string, serviceRoleKey: string): Db;
  out(line: string): void;
  err(line: string): void;
}

const NAMES = [
  "OLD_KEY_ENCRYPTION_SECRET",
  "NEW_KEY_ENCRYPTION_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
type Name = (typeof NAMES)[number];

const HINT: Partial<Record<Name, string>> = {
  OLD_KEY_ENCRYPTION_SECRET: " (the KEY_ENCRYPTION_SECRET the app runs with now)",
  NEW_KEY_ENCRYPTION_SECRET:
    ": generate it and store it in your secret manager first (docs/ops/key-rotation.md). This script never generates one.",
};

/**
 * Exit codes: 0 done (a clean dry run, or an apply); 1 a dry run that is not clean, a refused apply or a
 * failure; 2 bad input (a missing or malformed variable, equal masters, an unknown argument), before the
 * database is touched. Output is one JSON line of counts; errors name a variable or a code, never a value.
 */
export async function runRotateCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: RotateCliDeps,
): Promise<number> {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else {
      // Not echoed: a mistyped command line may carry a pasted key.
      deps.err(
        "rotate-keys: unknown argument (only --apply is accepted; the default is a dry run)",
      );
      return 2;
    }
  }

  const values: Partial<Record<Name, string>> = {};
  for (const name of NAMES) {
    const v = env[name]?.trim(); // R12: an empty value counts as unset
    if (!v) {
      deps.err(`rotate-keys: ${name} is required${HINT[name] ?? ""}`);
      return 2;
    }
    values[name] = v;
  }

  const masters: Uint8Array[] = [];
  for (const name of ["OLD_KEY_ENCRYPTION_SECRET", "NEW_KEY_ENCRYPTION_SECRET"] as const) {
    try {
      masters.push(parseMasterKey(values[name] as string));
    } catch {
      deps.err(`rotate-keys: ${name} must be 32 bytes encoded as base64`);
      return 2;
    }
  }
  const [oldMaster, newMaster] = masters as [Uint8Array, Uint8Array];
  if (await sameKey(oldMaster, newMaster)) {
    deps.err(
      "rotate-keys: OLD_KEY_ENCRYPTION_SECRET and NEW_KEY_ENCRYPTION_SECRET are the same key: a rotation needs a new one",
    );
    return 2;
  }

  try {
    const db = deps.makeDb(
      values.SUPABASE_URL as string,
      values.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const report = await rotateAll(db, oldMaster, newMaster, { apply });
    deps.out(JSON.stringify(report));
    if (!report.ok) {
      deps.err(
        "rotate-keys: the dry run is not clean (see unreadable / mismatched); --apply would be refused",
      );
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof RotationRefusedError) {
      deps.out(JSON.stringify(error.report));
      deps.err("rotate-keys: --apply refused: the dry run was not clean, and nothing was written");
      return 1;
    }
    // A code of ours (rotation_conflict, permission_denied, db_error), or the error's class: never its
    // message, which could quote a URL, a key or a row.
    const what = error instanceof DbError ? `database error ${error.code}` : `${errorName(error)}`;
    deps.err(
      `rotate-keys: failed (${what}). The write is all or nothing; run the dry run again to see which master opens the rows.`,
    );
    return 1;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "error";
}
