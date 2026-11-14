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
import { confirmTxAction, sendBaselineAction } from "@/lib/near/confirm-action";
import type { TxResult } from "@/lib/near/outcome";
import { type SendDeps, type SendWallet, sendWalletTx } from "@/lib/near/send";
import { type Nep413Wallet, type SignedMessage, signInWithWallet } from "@/lib/near/signin";
import type { WalletTx } from "@/lib/near/tx";
import type { SignInPhase } from "@/lib/ui/pending";
import { type ConnectorLike, connectorFor } from "./connector";

type WalletLike = Nep413Wallet & SendWallet;

/** What a send tells its button along the way: "confirm" once the wallet answered with a transaction. */
export interface SendOptions {
  onPhase?: SendDeps["onPhase"];
}

/** What sign-in tells its button along the way: "wallet", "verify", then "open" (lib/near/signin.ts). */
export interface SignInOptions {
  onPhase?: (phase: SignInPhase) => void;
}

interface WalletCtx {
  ready: boolean;
  /** The account the connected wallet is signed in as. Not the same as the session cookie. */
  accountId: string | null;
  signIn(opts?: SignInOptions): Promise<string>;
  signOut(): Promise<void>;
  /**
   * Asks the connected wallet for a NEP-413 message signature (the owner's confirmation of an invoice payment). It
   * signs a message and sends nothing; the server checks the signature over its own copy of the message.
   */
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<SignedMessage>;
  /**
   * Asks the wallet to sign and send once, then reads the result from the chain. It never throws and
   * never sends the same transaction twice: a result it cannot confirm comes back as `unknown`. `onPhase` only changes
   * what the button says.
   */
  sendTx(tx: WalletTx, signerId?: string, opts?: SendOptions): Promise<TxResult>;
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
        const c = await connectorFor(network);
        // React StrictMode runs this effect twice in dev: only the live run attaches to the connector.
        if (!alive) return;
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
        // Restoring a connected wallet waits for the wallet code, which is a network fetch. Do
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

  const signIn = useCallback(
    async (opts?: SignInOptions) => {
      const id = await signInWithWallet(await wallet(), undefined, opts?.onPhase);
      setAccountId(id);
      return id;
    },
    [wallet],
  );

  const signMessage = useCallback(
    async (p: { message: string; recipient: string; nonce: Uint8Array }) =>
      (await wallet()).signMessage(p),
    [wallet],
  );

  const signOut = useCallback(async () => {
    // End our session first; if that fails, say so and leave the wallet alone.
    const res = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!res.ok) throw new Error(`Could not end your session (${res.status})`);
    await connector.current?.disconnect().catch(() => undefined);
    setAccountId(null);
  }, []);

  const sendTx = useCallback(
    (tx: WalletTx, signerId?: string, opts?: SendOptions): Promise<TxResult> =>
      sendWalletTx(
        {
          network,
          getWallet: wallet,
          baseline: () => sendBaselineAction(),
          confirm: (request) => confirmTxAction(request),
          onPhase: opts?.onPhase,
        },
        tx,
        signerId,
      ),
    [wallet, network],
  );

  const value = useMemo(
    () => ({ ready, accountId, signIn, signOut, signMessage, sendTx }),
    [ready, accountId, signIn, signOut, signMessage, sendTx],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
