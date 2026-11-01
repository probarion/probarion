import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError } from "@/lib/env";
import { publicDb, serviceDb, supabaseDb } from "./clients";
import { DbError } from "./port";

/** Only `rpc` is used by the port; the rest of the client is out of scope here. */
function fakeClient(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("supabaseDb", () => {
  it("wraps the payload as { p } and returns the data", async () => {
    const { client, rpc } = fakeClient({ data: { allowed: true } });
    const out = await supabaseDb(client).rpc("rate_limit_take", { bucket: "b", max: 1 });
    expect(out).toEqual({ allowed: true });
    expect(rpc).toHaveBeenCalledWith("rate_limit_take", { p: { bucket: "b", max: 1 } });
  });

  it("sends an empty object when there is no payload", async () => {
    const { client, rpc } = fakeClient({ data: [] });
    await supabaseDb(client).rpc("member_tenants");
    expect(rpc).toHaveBeenCalledWith("member_tenants", { p: {} });
  });

  it("returns null data as null (member_role of a stranger)", async () => {
    const { client } = fakeClient({ data: null });
    expect(await supabaseDb(client).rpc("member_role", {})).toBeNull();
  });

  it("maps a PostgREST error to a DbError with the SQL exception text as its code", async () => {
    const { client } = fakeClient({ error: { message: "owner_mismatch", code: "P0001" } });
    await expect(supabaseDb(client).rpc("tenant_register", {})).rejects.toMatchObject({
      name: "DbError",
      code: "owner_mismatch",
    });
  });

  it("maps a permission error to permission_denied", async () => {
    const { client } = fakeClient({
      error: { message: "permission denied for function rate_limit_take", code: "42501" },
    });
    const err: unknown = await supabaseDb(client)
      .rpc("rate_limit_take", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ code: "permission_denied" });
  });
});

describe("serviceDb / publicDb", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuse to build a client without the environment, naming the variable and no value", () => {
    for (const name of [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "KEY_ENCRYPTION_SECRET",
      "CRON_SECRET",
    ]) {
      vi.stubEnv(name, "");
    }
    expect(() => serviceDb()).toThrow(EnvError);
    expect(() => serviceDb()).toThrow(/SUPABASE_URL is required/);
    expect(() => publicDb()).toThrow(EnvError);
  });

  it("build one memoised client each from a valid environment", () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key-for-tests");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-for-tests");
    vi.stubEnv(
      "KEY_ENCRYPTION_SECRET",
      Buffer.from("0123456789abcdef0123456789ABCDEF").toString("base64"),
    );
    vi.stubEnv("CRON_SECRET", "c".repeat(40));
    const service = serviceDb();
    const anon = publicDb();
    expect(typeof service.rpc).toBe("function");
    expect(serviceDb()).toBe(service);
    expect(publicDb()).toBe(anon);
    expect(anon).not.toBe(service);
  });
});
