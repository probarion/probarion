"use client";

import { useState } from "react";
import { Badge, buttonClass, ExternalLink, Notice, type Tone } from "@/components/ui";
import { REPO_URL } from "@/lib/proof/cli";
import {
  allPass,
  type BrowserCheck,
  checkFromBrowser,
  type TeeAttestationValues,
  type TeeCheckId,
  type TeeStatus,
} from "@/lib/tee/recheck";

// /proof's live TEE check: one card right under the result, above the checks and the decisions, the same on every
// vault's page. The browser draws the nonce, sends it with no cookie and no Referer, and re-checks the two bindings
// itself (lib/tee/recheck.ts). It checks the TEE that serves the model now; it reads nothing of the vault, and nothing
// on the decision cards reads it.

const MEASUREMENT_PIN = `${REPO_URL}/blob/main/docs/measurement-pin-2026-11.md`;

const NAMES: Readonly<Record<TeeCheckId, string>> = {
  nonce: "Nonce bound",
  signer: "Signer bound",
  o1: "O1: Intel TDX quote",
  o2: "O2: NVIDIA GPU evidence",
};

const WHERE: Readonly<Record<TeeCheckId, string>> = {
  nonce: "re-checked in this browser",
  signer: "re-checked in this browser",
  o1: "Intel DCAP, run by the server",
  o2: "NVIDIA NRAS, run by the server",
};

const STATUS: Readonly<Record<TeeStatus, { tone: Tone; label: string }>> = {
  pass: { tone: "good", label: "pass" },
  fail: { tone: "bad", label: "fail" },
  unavailable: { tone: "warn", label: "not run" },
};

const link = "text-ink underline decoration-ink/60 hover:decoration-ink";
/** The site's grey for small text: 7:1 or more on paper and on a white card (globals.css). */
const muted = "text-mute";

/** "2026-11-12 10:28:54 UTC" for an ISO time; anything else as it is. */
function utc(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : `${new Date(t).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const GPU: Readonly<Record<TeeAttestationValues["gpu"], string>> = {
  pass: "verified by NVIDIA NRAS",
  fail: "refused",
  unavailable: "not verified here",
  none: "no GPU evidence in the report",
};

function Facts({ check }: { check: Extract<BrowserCheck, { ok: true }> }) {
  const { answer } = check;
  const list = (f: (a: TeeAttestationValues) => string) =>
    answer.attestations.length === 0 ? "none" : answer.attestations.map(f).join(", ");
  return (
    <dl className="mt-4 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      <dt className={muted}>Nonce</dt>
      <dd className="font-mono wrap-anywhere">{check.nonce}</dd>
      <dt className={muted}>Checked</dt>
      <dd>
        {utc(answer.checked_at)}, in {(check.tookMs / 1000).toFixed(1)} s
      </dd>
      <dt className={muted}>Model</dt>
      <dd className="font-mono wrap-anywhere">{answer.model ?? "none answered"}</dd>
      <dt className={muted}>Attestations</dt>
      <dd>
        {answer.attestations.length} of {answer.attestations_total} checked
      </dd>
      <dt className={muted}>Signer</dt>
      <dd className="font-mono wrap-anywhere">{list((a) => a.signing_address)}</dd>
      <dt className={muted}>TCB status</dt>
      <dd>{list((a) => a.tcb_status ?? "not verified")}</dd>
      <dt className={muted}>GPU</dt>
      <dd>{list((a) => GPU[a.gpu])}</dd>
    </dl>
  );
}

/** A finished check: the verdict, one row per check, the named non-check and the values it was run on. */
export function TeeResult({ check }: { check: Extract<BrowserCheck, { ok: true }> }) {
  const passed = allPass(check.rows);
  return (
    <>
      <p className="mt-4 text-sm text-ink" data-tee-result={passed ? "pass" : "not-pass"}>
        {passed
          ? "All four checks passed for this nonce."
          : check.rows.some((r) => r.status === "fail")
            ? "A check failed for this nonce."
            : "Not every check could run, so this is not a pass."}
      </p>
      <ol className="mt-2 divide-y divide-ink/10">
        {check.rows.map((r) => {
          const s = STATUS[r.status];
          return (
            <li key={r.id} className="py-3" data-tee-check={r.id} data-status={r.status}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm text-ink">
                  {NAMES[r.id]} <span className={`text-xs ${muted}`}>({WHERE[r.id]})</span>
                </h3>
                <Badge tone={s.tone}>{s.label}</Badge>
              </div>
              <p className={`mt-1 text-xs ${muted} wrap-anywhere`}>{r.detail}</p>
            </li>
          );
        })}
        <li className="py-3" data-tee-check="measurement" data-status="not-checked">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm text-ink">TEE measurement</h3>
            <Badge tone="neutral">not pinned</Badge>
          </div>
          <p className={`mt-1 text-xs ${muted}`}>
            Not a check: nothing here shows which model image runs.{" "}
            <ExternalLink className={link} href={MEASUREMENT_PIN}>
              Why it is not pinned
            </ExternalLink>
          </p>
        </li>
      </ol>
      <Facts check={check} />
    </>
  );
}

/**
 * The card. `model` is the model the site is set to use (NEARAI_MODEL), or null when it is not set and the server asks
 * the SDK's preferred private models until one answers; the answer names the model that was checked.
 */
export function TeeCheckPanel({ model }: { model: string | null }) {
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<BrowserCheck | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setCheck(
        await checkFromBrowser({
          fetch: (input, init) => fetch(input, init),
          random: (bytes) => crypto.getRandomValues(bytes),
          now: () => performance.now(),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="mb-6 rounded-3xl border border-ink/10 bg-white p-5 sm:p-7"
      id="tee-check"
      aria-labelledby="tee-check-title"
    >
      <h2 id="tee-check-title" className="text-lg font-normal tracking-tight text-ink sm:text-xl">
        Check the TEE now
      </h2>
      <p className={`mt-1 text-sm ${muted}`}>
        This checks the TEE that serves{" "}
        {model === null ? (
          "a private model on NEAR AI Cloud (the first of the SDK's preferred models that answers)"
        ) : (
          <code className="text-ink">{model}</code>
        )}{" "}
        right now, with a random nonce your browser draws. It does not re-check this vault&apos;s
        decisions.
      </p>
      <p className={`mt-1 text-sm ${muted}`}>
        Your browser sends the nonce, with no cookie, and nothing you typed or uploaded.
      </p>
      <div className="mt-4">
        <button type="button" className={buttonClass} onClick={run} disabled={busy}>
          {busy ? "Checking the TEE" : "Check the TEE now"}
        </button>
      </div>
      <div aria-live="polite">
        {busy ? (
          <p className={`mt-3 text-xs ${muted}`}>
            Asking NEAR AI, Intel and NVIDIA. This takes up to half a minute.
          </p>
        ) : null}
        {!busy && check !== null && !check.ok ? (
          <div className="mt-4">
            <Notice tone="warn">{check.message} Nothing here is a pass.</Notice>
          </div>
        ) : null}
        {!busy && check?.ok ? <TeeResult check={check} /> : null}
      </div>
    </section>
  );
}
