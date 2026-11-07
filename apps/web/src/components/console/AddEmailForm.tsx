"use client";

import { useActionState } from "react";
import type { AlertsState } from "@/app/console/[vault]/alerts/actions";
import { buttonClass, inputClass, Notice } from "@/components/ui";

type Action = (prev: AlertsState, formData: FormData) => Promise<AlertsState>;

/** The email box of the Alerts tab. The action re-checks the role on the server and answers a sentence. */
export function AddEmailForm({ add }: { add: Action }) {
  const [state, action, pending] = useActionState(add, null);
  return (
    <form action={action}>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputClass} max-w-sm`}
          type="email"
          name="email"
          placeholder="finance@example.com"
          aria-label="Email address"
          autoComplete="email"
          maxLength={254}
          required
        />
        <button className={buttonClass} type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send confirmation"}
        </button>
      </div>
      {state === null ? null : (
        <div className="mt-3">
          <Notice tone={state.ok ? "good" : "bad"}>{state.ok ? state.message : state.error}</Notice>
        </div>
      )}
    </form>
  );
}
