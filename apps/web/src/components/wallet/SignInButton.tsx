"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { inkPillClass } from "@/components/ui";
import { useWallet } from "./WalletProvider";

export function SignInButton({ next = "/console" }: { next?: string }) {
  const { ready, signIn } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={`${inkPillClass} disabled:opacity-50`}
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await signIn();
            // A full load: a link on this page may have prefetched /console as a redirect to /login, and router.push
            // would follow that cached answer and stay here.
            window.location.assign(next);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            // Only here: after a success the button stays busy until the page leaves, so a second click cannot ask the
            // wallet to sign again.
            setBusy(false);
          }
        }}
      >
        {ready ? (busy ? "Check your wallet…" : "Sign in with NEAR wallet") : "Loading wallets…"}
      </button>
      {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
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
        className="text-sm text-stone-600 underline"
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
        <span className="absolute top-full right-0 z-10 mt-1 w-max max-w-64 whitespace-normal bg-paper text-right text-xs text-rose-700">
          {error}
        </span>
      ) : null}
    </span>
  );
}
