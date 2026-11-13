"use client";

import type { NetworkId } from "@probarion/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import c from "@/components/site/canary.module.css";
import { useBrowserNetwork } from "@/components/site/useBrowserNetwork";
import { buttonClass, Field, inputClass } from "@/components/ui";
import { CheckFailed, CheckResult } from "./CheckResult";
import {
  type CheckForm,
  type CheckInput,
  EXAMPLES,
  exampleFor,
  formFromHash,
  formOf,
  formToHash,
  networkHint,
  networkOfName,
  parseCheckForm,
  statusLine,
} from "./check-view";
import { CHECK_PAGE } from "./copy";
import { type DoneRun, type FailedRun, runCheck } from "./run";

// /check: the payee check in the browser. The browser reads the chain itself (run.ts: the SDK's `readPayeeSignals`,
// against public nodes that answer with CORS) and core's `assessPayee` gives the verdict. No wallet and no Probarion
// route: the page has nothing to send a payee to. A read that fails is unknown and warns; a check that throws shows
// that it could not run, and never an allow.

const F = CHECK_PAGE.form;

type Run = { kind: "idle" } | { kind: "busy"; input: CheckInput } | DoneRun | FailedRun;
type FieldName = "network" | "payee" | "vault";
type Errors = Partial<Record<FieldName, string>>;
/** Each control's id: a wrong field takes the focus, so its error is what a screen reader reads next. */
const fieldId = (field: FieldName) => `check-${field}`;
const HINT_ID = "check-network-hint";

export function PayeeCheck() {
  const addressNetwork = useBrowserNetwork();
  // The network the visitor chose; until then, a named payee's suffix (.near or .testnet), else the address's own
  // network (mainnet before the page knows it).
  const [chosen, setChosen] = useState<NetworkId | null>(null);
  const [payee, setPayee] = useState("");
  const [vault, setVault] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  // A new object for each wrong send, so the same field takes the focus again.
  const [focusOn, setFocusOn] = useState<{ field: FieldName } | null>(null);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [mounted, setMounted] = useState(false);
  const running = useRef(false);
  const network: NetworkId = chosen ?? networkOfName(payee) ?? addressNetwork ?? "mainnet";
  const busy = run.kind === "busy";

  /**
   * One check at a time: a press while one reads does nothing (the button says so with aria-disabled). A wrong form
   * clears the last result, which was for another payee, and puts the focus on the field that is wrong, unless the
   * form came from a link as the page loaded.
   */
  async function start(form: CheckForm, focusOnError = true) {
    if (running.current) return;
    const parsed = parseCheckForm(form);
    if (!parsed.ok) {
      setErrors({ [parsed.field]: parsed.problem });
      setRun({ kind: "idle" });
      if (focusOnError) setFocusOn({ field: parsed.field });
      return;
    }
    setErrors({});
    const { input } = parsed;
    running.current = true;
    setRun({ kind: "busy", input });
    try {
      const done = await runCheck(input, {
        fetch: (url, init) => fetch(url, init),
        now: () => performance.now(),
      });
      setRun(done);
      // The check, in the fragment: a link to it, which no server sees.
      if (done.kind === "done") window.history.replaceState(null, "", formToHash(formOf(input)));
    } finally {
      running.current = false;
    }
  }

  // A link can carry a check in its fragment (#network=…&payee=…&vault=…): it fills the form and runs once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount; `start` reads only setters and a ref
  useEffect(() => {
    setMounted(true);
    const fromHash = formFromHash(window.location.hash);
    if (fromHash === null || fromHash.payee === undefined) return;
    // A fragment without a network is mainnet: the address's network is not read yet in this first pass.
    const form: CheckForm = {
      network: fromHash.network ?? "mainnet",
      payee: fromHash.payee,
      vault: fromHash.vault ?? "",
    };
    setChosen(form.network as NetworkId);
    setPayee(form.payee);
    setVault(form.vault);
    void start(form, false);
  }, []);

  // After the render that shows the error, so the field is read with it.
  useEffect(() => {
    if (focusOn !== null) document.getElementById(fieldId(focusOn.field))?.focus();
  }, [focusOn]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void start({ network, payee, vault });
  };

  const pick = (form: CheckForm) => {
    if (running.current) return;
    setChosen(form.network as NetworkId);
    setPayee(form.payee);
    setVault(form.vault);
    void start(form);
  };

  const parsedNow = parseCheckForm({ network, payee, vault });
  const hint = parsedNow.ok ? networkHint(parsedNow.input) : null;
  const picked = exampleFor({ network, payee, vault });

  return (
    <div>
      {/* The form beside the examples from 1024px; one column below. */}
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <form onSubmit={submit} noValidate aria-label={F.title} className="[&_span]:max-w-measure">
          <Field label={F.network} error={errors.network}>
            <select
              id={fieldId("network")}
              className={inputClass}
              value={network}
              onChange={(e) => setChosen(e.target.value as NetworkId)}
            >
              <option value="mainnet">mainnet</option>
              <option value="testnet">testnet</option>
            </select>
          </Field>
          <Field label={F.payee} hint={F.payeeHint} error={errors.payee}>
            <input
              id={fieldId("payee")}
              className={`${inputClass} font-mono`}
              type="text"
              name="payee"
              aria-describedby={hint === null ? undefined : HINT_ID}
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder={F.payeePlaceholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </Field>
          <Field label={F.vault} hint={F.vaultHint} error={errors.vault}>
            <input
              id={fieldId("vault")}
              className={`${inputClass} font-mono`}
              type="text"
              name="vault"
              value={vault}
              onChange={(e) => setVault(e.target.value)}
              placeholder={F.vaultPlaceholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          {hint === null ? null : (
            <p id={HINT_ID} className="mb-3 text-sm text-wait">
              {hint}
            </p>
          )}
          <button
            type="submit"
            className={buttonClass}
            disabled={!mounted}
            aria-disabled={busy ? true : undefined}
          >
            {busy ? F.busy : F.button}
          </button>
        </form>

        <fieldset className="min-w-0 border-0 p-0">
          <legend className={c.tryLabel}>{F.tryLabel}</legend>
          <ul className="mt-3 grid gap-3">
            {EXAMPLES.map((ex) => (
              <li key={ex.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  type="button"
                  className={c.pick}
                  aria-pressed={picked?.id === ex.id}
                  aria-disabled={busy || !mounted ? true : undefined}
                  aria-describedby={`check-ex-${ex.id}`}
                  onClick={() => pick(ex.form)}
                >
                  {ex.label}
                </button>
                <span
                  id={`check-ex-${ex.id}`}
                  className="max-w-measure text-sm text-mute wrap-anywhere"
                >
                  {ex.note}
                </span>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>

      <p className="sr-only" role="status">
        {run.kind === "busy"
          ? F.busy
          : run.kind === "done"
            ? statusLine(run.assessment)
            : run.kind === "failed"
              ? CHECK_PAGE.result.failed(run.message)
              : ""}
      </p>
      <div
        className={run.kind === "idle" ? "" : "mt-8 border-t border-ink/10 pt-6"}
        aria-busy={busy}
      >
        {run.kind === "busy" ? <p className="text-sm text-mute">{F.busyLine}</p> : null}
        {run.kind === "done" ? (
          <CheckResult run={run} shareHref={formToHash(formOf(run.input))} />
        ) : null}
        {run.kind === "failed" ? <CheckFailed run={run} /> : null}
      </div>
    </div>
  );
}
