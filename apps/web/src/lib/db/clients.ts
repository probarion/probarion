import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { type Db, toDbError } from "./port";

export function supabaseDb(client: SupabaseClient): Db {
  return {
    async rpc<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
      const { data, error } = await client.rpc(fn, { p });
      if (error) throw toDbError(error);
      return data as T;
    },
  };
}

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } } as const;
let service: Db | null = null;
let anon: Db | null = null;

/** Service role (secret key): server-only, always after an explicit membership check. */
export function serviceDb(): Db {
  if (!service) {
    const env = getEnv();
    service = supabaseDb(createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION));
  }
  return service;
}

/** Anon (publishable key): may call only public_* security-definer RPCs. */
export function publicDb(): Db {
  if (!anon) {
    const env = getEnv();
    anon = supabaseDb(
      createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, NO_SESSION),
    );
  }
  return anon;
}
