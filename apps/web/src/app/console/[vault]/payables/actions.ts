"use server";

import { revalidatePath } from "next/cache";
import { fullAccessKeyVerifier, rpcLoginProvider } from "@/lib/auth/verify";
import { type ActionDenied, isDenied, memberForAction } from "@/lib/console/action-auth";
import { masterKey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { setTenantSettings } from "@/lib/db/tenants";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { getReader, getRpc } from "@/lib/near/server";
import {
  type ConfirmDeps,
  type ConfirmResult,
  confirmInvoice,
  type PrepareResult,
  prepareConfirmation,
  rejectWaitingInvoice,
} from "@/lib/payables/confirm";
import type { RowSnapshot } from "@/lib/payables/store";
import { makeTenantProbarion } from "@/lib/sdk/factory";

// `vault`, the invoice id, the nonce, the signature and the snapshot all come back from the browser, so they are only
// lookup keys and claims to check: the tenant and the role come from the membership row for (vault, signed-in
// account), through memberForAction, never from the form. Confirm and Reject are owner only. Next checks a server
// action's origin itself, which covers CSRF.

/** Owner only. A form action: it answers nothing, and the page shows the setting as saved. */
export async function setZeroRetentionAction(vault: string, formData: FormData): Promise<void> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return;
  await setTenantSettings(serviceDb(), auth.member.tenant_id, {
    zeroRetention: formData.get("zero_retention") === "on",
  });
  revalidatePath(`/console/${auth.member.vault_id}/payables`);
}

/** The production wiring of the confirm service: the shared RPC client, read at finality "final" for the key. */
function confirmDeps(): ConfirmDeps {
  return {
    db: serviceDb(),
    master: masterKey(),
    reader: getReader(),
    keyVerifier: fullAccessKeyVerifier(rpcLoginProvider(getRpc())),
    network: getEnv().NEAR_NETWORK,
    makeProbarion: (o) => makeTenantProbarion(o),
  };
}

const SERVER_FAILED =
  "The server could not finish the check. If the invoice still waits for you, nothing was sent: reload the page.";

/** Owner only. A nonce for the row as the owner sees it, and the exact message the wallet will sign. */
export async function prepareConfirmAction(
  vault: string,
  invoiceId: string,
): Promise<PrepareResult | ActionDenied> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return auth;
  try {
    return await prepareConfirmation(confirmDeps(), {
      member: auth.member,
      account: auth.session.accountId,
      invoiceId,
    });
  } catch (error) {
    log.error("payables.confirm_prepare_failed", {
      tenant: auth.member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, reason: "failed", text: SERVER_FAILED };
  }
}

/** Owner only. The wallet's NEP-413 answer for a prepared confirmation: checked, then the invoice is paid. */
export async function confirmInvoiceAction(
  vault: string,
  invoiceId: string,
  nonce: string,
  signed: unknown,
): Promise<ConfirmResult | ActionDenied> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return auth;
  try {
    const r = await confirmInvoice(confirmDeps(), {
      member: auth.member,
      account: auth.session.accountId,
      invoiceId,
      nonce,
      signed,
    });
    revalidatePath(`/console/${auth.member.vault_id}/payables`);
    return r;
  } catch (error) {
    log.error("payables.confirm_action_failed", {
      tenant: auth.member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, reason: "failed", text: SERVER_FAILED };
  }
}

/** Owner only. Rejects the row if it still is exactly as the owner saw it (`seen`). Unsigned: it moves no money. */
export async function rejectInvoiceAction(
  vault: string,
  invoiceId: string,
  seen: RowSnapshot,
): Promise<{ ok: boolean; text: string } | ActionDenied> {
  const auth = await memberForAction(vault, ["owner"]);
  if (isDenied(auth)) return auth;
  try {
    const r = await rejectWaitingInvoice(
      { db: serviceDb() },
      { member: auth.member, account: auth.session.accountId, invoiceId, seen },
    );
    revalidatePath(`/console/${auth.member.vault_id}/payables`);
    return r;
  } catch (error) {
    log.error("payables.reject_action_failed", {
      tenant: auth.member.tenant_id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return {
      ok: false,
      text: "The server could not finish the rejection. Reload the page to see whether the invoice still waits.",
    };
  }
}
