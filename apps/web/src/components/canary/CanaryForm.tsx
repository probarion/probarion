"use client";

import { useId, useRef, useState } from "react";
import c from "@/components/site/canary.module.css";
import { inkPillClass } from "@/components/ui";
import { CANARY_COPY, characterCount } from "@/lib/canary/copy";
import { CANARY_LIMITS } from "@/lib/canary/limits";
import { type Answer, type AttemptIo, submitAttempt } from "@/lib/canary/reply";
import type { CanaryVia } from "@/lib/canary/via";
import type { Network } from "@/lib/config";
import { AttemptResultView } from "./AttemptResult";
import { Chip } from "./Chip";

const F = CANARY_COPY.form;

/** `fetch` is wrapped, not passed: the browser's fetch throws when it is called as a method of another object. */
const IO: AttemptIo = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The visitor's message and the answer to it. It is not a `<form>` and the textarea has no name, so that with no
 * JavaScript nothing can put the text in an address. The answer arrives in a live region, so a screen reader hears it.
 */
export function CanaryForm({
  network,
  mode,
  via = null,
}: {
  network: Network;
  mode: "live" | "code-only";
  /** The source the page's address named (`/canary?via=x`), already checked: sent with each attempt. */
  via?: CanaryVia | null;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);

  // One attempt at a time. A press while one runs does nothing (the button is not `disabled`, so that it keeps the
  // keyboard focus, and says it is busy with aria-disabled). A ref, not the state: a second press can come before the
  // render that shows the first.
  const running = useRef(false);

  async function submit() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setAnswer(null);
    try {
      setAnswer(await submitAttempt(text, IO, via));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div>
      <label htmlFor={id} className={c.label}>
        {F.label}
      </label>
      <textarea
        id={id}
        className={c.textarea}
        rows={6}
        maxLength={CANARY_LIMITS.maxTextChars}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={F.placeholder}
        aria-describedby={`${id}-note`}
      />
      <div className={c.formRow}>
        <p id={`${id}-note`} className={c.muted}>
          {F.note}
        </p>
        <p className={c.count}>{characterCount(text.length)}</p>
      </div>
      <div className={c.actions}>
        <button
          type="button"
          className={`${inkPillClass} ${c.button}`}
          disabled={text.trim() === ""}
          aria-disabled={busy ? true : undefined}
          onClick={submit}
        >
          {busy ? F.busy : F.button}
        </button>
        <Chip>{mode === "live" ? F.rawOn : F.codeOnly}</Chip>
      </div>
      <div className={c.result} aria-live="polite" aria-busy={busy}>
        {busy ? <p className={c.muted}>{F.busy}</p> : null}
        {answer?.kind === "error" ? <p className={c.error}>{answer.text}</p> : null}
        {answer?.kind === "done" ? (
          <AttemptResultView result={answer.result} network={network} />
        ) : null}
      </div>
    </div>
  );
}
