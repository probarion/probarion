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

/** Whether the extension's content script marked the page connected, waiting up to `ms`. */
async function extensionTookIt(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (document.documentElement.dataset.probarionExtension === "connected") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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

  async function connect() {
    if (nonce === null) return;
    setState({ kind: "busy" });
    const r = await connectExtensionAction(browserLabel());
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
    setState({ kind: (await extensionTookIt(3000)) ? "connected" : "not_taken" });
  }

  async function code() {
    setState({ kind: "busy" });
    const r = await showPairCodeAction();
    setState(
      "error" in r
        ? { kind: "error", text: r.error }
        : { kind: "code", code: r.code, expires: r.expires_at },
    );
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
          ten minutes.
        </Notice>
      ) : null}
      {state.kind === "error" ? <Notice tone="bad">{state.text}</Notice> : null}
    </div>
  );
}
