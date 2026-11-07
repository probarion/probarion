"use client";

import {
  Children,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { codeText } from "@/lib/docs/node-text";
import { CODE_TAB_EVENT, readCodeTab, writeCodeTab } from "@/lib/docs/prefs";
import { CopyButton } from "./CopyButton";
import d from "./docs.module.css";

/**
 * The same example in several languages. Until JavaScript runs, every panel shows as its own
 * code frame under its own label, so nothing is hidden from a reader without it. Then the panels
 * share one ink frame, as in the mockup: its head holds the tabs and one Copy button for the code
 * that shows, one panel shows at a time, and the choice is remembered.
 */
export function CodeTabs({ labels, children }: { labels: string; children: ReactNode }) {
  const names = labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const panels = Children.toArray(children).filter(isValidElement);
  if (names.length !== panels.length) {
    throw new Error(`CodeTabs: ${names.length} labels for ${panels.length} code block(s)`);
  }
  const id = useId();
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: labels carries the names
  useEffect(() => {
    const follow = (label: string | null) => {
      const at = label === null ? -1 : names.indexOf(label);
      if (at >= 0) setActive(at);
    };
    follow(readCodeTab());
    setReady(true);
    const onPick = (event: Event) => follow((event as CustomEvent<string>).detail);
    window.addEventListener(CODE_TAB_EVENT, onPick);
    return () => window.removeEventListener(CODE_TAB_EVENT, onPick);
    // `labels` carries the names; the array is rebuilt each render.
  }, [labels]);
  const pick = (at: number) => {
    const label = names[at];
    if (label === undefined) return;
    setActive(at);
    writeCodeTab(label);
    window.dispatchEvent(new CustomEvent(CODE_TAB_EVENT, { detail: label }));
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (active + (event.key === "ArrowRight" ? 1 : -1) + names.length) % names.length;
    pick(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className={d.codeTabs} data-ready={ready ? "" : undefined}>
      <div className={d.tabsHead} hidden={!ready}>
        <div role="tablist" aria-label="Code language" className={d.tabList}>
          {names.map((name, at) => (
            <button
              key={name}
              id={`${id}-tab-${at}`}
              type="button"
              role="tab"
              aria-selected={at === active}
              aria-controls={`${id}-panel-${at}`}
              tabIndex={at === active ? 0 : -1}
              className={d.tab}
              onClick={() => pick(at)}
              onKeyDown={onKey}
            >
              {name}
            </button>
          ))}
        </div>
        <CopyButton text={codeText(panels[active])} className={d.copy} />
      </div>
      {panels.map((panel, at) => (
        <div
          key={names[at]}
          id={`${id}-panel-${at}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${at}`}
          hidden={ready && at !== active}
        >
          <p className={d.tabLabel}>{names[at]}</p>
          {panel}
        </div>
      ))}
    </div>
  );
}
