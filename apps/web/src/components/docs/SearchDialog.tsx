"use client";

import type MiniSearch from "minisearch";
import Link from "next/link";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { isBackdropClick } from "@/lib/console/confirm-dialog";
import {
  activeIndex,
  createSearch,
  FILTER_LABELS,
  groupHits,
  highlight,
  isSearchShortcut,
  KIND_LABELS,
  loadIndex,
  moveActive,
  optionId,
  RESULT_LIMIT,
  resultsMessage,
  runSearch,
  SEARCH_EVENT,
  SEARCH_FILTERS,
  type SearchDoc,
  type SearchFilter,
  type Segment,
} from "@/lib/docs/search";
import d from "./docs.module.css";

type Load = "idle" | "loading" | "ready" | "error";

const modified = (e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

/** On a press, so a click on an option or a filter leaves focus in the search box. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** How long the live region waits for typing to pause before it speaks. */
const ANNOUNCE_MS = 300;

function Marked({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s) =>
        s.mark ? <mark key={s.at}>{s.text}</mark> : <span key={s.at}>{s.text}</span>,
      )}
    </>
  );
}

/**
 * The docs search: a modal dialog over the static index, loaded on first open. It opens on Ctrl K
 * or ⌘K, on a click on any [data-docs-search] link, on a click on a popular search (with that
 * query) and on SEARCH_EVENT. showModal() keeps focus inside the dialog. Without JavaScript none
 * of this runs, and those links lead to the home's popular list. Each result is a next/link Link,
 * not useRouter(): the docs layout also renders where no app router is mounted (a unit test).
 */
