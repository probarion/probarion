"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { registerVaultAction } from "@/app/console/actions";
import { inputClass, Notice } from "@/components/ui";

export function RegisterVaultForm({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const [vault, setVault] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const r = await registerVaultAction(vault);
          setMsg(
            r.ok
              ? { tone: "good", text: `Registered ${r.vaultId}.` }
              : { tone: "bad", text: r.error },
          );
          if (r.ok) router.refresh();
        } catch {
          setMsg({ tone: "bad", text: "The console could not register it right now. Try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        className={`${inputClass} max-w-sm`}
        value={vault}
        aria-label="Vault account id"
        onChange={(e) => setVault(e.target.value)}
        placeholder={placeholder}
      />
      <button
        className="rounded-full bg-[#0B0B0C] px-4 py-1.5 text-sm font-medium text-[#F7F6F3] disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? "Checking the chain…" : "Register existing vault"}
      </button>
      {msg ? (
        <div className="w-full">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      ) : null}
    </form>
  );
}
