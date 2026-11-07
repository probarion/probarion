"use server";

import { revalidatePath } from "next/cache";
import type { Network } from "@/lib/config";
import { isDenied, sessionForAction } from "@/lib/console/action-auth";
import { serviceDb } from "@/lib/db/clients";
import { DbError } from "@/lib/db/port";
import { createPairCode, mintToken, revokeToken } from "@/lib/ext/store";
import { cleanLabel, codeHash, newPairCode, newToken, showCode, UUID } from "@/lib/ext/token";
import { log } from "@/lib/log";
import { LIMITS, takeToken } from "@/lib/ratelimit";

// The /extension page's actions. They run for the signed-in account on its session's network, which is the network of
// the address the page is open at (getSession refuses any other). The browser's arguments are untrusted text.

const LIMITED = "Too many tries. Wait ten minutes, then try again.";
const UNAVAILABLE = "Probarion could not do this now. Try again.";

async function allowed(account: string, network: Network): Promise<boolean> {
  const [max, windowSeconds] = LIMITS.extMint;
  return (await takeToken(serviceDb(), `ext:mint:${network}:${account}`, max, windowSeconds))
    .allowed;
}

/** A token for the extension that opened this page; the page posts it to its own window. */
export async function connectExtensionAction(
  label: unknown,
): Promise<
  { token: string; account: string; network: Network; expires_at: string } | { error: string }
> {
  const s = await sessionForAction();
  if (isDenied(s)) return { error: s.error };
  try {
    if (!(await allowed(s.accountId, s.network))) return { error: LIMITED };
    const t = newToken();
    const m = await mintToken(serviceDb(), {
      account: s.accountId,
      network: s.network,
      sha256: t.sha256,
      hint: t.hint,
      label: cleanLabel(label),
    });
    log.info("ext.connected", { account: s.accountId, network: s.network, connection: m.id });
    revalidatePath("/extension");
    return { token: t.token, account: s.accountId, network: s.network, expires_at: m.expires_at };
  } catch (error) {
    log.error("ext.mint_failed", { error });
    return { error: UNAVAILABLE };
  }
}

/** A pairing code the person types into the extension, alive ten minutes. */
export async function showPairCodeAction(): Promise<
  { code: string; expires_at: string } | { error: string }
> {
  const s = await sessionForAction();
  if (isDenied(s)) return { error: s.error };
  try {
    if (!(await allowed(s.accountId, s.network))) return { error: LIMITED };
    // A code another account holds right now is refused as a duplicate: draw again (40 bits, so this is rare).
    for (let i = 0; i < 3; i++) {
      const code = newPairCode();
      try {
        const r = await createPairCode(serviceDb(), s.accountId, s.network, codeHash(code));
        return { code: showCode(code), expires_at: r.expires_at };
      } catch (error) {
        if (error instanceof DbError && error.code === "duplicate") continue;
        throw error;
      }
    }
    return { error: UNAVAILABLE };
  } catch (error) {
    log.error("ext.code_failed", { error });
    return { error: UNAVAILABLE };
  }
}

/** Ends one of the account's own connections. */
export async function revokeExtensionAction(
  id: unknown,
): Promise<{ ok: true } | { error: string }> {
  const s = await sessionForAction();
  if (isDenied(s)) return { error: s.error };
  if (typeof id !== "string" || !UUID.test(id)) return { error: "No such browser." };
  try {
    await revokeToken(serviceDb(), s.accountId, s.network, id);
    revalidatePath("/extension");
    return { ok: true };
  } catch (error) {
    log.error("ext.revoke_failed", { error });
    return { error: UNAVAILABLE };
  }
}