export function SearchDialog({ glossaryHref }: { glossaryHref: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Where the last press began. A click closes the dialog only when it began on the backdrop too.
  const pressed = useRef<EventTarget | null>(null);
  const engine = useRef<MiniSearch<SearchDoc> | null>(null);
  const loading = useRef(false);
  const [load, setLoad] = useState<Load>("idle");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [active, setActive] = useState(0);
  const [announced, setAnnounced] = useState("");
  const base = useId();

  const fetchIndex = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    setLoad("loading");
    const docs = await loadIndex();
    loading.current = false;
    if (docs === null) {
      setLoad("error");
      return;
    }
    try {
      engine.current = createSearch(docs);
    } catch (error) {
      console.error("Docs search: the index did not load.", error);
      setLoad("error");
      return;
    }
    setLoad("ready");
  }, []);

  const open = useCallback(
    (initial?: string) => {
      const el = dialog.current;
      if (el === null) return;
      if (!el.open) {
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        el.showModal();
      }
      // A popular search starts afresh, on every kind. Otherwise the last query stays, selected,
      // so the next keystroke replaces it.
      if (initial !== undefined) {
        setQuery(initial);
        setFilter("all");
      }
      setActive(0);
      input.current?.focus();
      if (initial === undefined) input.current?.select();
      if (engine.current === null) void fetchIndex();
    },
    [fetchIndex],
  );

  useEffect(() => {
    const el = dialog.current;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      open();
    };
    const onClick = (e: globalThis.MouseEvent) => {
      if (modified(e) || !(e.target instanceof Element)) return;
      const popular = e.target.closest("[data-docs-popular] a");
      if (popular) {
        e.preventDefault();
        open(popular.textContent?.trim() ?? "");
        return;
      }
      if (e.target.closest("[data-docs-search]")) {
        e.preventDefault();
        open();
      }
    };
    const onEvent = (e: Event) => {
      const q = (e as CustomEvent<{ query?: unknown } | null>).detail?.query;
      open(typeof q === "string" ? q : undefined);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick, true);
    window.addEventListener(SEARCH_EVENT, onEvent);
    // data-ready="true": the listeners are attached, so SEARCH_EVENT is heard (e2e waits for it).
    el?.setAttribute("data-ready", "true");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(SEARCH_EVENT, onEvent);
      el?.removeAttribute("data-ready");
    };
  }, [open]);

  const q = query.trim();
  // One more than the dialog lists, so the message can say when the list stops at the limit.
  const found = useMemo(
    () =>
      load === "ready" && engine.current !== null
        ? runSearch(engine.current, query, filter, RESULT_LIMIT + 1)
        : [],
    [load, query, filter],
  );
  const more = found.length > RESULT_LIMIT;
  const hits = useMemo(() => found.slice(0, RESULT_LIMIT), [found]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const indexOf = useMemo(() => new Map(flat.map((h, i) => [h.id, i])), [flat]);
  const current = activeIndex(active, flat.length);
  const activeHit = current >= 0 ? flat[current] : undefined;
  const activeId = activeHit ? optionId(base, activeHit.id) : undefined;
  const listId = `${base}-list`;

  // The one polite live region: the loading state, then the count once typing pauses.
  let message = "";
  if (load === "loading") message = "Loading the search index";
  else if (load === "ready" && q !== "") message = resultsMessage(flat.length, q, more);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(message), ANNOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const close = () => dialog.current?.close();
  const onClose = () => {
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
  };
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    const backdrop = isBackdropClick({
      pressed: pressed.current,
      clicked: e.target,
      dialog: e.currentTarget,
    });
    pressed.current = null;
    if (backdrop) close();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An input method is composing a word (Vietnamese Telex, for one): its keys are not ours.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (flat.length === 0) return;
      e.preventDefault();
      setActive(moveActive(current, e.key === "ArrowDown" ? 1 : -1, flat.length));
    } else if (e.key === "Enter") {
      if (!activeHit || !activeId) return;
      e.preventDefault();
      // With Ctrl, ⌘ or Shift the result opens in a new tab and the dialog stays, as on a click.
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        window.open(activeHit.href, "_blank", "noopener");
        return;
      }
      // The option's own click closes the dialog, and its Link navigates in the app.
      document.getElementById(activeId)?.click();
    }
  };

  let body: ReactNode;
  if (load === "error") {
    body = (
      <div role="alert" className={d.searchError}>
        <p>The search index did not load.</p>
        <button
          type="button"
          className={d.searchButton}
          onClick={() => {
            // This button goes as the load starts: focus moves to the box first.
            input.current?.focus();
            void fetchIndex();
          }}
        >
          Try again
        </button>
      </div>
    );
  } else if (load !== "ready") {
    body = (
      <div className={d.searchLoading}>
        <p>Loading the search index</p>
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </div>
    );
  } else if (q === "") {
    body = (
      <p className={d.searchHint}>
        Type a page title, an error code such as <code>NoMandate</code>, or a CLI command such as{" "}
        <code>verify</code>.
      </p>
    );
  } else if (flat.length === 0) {
    body = (
      <div className={d.searchEmpty}>
        <p>{resultsMessage(0, q)}</p>
        <p>
          Try fewer words, or browse the{" "}
          {glossaryHref && (
            <>
              <Link href={glossaryHref} onClick={close}>
                Glossary
              </Link>{" "}
              or the{" "}
            </>
          )}
          <Link href="/docs" onClick={close}>
            docs home
          </Link>
          .
        </p>
      </div>
    );
  } else {
    body = (
      <div id={listId} role="listbox" aria-label="Results" className={d.searchResults}>
        {groups.map((g) => (
          // biome-ignore lint/a11y/useSemanticElements: the ARIA combobox pattern's option group.
          <div key={g.section} role="group" aria-label={g.section}>
            <p className={d.searchGroup} aria-hidden="true">
              {g.section}
            </p>
            {g.hits.map((hit) => {
              const i = indexOf.get(hit.id) ?? 0;
              return (
                <Link
                  key={hit.id}
                  id={optionId(base, hit.id)}
                  role="option"
                  aria-selected={i === current}
                  tabIndex={-1}
                  href={hit.href}
                  prefetch={false}
                  className={d.searchOption}
                  onMouseDown={keepFocus}
                  onMouseMove={() => setActive(i)}
                  onClick={(e) => {
                    // A modified click opens a new tab, as Link leaves it to the browser.
                    if (!modified(e)) close();
                  }}
                >
                  <span className={d.searchTitle}>
                    <Marked segments={highlight(hit.title, hit.terms)} />
                  </span>
                  <span className={d.searchMeta}>{KIND_LABELS[hit.kind]}</span>
                  <span className={d.searchSummary}>
                    <Marked segments={highlight(hit.summary, hit.terms)} />
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    // The click handlers add the mouse's way out, a press and a click on the backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively.
    <dialog
      ref={dialog}
      className={d.search}
      aria-label="Search the docs"
      onClose={onClose}
      onMouseDown={(e) => {
        pressed.current = e.target;
      }}
      onClick={onBackdrop}
    >
      <div className={d.searchIn}>
        <div className={d.searchHead}>
          <input
            ref={input}
            type="text"
            inputMode="search"
            enterKeyHint="go"
            role="combobox"
            aria-label="Search the docs"
            aria-expanded={flat.length > 0}
            aria-controls={flat.length > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            className={d.searchInput}
            placeholder="Pages, error codes, CLI commands"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <button type="button" className={d.searchButton} onClick={close}>
            Close
          </button>
        </div>
        <fieldset className={d.searchFilters}>
          <legend className="sr-only">Show</legend>
          {SEARCH_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={d.searchButton}
              onMouseDown={keepFocus}
              onClick={(e) => {
                setFilter(f);
                setActive(0);
                // A pointer goes back to the box; Space or Enter keeps focus on the pressed toggle.
                if (e.detail > 0) input.current?.focus();
              }}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </fieldset>
        <div className={d.searchBody}>{body}</div>
        <p className="sr-only" aria-live="polite">
          {announced}
        </p>
        <p className={d.searchKeys} aria-hidden="true">
          <kbd className={d.kbd}>↑</kbd> <kbd className={d.kbd}>↓</kbd> to move,{" "}
          <kbd className={d.kbd}>Enter</kbd> to open, <kbd className={d.kbd}>Esc</kbd> to close
        </p>
      </div>
    </dialog>
  );
}
