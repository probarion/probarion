"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Network } from "@/lib/config";
import { parseConnectError, settleSend, type TxResult } from "@/lib/near/outcome";
import { type Nep413Wallet, signInWithWallet } from "@/lib/near/signin";
import type { WalletTx } from "@/lib/near/tx";

/**
 * Our own narrow view of near-connect 0.11.4, so its missing @near-js/* types cannot leak
 * (Verify on first use #1). Matches the installed build/types: `NearWalletBase.signMessage`,
 * `NearWalletBase.signAndSendTransaction(SignAndSendTransactionParams)` and `NearConnector`.
 */
interface WalletLike extends Nep413Wallet {
  signAndSendTransaction(p: {
    network: Network;
    receiverId: string;
    actions: WalletTx["actions"];
    signerId?: string;
  }): Promise<unknown>;
}
interface ConnectorLike {
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  getConnectedWallet(): Promise<{ wallet: unknown; accounts: { accountId: string }[] }>;
  on(event: "wallet:signIn" | "wallet:signOut", callback: (payload: unknown) => void): void;
  off(event: "wallet:signIn" | "wallet:signOut", callback: (payload: unknown) => void): void;
}

interface WalletCtx {
  ready: boolean;
  /** The account the connected wallet is signed in as. Not the same as the session cookie. */
  accountId: string | null;
  signIn(): Promise<string>;
  signOut(): Promise<void>;
  /**
   * Asks the wallet to sign and send once. It never throws and never sends the same transaction
   * twice: an outcome it cannot confirm comes back as `unknown`, for the owner to check.
   */
  sendTx(tx: WalletTx, signerId?: string): Promise<TxResult>;
}

const Ctx = createContext<WalletCtx | null>(null);

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet must be used inside <WalletProvider>");
  return c;
}

const RESTORE_WAIT_MS = 8_000;

function firstAccountId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const accounts = (payload as { accounts?: unknown }).accounts;
  const first: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
  const id =
    typeof first === "object" && first !== null
      ? (first as { accountId?: unknown }).accountId
      : undefined;
  return typeof id === "string" && id !== "" ? id : null;
}

export function WalletProvider({ network, children }: { network: Network; children: ReactNode }) {
  const connector = useRef<ConnectorLike | null>(null);
  const loadError = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let detach: (() => void) | undefined;
    (async () => {
      try {
        const { NearConnector } = await import("@hot-labs/near-connect"); // client-only, never at SSR
        // React StrictMode runs this effect twice in dev: only the live run builds a connector.
        if (!alive) return;
        const c = new NearConnector({ network }) as unknown as ConnectorLike;
        connector.current = c;
        const onSignIn = (payload: unknown) => {
          const id = firstAccountId(payload);
          if (alive && id !== null) setAccountId(id);
        };
        const onSignOut = () => {
          if (alive) setAccountId(null);
        };
        c.on("wallet:signIn", onSignIn);
        c.on("wallet:signOut", onSignOut);
        detach = () => {
          c.off("wallet:signIn", onSignIn);
          c.off("wallet:signOut", onSignOut);
        };
        // Restoring a connected wallet waits for the wallet manifest, which is a network fetch. Do
        // not hold the page on "Loading wallets…" longer than a few seconds if it is slow.
        const restore = c.getConnectedWallet().then(
          ({ accounts }) => {
            if (alive) setAccountId(accounts[0]?.accountId ?? null);
          },
          () => undefined, // no wallet connected yet
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const slow = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RESTORE_WAIT_MS);
        });
        await Promise.race([restore, slow]);
        clearTimeout(timer);
      } catch (e) {
        loadError.current = e instanceof Error ? e.message : String(e);
      }
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
      detach?.();
      connector.current = null;
    };
  }, [network]);

  const wallet = useCallback(async (): Promise<WalletLike> => {
    const c = connector.current;
    if (!c) {
      throw new Error(
        loadError.current
          ? `The wallet connector did not load (${loadError.current}). Reload the page.`
          : "Wallet is still loading",
      );
    }
    try {
      return (await c.getConnectedWallet()).wallet as WalletLike;
    } catch {
      return (await c.connect()) as WalletLike;
    }
  }, []);

  const signIn = useCallback(async () => {
    const id = await signInWithWallet(await wallet());
    setAccountId(id);
    return id;
  }, [wallet]);

  const signOut = useCallback(async () => {
    // End our session first; if that fails, say so and leave the wallet alone.
    const res = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!res.ok) throw new Error(`Could not end your session (${res.status})`);
    await connector.current?.disconnect().catch(() => undefined);
    setAccountId(null);
  }, []);

  const sendTx = useCallback(
    async (tx: WalletTx, signerId?: string): Promise<TxResult> => {
      let w: WalletLike;
      try {
        w = await wallet();
      } catch (e) {
        // No wallet to talk to: nothing was signed, so this is a definite failure.
        return parseConnectError(e);
      }
      // The last call decides the transaction's result, and R12 reads its return value.
      const method = tx.actions.at(-1)?.params.methodName;
      return settleSend(
        () =>
          w.signAndSendTransaction({
            network,
            receiverId: tx.receiverId,
            actions: tx.actions,
            ...(signerId === undefined ? {} : { signerId }),
          }),
        method,
      );
    },
    [wallet, network],
  );

  const value = useMemo(
    () => ({ ready, accountId, signIn, signOut, sendTx }),
    [ready, accountId, signIn, signOut, sendTx],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
