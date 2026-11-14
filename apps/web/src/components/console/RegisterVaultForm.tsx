"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { registerVaultAction } from "@/app/console/actions";
import { busyLabel } from "@/components/pending/busy-label";
import { useElapsed } from "@/components/pending/hooks";
import { buttonClass, inputClass, Notice } from "@/components/ui";
import { ACTION_READ_TIMEOUT_MS, slowHint, TX_PHASE_LABEL } from "@/lib/ui/pending";
import { handFocus, readAction } from "@/lib/ui/server-action";
import { staleNoticeClass } from "./form-look";
import { hintLine, tryAgainButton } from "./form-run";

const CHECKING = "Checking the chain…";
const REFRESHING = TX_PHASE_LABEL.refresh;

/** What the form shows: the register's answer, or the console's own when the call gave none, with a Try again. */
type Msg = { tone: "good" | "bad"; text: string; retry?: true };

// Registering a vault reads its config from the chain and records it, and registering the same vault again only reads
// it again, so a call that gave no answer offers Try again. One the console stopped waiting for may still finish, so
// the timeout line does not say that nothing changed.
const TIMED_OUT = `The chain did not answer in ${ACTION_READ_TIMEOUT_MS / 1000} s. The vault may still be registered: reload the page to see, or try again.`;
const FAILED = "The console could not register it right now. Try again.";

/** Register a vault that already exists on chain. One attempt at a time; the console waits 20 s at most for it. */
export function RegisterVaultForm({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const [vault, setVault] = useState("");
  /** The button that started the attempt that runs, or null. */
  const [busy, setBusy] = useState<"button" | "retry" | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [refreshing, startRefresh] = useTransition();
  // A ref, not the state: a second press can come before the render that shows the first.
  const running = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const elapsed = useElapsed(busy !== null);
  const held = busy !== null || refreshing;

  async function register(via: "button" | "retry") {
    if (running.current || refreshing) return;
    running.current = true;
    setBusy(via);
    try {
      const next = await readAction<Msg>(
        async () => {
          const r = await registerVaultAction(vault);
          return r.ok
            ? { tone: "good", text: `Registered ${r.vaultId}.` }
            : { tone: "bad", text: r.error };
        },
        (why) => ({ tone: "bad", text: why === "timeout" ? TIMED_OUT : FAILED, retry: true }),
      );
      if (!next.retry) handFocus(retry.current, button.current);
      setMsg(next);
      // The list of vaults is read again in a transition: the button says so until the page has it.
      if (next.tone === "good") startRefresh(() => router.refresh());
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void register("button");
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <input
          className={`${inputClass} max-w-sm`}
          value={vault}
          aria-label="Vault account id"
          onChange={(e) => setVault(e.target.value)}
          placeholder={placeholder}
        />
        <button
          ref={button}
          className={buttonClass}
          type="submit"
          aria-disabled={held || undefined}
        >
          {busyLabel(
            "Register existing vault",
            refreshing ? REFRESHING : CHECKING,
            busy === "button" || refreshing,
            [CHECKING, REFRESHING],
          )}
        </button>
      </div>
      <div role="status">
        {msg ? (
          <div className={`mt-2 ${busy !== null ? staleNoticeClass : ""}`}>
            <Notice tone={msg.tone}>
              {msg.text}
              {msg.retry
                ? tryAgainButton({
                    ref: retry,
                    type: "button",
                    busy: busy === "retry",
                    held,
                    onClick: () => void register("retry"),
                  })
                : null}
            </Notice>
          </div>
        ) : null}
        {hintLine(busy !== null ? slowHint("action-read", elapsed) : null, elapsed)}
      </div>
    </form>
  );
}
