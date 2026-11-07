"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { revokeExtensionAction } from "@/app/extension/actions";
import { dangerButtonClass, Notice } from "@/components/ui";
import type { ExtTokenItem } from "@/lib/ext/store";
import { utcMinute } from "@/lib/payables/forms";

/** When Revoke cannot be reached at all: the connection dropped, or the page was left open across a deploy. */
const UNREACHABLE = "Probarion could not do this now. Try again.";

export function ConnectedBrowsers({ items }: { items: ExtTokenItem[] }) {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  if (items.length === 0)
    return <p className="text-sm text-[#0B0B0C]/60">No browser is connected.</p>;
  return (
    <div className="text-sm">
      <ul>
        {items.map((t) => (
          <li key={t.id} className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span>
              {t.label} <span className="mono">pbx_…{t.hint}</span>
              <span className="block text-xs text-[#0B0B0C]/60">
                Connected {utcMinute(t.created_at)} ·{" "}
                {t.last_used_at ? `last used ${utcMinute(t.last_used_at)}` : "not used yet"} · ends{" "}
                {utcMinute(t.expires_at)}
              </span>
            </span>
            <button
              type="button"
              className={dangerButtonClass}
              onClick={async () => {
                setProblem(null);
                try {
                  const r = await revokeExtensionAction(t.id);
                  if ("error" in r) setProblem(r.error);
                  else router.refresh();
                } catch {
                  setProblem(UNREACHABLE);
                }
              }}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </div>
  );
}
