"use client";

import { useState } from "react";
import { connectExtensionAction, showPairCodeAction } from "@/app/extension/actions";
import { buttonClass, Notice } from "@/components/ui";
import type { Network } from "@/lib/config";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "connected" }
  | { kind: "not_taken" }
  | { kind: "code"; code: string; expires: string }
  | { kind: "error"; text: string };

/** When an action cannot be reached at all: the connection dropped, or the page was left open across a deploy. */
const UNREACHABLE = "Probarion could not do this now. Try again.";

function browserLabel(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Linux/.test(ua)
          ? "Linux"
          : "another system";
  return `Chrome on ${os}`;
}

/**
 * Whether the extension's content script marked the page connected, waiting up to `ms`. The mark is read once more when
 * the wait ends, so one set in its last moments still counts.
 */
export async function extensionTookIt(ms: number): Promise<boolean> {
  const marked = () => document.documentElement.dataset.probarionExtension === "connected";
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (marked()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return marked();
}

export function ConnectPanel({
  nonce,
  account,
  network,
}: {
  nonce: string | null;
  account: string;
  network: Network;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // True once a token was posted for this page's nonce. The extension uses a nonce once, whatever it does with the
  // token, so another press here would only mint a token nobody takes (and, past five, end the oldest connection).
  const [posted, setPosted] = useState(false);

  async function connect() {
    if (nonce === null || posted) return;
    setState({ kind: "busy" });
    let r: Awaited<ReturnType<typeof connectExtensionAction>>;
    try {
      r = await connectExtensionAction(browserLabel());
    } catch {
      setState({ kind: "error", text: UNREACHABLE });
      return;
    }
    if ("error" in r) {
      setState({ kind: "error", text: r.error });
      return;
    }
    // A mark left by an earlier Connect on this page must not answer for this one.
    document.documentElement.removeAttribute("data-probarion-extension");
    // To this page's own window only: the extension's content script reads it here and checks the nonce it made.
    window.postMessage(
      {
        type: "probarion:connect",
        v: 1,
        nonce,
        token: r.token,
        account: r.account,
        network: r.network,
        expires_at: r.expires_at,
      },
      window.location.origin,
    );
    const took = await extensionTookIt(3000);
    setPosted(true);
    setState({ kind: took ? "connected" : "not_taken" });
  }

  async function code() {
    setState({ kind: "busy" });
    try {
      const r = await showPairCodeAction();
      setState(
        "error" in r
          ? { kind: "error", text: r.error }
          : { kind: "code", code: r.code, expires: r.expires_at },
      );
    } catch {
      setState({ kind: "error", text: UNREACHABLE });
    }
  }

  return (
    <div className="text-sm">
      <p className="mb-3">
        Signed in as <span className="mono break-all">{account}</span> on NEAR {network}.
      </p>
      {nonce === null ? (
        <p className="mb-3">
          Open the Probarion extension and press Connect, or show a code and type it into the
          extension.
        </p>
      ) : posted ? (
        <p className="mb-3">To connect again, press Connect in the extension.</p>
      ) : (
        <button
          type="button"
          className={buttonClass}
          disabled={state.kind === "busy"}
          onClick={connect}
        >
          Connect extension
        </button>
      )}{" "}
      <button type="button" className={buttonClass} disabled={state.kind === "busy"} onClick={code}>
        Show a code instead
      </button>
      {state.kind === "connected" ? (
        <Notice tone="good">Connected. You can close this tab.</Notice>
      ) : null}
      {state.kind === "not_taken" ? (
        <Notice tone="warn">
          The extension didn't take it. Press Connect in the extension again, or show a code. You
          can revoke the unused connection under Connected browsers.
        </Notice>
      ) : null}
      {state.kind === "code" ? (
        <Notice tone="info">
          Type <strong className="mono">{state.code}</strong> into the extension. It works once, for
          ten minutes. Type it only into your own extension: whoever enters it first gets a 30-day
          connection to your account.
        </Notice>
      ) : null}
      {state.kind === "error" ? <Notice tone="bad">{state.text}</Notice> : null}
    </div>
  );
}
