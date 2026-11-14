"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { busyLabel } from "@/components/pending/busy-label";
import { useElapsed } from "@/components/pending/hooks";
import { elapsedClock, hintText } from "@/components/pending/status-line";
import { inkPillClass } from "@/components/ui";
import { signInErrorText } from "@/lib/near/signin";
import {
  SIGN_IN_LABELS,
  SIGN_IN_NOT_READY_LABEL,
  SIGN_IN_PHASE_LABEL,
  SIGN_IN_WALLET_LINE,
  type SignInPhase,
  slowHint,
} from "@/lib/ui/pending";
import { useWallet } from "./WalletProvider";

const LABEL = "Sign in with NEAR wallet";
/** Every label the button can show, its own included, so it keeps one width from the first render to the last. */
const SIZES = [LABEL, ...SIGN_IN_LABELS];

/**
 * Says each step as it happens: "Check your wallet…" (the selector and the signature), "Checking your signature…" (the
 * console), "Opening your console…". While busy it keeps the focus (aria-disabled) and a click does nothing. Its one
 * status region, mounted from the first render, carries the wallet's line, its hint at 20 s and the error. The line
 * and its clock start when the wallet is asked to sign, not at the click: the console fetches the challenge between.
 */
export function SignInButton({ next = "/console" }: { next?: string }) {
  const { ready, signIn } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "select" is the click until the wallet is asked to sign: the selector, then the console fetching the challenge. It
  // reads "Check your wallet…" like the signature, but the wallet's line, clock and hint wait for the signature.
  const [phase, setPhase] = useState<SignInPhase | "select">("select");
  const label = SIGN_IN_PHASE_LABEL[phase === "select" ? "wallet" : phase];
  const running = useRef(false); // a busy button still takes clicks: two must not both ask the wallet
  const elapsed = useElapsed(busy, phase);
  const asking = busy && phase === "wallet";
  const hint = asking ? slowHint("wallet", elapsed) : null;
  return (
    <div>
      <button
        type="button"
        className={`${inkPillClass} disabled:opacity-65 has-[[data-busy]]:cursor-progress`}
        disabled={!ready}
        aria-disabled={busy || undefined}
        onClick={async () => {
          if (running.current) return;
          running.current = true;
          setPhase("select");
          setBusy(true);
          setError(null);
          try {
            await signIn({ onPhase: setPhase });
            // A full load: a link on this page may have prefetched /console as a redirect to /login, and router.push
            // would follow that cached answer and stay here.
            window.location.assign(next);
          } catch (e) {
            setError(signInErrorText(e));
            // Only here: after a success the button stays busy until the page leaves, so a second click cannot ask the
            // wallet to sign again.
            running.current = false;
            setBusy(false);
          }
        }}
      >
        {ready
          ? busyLabel(LABEL, label, busy, SIZES)
          : busyLabel(SIGN_IN_NOT_READY_LABEL, SIGN_IN_NOT_READY_LABEL, true, SIZES)}
      </button>
      <div role="status">
        {asking ? (
          <p className="mt-2 animate-pending-in text-sm text-mute">
            {SIGN_IN_WALLET_LINE}
            {/* once the hint is there, its clock is the one that runs */}
            {hint ? null : elapsedClock(elapsed)}
          </p>
        ) : null}
        {hint ? (
          <p key="hint" className="mt-2 text-sm">
            {hintText(hint, elapsed)}
          </p>
        ) : null}
        {error ? <p className="mt-2 text-sm text-bad">{error}</p> : null}
      </div>
    </div>
  );
}

export function SignOutButton() {
  const { signOut } = useWallet();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="relative">
      <button
        type="button"
        className="text-sm text-mute underline"
        onClick={async () => {
          setError(null);
          try {
            await signOut();
            router.push("/");
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Sign out
      </button>
      {error ? (
        <span className="absolute top-full right-0 z-10 mt-1 w-max max-w-64 whitespace-normal bg-paper text-right text-xs text-bad">
          {error}
        </span>
      ) : null}
    </span>
  );
}
