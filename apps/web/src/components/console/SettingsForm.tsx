"use client";

import { useActionState } from "react";
import type { SettingsState } from "@/app/console/[vault]/actions";
import { Notice } from "@/components/ui";
import type { TenantKind } from "@/lib/db/tenants";

type Action = (prev: SettingsState, formData: FormData) => Promise<SettingsState>;

function Result({ state }: { state: SettingsState }) {
  if (state === null) return null;
  return state.ok ? (
    <Notice tone="good">{state.message}</Notice>
  ) : (
    <Notice tone="bad">{state.error}</Notice>
  );
}

const pill =
  "rounded-full bg-[#0B0B0C] px-4 py-1.5 text-sm font-medium text-[#F7F6F3] disabled:opacity-50";

/** The owner's settings. Both actions re-check the owner role on the server. */
export function SettingsForm({
  vault,
  kind,
  zeroRetention,
  proofPublic,
  save,
  refresh,
}: {
  vault: string;
  /** The tenant's kind: the Canary's ledger is private, so it is not offered a public proof page. */
  kind: TenantKind;
  zeroRetention: boolean;
  proofPublic: boolean;
  save: Action;
  refresh: Action;
}) {
  const [saved, saveAction, saving] = useActionState(save, null);
  const [synced, syncAction, syncing] = useActionState(refresh, null);
  return (
    <div className="text-sm">
      <form action={saveAction}>
        <label className="mb-2 block">
          <input type="checkbox" name="zero_retention" defaultChecked={zeroRetention} />{" "}
          Zero-retention: keep only each invoice&apos;s hash, discard its content after the decision
        </label>
        {kind === "canary" ? (
          <p className="mb-2 text-xs text-[#0B0B0C]/60">
            The Canary&apos;s ledger is private: visitors&apos; words never become public.
          </p>
        ) : (
          <label className="mb-2 block">
            <input type="checkbox" name="proof_public" defaultChecked={proofPublic} /> Public proof
            page (ledger, anchors and checks visible to anyone at /proof/{vault})
          </label>
        )}
        <button className={pill} type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        <Result state={saved} />
      </form>
      <form action={syncAction} className="mt-4 border-t border-[#0B0B0C]/10 pt-3">
        <p className="mb-2 text-xs text-[#0B0B0C]/60">
          The approvers are read from the vault&apos;s on-chain config when it is registered.
        </p>
        <button className="text-sm underline disabled:opacity-50" type="submit" disabled={syncing}>
          {syncing ? "Reading the chain…" : "Re-sync approvers from the chain"}
        </button>
        <Result state={synced} />
      </form>
    </div>
  );
}
