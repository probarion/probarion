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
          } finally {
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
    <span>
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
      {error ? <span className="ml-2 text-xs text-rose-700">{error}</span> : null}
    </span>
  );
}
