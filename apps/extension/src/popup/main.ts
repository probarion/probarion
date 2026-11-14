import { ApiError, api, type InboxVault } from "../api";
import {
  badgeShown,
  connectWithCode,
  type Deps,
  disconnect,
  type InboxState,
  refresh,
  startConnect,
} from "../background";
import { type CaptureResult, captureFile, captureUrl, isPdfUrl, toBlob } from "../capture";
import { chromeApi } from "../chrome";
import { DEFAULT_ORIGIN, hostOf, OFFERED } from "../origins";
import {
  clearPending,
  getPending,
  loadLocal,
  markExpired,
  type Pending,
  selectOrigin,
  setPending,
} from "../storage";
import { h } from "./dom";
import {
  browserLabel,
  connectChoices,
  focusTarget,
  HEADING,
  itemText,
  mandateLabel,
  networkText,
  noMandates,
  noteFor,
  roleFor,
  sentText,
  vaultLabel,
  vaultsWithMandates,
  waitingCount,
  waitingRows,
} from "./view";

// The popup (spec §5.6). Each time it opens it reads the chosen connection's inbox, shows what waits, and offers to
// send the captured invoice to a vault and a mandate. It can't pay: Probarion only queues the invoice, and the owner
// confirms it in the console with their wallet.

const READING_LIMIT_MS = 60_000;
const c = chromeApi();
const d: Deps = { chrome: c, fetch: (input, init) => fetch(input, init), now: () => Date.now() };
const inTab = new URLSearchParams(location.search).get("view") === "tab";
const app = document.getElementById("app") as HTMLElement;
if (inTab) document.body.classList.add("tab");

type Ok = Extract<InboxState, { kind: "ok" }>;

const ui = {
  state: null as InboxState | null,
  origins: [] as string[],
  pending: null as Pending | null,
  tabPdf: null as string | null,
  vault: null as string | null,
  mandate: null as number | null,
  connectOrigin: connectChoices(OFFERED, DEFAULT_ORIGIN).selected,
  code: "",
  busy: false,
  /** A stored connection changed while an action ran: the screen reads it again once the action ends. */
  stale: false,
  message: null as { tone: "ok" | "bad"; text: string; url?: string } | null,
};

/** The data-focus name of the control that has focus, if any. */
function focusedKey(): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.dataset.focus : undefined;
}

function render(): void {
  // Every change rebuilds the popup, so the focused control is found again by its data-focus name.
  const key = focusedKey();
  app.replaceChildren(header(), ...body());
  if (key !== undefined) app.querySelector<HTMLElement>(`[data-focus="${key}"]`)?.focus();
  void markSeen();
}

type Focusable = HTMLButtonElement | HTMLSelectElement | HTMLInputElement;

/**
 * After an action that switched its control off while it worked, or whose control is gone from the new screen (Clear,
 * Choose file), focus fell to the page. It goes back to the control that started the action if it is still there and
 * enabled, else to `landing` (where the action leads), else to the new screen's first control, else to its heading.
 * A HEADING landing goes to the heading. If the person moved focus elsewhere meanwhile, it stays there.
 */
function settleFocus(started: string | undefined, landing?: string): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  const controls = [...app.querySelectorAll<Focusable>("button, select, input")];
  const at = focusTarget(
    started,
    controls.map((el) => ({ key: el.dataset.focus, enabled: !el.disabled })),
    landing,
  );
  const target = at === null ? undefined : controls[at];
  if (target !== undefined) {
    target.focus();
    return;
  }
  const heading = app.querySelector("h2");
  if (heading !== null) {
    heading.tabIndex = -1; // a heading takes focus only by script, and a screen reader reads it
    heading.focus();
  }
}

const open = (url: string): void => {
  void c.tabs.create({ url });
};

function button(
  label: string,
  onClick: () => void,
  cls = "secondary",
  focus = label,
): HTMLButtonElement {
  const b = h(
    "button",
    { class: cls, attrs: { type: "button", "data-focus": focus }, on: { click: onClick } },
    label,
  );
  b.disabled = ui.busy;
  return b;
}

/**
 * A select that is off while an action runs, like the buttons. A closed select in the 360 px popup cuts its text at the
 * end, so its title holds the chosen option's whole text.
 */
function select(
  options: Array<[string, string]>,
  value: string,
  onChange: (v: string) => void,
  focus: string,
): HTMLSelectElement {
  const labelOf = (v: string) => options.find(([o]) => o === v)?.[1] ?? "";
  const el = h(
    "select",
    {
      attrs: { "data-focus": focus },
      on: {
        change: (e) => {
          const target = e.target as HTMLSelectElement;
          target.title = labelOf(target.value);
          onChange(target.value);
        },
      },
    },
    ...options.map(([v, label]) => h("option", { attrs: { value: v } }, label)),
  );
  el.value = value;
  el.title = labelOf(el.value);
  el.disabled = ui.busy;
  return el;
}

/**
 * Runs one action at a time: the buttons and selects are off meanwhile, and a failure shows its sentence. `landing` is
 * where focus goes when the control that started the action is not on the new screen; a function chooses it once the
 * action ends. A stored connection that changed meanwhile is read before the buttons come on again. The line that says
 * how the action ended can sit below the fold of a tall popup, so it is scrolled into view.
 */
async function act(
  work: () => Promise<void>,
  landing?: string | (() => string | undefined),
): Promise<void> {
  if (ui.busy) return;
  const started = focusedKey();
  ui.busy = true;
  ui.message = null;
  render();
  try {
    await work();
  } catch (error) {
    ui.message = {
      tone: "bad",
      text: error instanceof ApiError ? error.message : "Something went wrong. Try again.",
    };
  } finally {
    // reload clears `stale`, and a change during that read sets it again.
    while (ui.stale) await reload().catch(() => {});
    ui.busy = false;
    render();
    settleFocus(started, typeof landing === "function" ? landing() : landing);
    if (ui.message !== null) {
      app.querySelector<HTMLElement>("[data-message]")?.scrollIntoView({ block: "nearest" });
    }
  }
}

function header(): HTMLElement {
  const s = ui.state;
  const conn = s !== null && s.kind !== "none" ? s.connection : null;
  return h(
    "header",
    { class: "top" },
    h("img", { attrs: { src: "icons/32.png", alt: "", width: "20", height: "20" } }),
    h("h1", { class: "brand" }, "Probarion"),
    conn ? h("span", { class: `pill ${conn.network}` }, networkText(conn.network)) : null,
    conn
      ? h("span", { class: "account mono", attrs: { title: conn.account } }, conn.account)
      : null,
  );
}

function body(): Node[] {
  const s = ui.state;
  if (s === null) return [h("p", { class: "mute" }, "Reading what waits for you…")];
  if (s.kind === "none") return [connectSection(false)];
  const top = originSwitcher(s.origin);
  if (s.kind === "expired") return [...top, connectSection(true), footer(s.origin)];
  if (s.kind === "error") return [...top, errorSection(s.text), footer(s.origin)];
  return [...top, waitingSection(s), sendSection(s), footer(s.origin)];
}

function originSwitcher(current: string): Node[] {
  if (ui.origins.length < 2) return [];
  const choose = (o: string) =>
    void act(async () => {
      await selectOrigin(c, o);
      await reload();
    });
  return [
    h(
      "label",
      { class: "switch" },
      "Connection",
      select(
        ui.origins.map((o) => [o, hostOf(o)]),
        current,
        choose,
        "switch",
      ),
    ),
  ];
}

const uaData = () =>
  (navigator as Navigator & { userAgentData?: { platform?: unknown } }).userAgentData;

function connectSection(expired: boolean): HTMLElement {
  const code = h("input", {
    attrs: {
      name: "code",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: "20",
      placeholder: "K7QM-4XRA",
      "data-focus": "code",
    },
    on: {
      input: (e) => {
        ui.code = (e.target as HTMLInputElement).value;
      },
    },
  });
  code.value = ui.code;
  const useCode = h(
    "button",
    { class: "secondary", attrs: { type: "submit", "data-focus": "use-code" } },
    "Use code",
  );
  useCode.disabled = ui.busy;
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    void act(async () => {
      await connectWithCode(d, ui.connectOrigin, ui.code.trim(), browserLabel(uaData()));
      ui.code = "";
      await reload();
    });
  };
  const { options } = connectChoices(OFFERED, ui.connectOrigin);
  return h(
    "section",
    {},
    h("h2", {}, expired ? "Your connection expired" : "Connect Probarion"),
    h(
      "p",
      { class: "mute" },
      expired
        ? "Reconnect to see what waits for you and to send invoices."
        : "Connect this browser to your Probarion account. You sign in on Probarion with your wallet.",
    ),
    options.length > 1
      ? h(
          "label",
          {},
          "Probarion address",
          select(
            options,
            ui.connectOrigin,
            (o) => {
              ui.connectOrigin = o;
            },
            "connect-origin",
          ),
        )
      : null,
    button(
      expired ? "Reconnect" : "Connect",
      () => void act(() => startConnect(d, ui.connectOrigin)),
      "primary",
    ),
    h(
      "form",
      { class: "code", on: { submit } },
      h("label", {}, "Or type the code shown on Probarion's Browser extension page", code),
      useCode,
    ),
    messageLine(),
  );
}

function errorSection(text: string): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, "Waiting for you"),
    h("p", { class: "bad", attrs: { role: "alert" } }, text),
    button("Retry", () => void act(reload)),
    messageLine(),
  );
}

function waitingSection(s: Ok): HTMLElement {
  const rows = waitingRows(s.inbox);
  const n = waitingCount(s.inbox);
  return h(
    "section",
    {},
    h("h2", {}, n === 0 ? "Waiting for you" : `Waiting for you (${n})`),
    rows.length === 0
      ? h("p", { class: "mute" }, "Nothing waits for you")
      : h(
          "ul",
          { class: "rows" },
          ...rows.map((r, i) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  class: "row",
                  attrs: { type: "button", "data-focus": `row-${i}` },
                  on: { click: () => open(r.url) },
                },
                h("span", { class: "title" }, r.title),
                h("span", { class: "detail" }, r.detail),
              ),
            ),
          ),
        ),
    n > rows.length ? h("p", { class: "mute" }, "The console shows the rest.") : null,
    ...s.inbox.vaults
      .filter((v) => v.chain === "unavailable")
      .map((v) =>
        h(
          "p",
          { class: "mute" },
          `NEAR couldn't be read for ${v.name}, so its held payments and mandates may be missing.`,
        ),
      ),
  );
}

function sendSection(s: Ok): HTMLElement {
  const vaults = vaultsWithMandates(s.inbox);
  const role = roleFor(s.inbox, ui.vault);
  const send = button(
    ui.busy ? "Sending…" : "Send to Probarion",
    () => void sendInvoice(s),
    "primary",
    "send",
  );
  send.disabled = ui.busy || ui.pending?.state !== "ready" || vaults.length === 0;
  return h(
    "section",
    {},
    h("h2", {}, "Send an invoice"),
    captured(),
    vaults.length === 0 ? noMandatesBlock(s) : chooser(vaults),
    h("p", { class: "note" }, noteFor(role)),
    send,
    messageLine(),
  );
}

/** Why no vault takes invoices now: no active mandate, or NEAR couldn't be read (then Retry is offered). */
function noMandatesBlock(s: Ok): HTMLElement {
  const none = noMandates(s.inbox);
  return h(
    "div",
    {},
    h("p", { class: "mute" }, none.text),
    none.retry ? button("Retry", () => void act(reload)) : null,
  );
}

function captured(): HTMLElement {
  const p = ui.pending;
  if (p?.state === "reading") return h("p", { class: "mute" }, "Reading the invoice…");
  if (p?.state === "ready") {
    return h(
      "div",
      { class: "item" },
      h("span", {}, itemText(p.item)),
      button("Clear", () => void forget()),
    );
  }
  const file = h("input", {
    attrs: {
      type: "file",
      accept: ".pdf,.txt,application/pdf,text/plain",
      "data-focus": "file",
    },
    on: { change: (e) => void take((e.target as HTMLInputElement).files?.[0]) },
  });
  const over = (e: DragEvent, on: boolean) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.toggle("over", on);
  };
  const tabPdf = ui.tabPdf;
  return h(
    "div",
    { class: "sources" },
    p?.state === "error" ? h("p", { class: "bad", attrs: { role: "alert" } }, p.text) : null,
    tabPdf
      ? button(
          "Use the PDF in this tab",
          () => void act(async () => hold(await captureUrl(tabPdf, d.fetch, "tab")), "send"),
        )
      : null,
    h("label", { class: "secondary file" }, "Choose file", file),
    h(
      "div",
      {
        class: "drop",
        on: {
          dragover: (e) => over(e, true),
          dragleave: (e) => over(e, false),
          drop: (e) => {
            over(e, false);
            void take(e.dataTransfer?.files[0]);
          },
        },
      },
      "Drop a PDF or a .txt file here",
    ),
    inTab
      ? null
      : button("Open in a tab", () => open(c.runtime.getURL("popup.html?view=tab")), "link"),
  );
}

async function take(file: File | undefined): Promise<void> {
  if (file !== undefined) await hold(await captureFile(file));
}

async function hold(r: CaptureResult): Promise<void> {
  const p: Pending = r.ok
    ? { state: "ready", item: r.item, seen: true }
    : { state: "error", text: r.text, seen: true };
  ui.pending = p;
  ui.message = null;
  render();
  // The control that took the file (Choose file) is not on the new screen: focus goes to Send, or back to Choose file
  // when the file was refused. A caller that runs inside act() settles focus itself, once the buttons are on again.
  if (!ui.busy) settleFocus(undefined, r.ok ? "send" : "file");
  // Kept in session storage too, so it is still here when the popup opens again. If storage refuses it, the popup
  // still has it in memory and can send it now.
  await setPending(c, p).catch(() => {});
}

async function forget(): Promise<void> {
  ui.pending = null;
  render();
  settleFocus(undefined, "file"); // Clear is gone: focus goes to Choose file
  await clearPending(c);
}

function chooser(vaults: InboxVault[]): HTMLElement {
  const vault = vaults.find((v) => v.vault === ui.vault) ?? vaults[0];
  if (vault === undefined) return h("div", {});
  const mandate = vault.mandates.find((m) => m.id === ui.mandate) ?? vault.mandates[0];
  ui.vault = vault.vault;
  ui.mandate = mandate?.id ?? null;
  return h(
    "div",
    { class: "fields" },
    h(
      "label",
      {},
      "Vault",
      select(
        vaults.map((v) => [v.vault, vaultLabel(v)]),
        vault.vault,
        (v) => {
          ui.vault = v;
          ui.mandate = null;
          render();
        },
        "vault",
      ),
    ),
    h(
      "label",
      {},
      "Mandate",
      select(
        vault.mandates.map((m) => [String(m.id), mandateLabel(m)]),
        String(ui.mandate),
        (m) => {
          ui.mandate = Number(m);
        },
        "mandate",
      ),
    ),
  );
}

async function sendInvoice(s: Ok): Promise<void> {
  const p = ui.pending;
  const vault = ui.vault;
  const mandate = ui.mandate;
  if (p?.state !== "ready" || vault === null || mandate === null) return;
  const role = s.inbox.vaults.find((v) => v.vault === vault)?.role ?? "owner";
  await act(
    async () => {
      try {
        const sent = await api(s.origin, d.fetch).sendInvoice(s.connection.token, {
          vault,
          mandate,
          file: toBlob(p.item),
          name: p.item.name,
        });
        ui.pending = null;
        await clearPending(c);
        ui.message = { tone: "ok", text: sentText(sent, role), url: sent.url };
        const next = await refresh(d);
        if (next.kind !== "error") ui.state = next;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await markExpired(c, s.origin, s.connection.token);
          ui.state = await refresh(d);
          ui.connectOrigin = s.origin;
          // The expired screen says it in its heading and offers one Reconnect: no second sentence under it.
          if (ui.state.kind === "expired") return;
        }
        throw error;
      }
      // Send is off once the invoice is gone: focus goes to the result's Open, which brings the result into view. After a
      // 401 it goes to the expired screen's heading, which says what happened.
    },
    () => (ui.state?.kind === "expired" ? HEADING : "Open"),
  );
}

function messageLine(): HTMLElement | null {
  const m = ui.message;
  if (m === null) return null;
  const url = m.url;
  return h(
    "p",
    { class: m.tone, attrs: { role: m.tone === "bad" ? "alert" : "status", "data-message": "" } },
    m.text,
    url ? " " : null,
    url ? button("Open", () => open(url), "link") : null,
  );
}

function footer(origin: string): HTMLElement {
  const leave = () =>
    void act(async () => {
      const r = await disconnect(d, origin);
      await reload();
      if (!r.revoked) {
        ui.message = {
          tone: "bad",
          text: "Disconnected here. Probarion couldn't be reached, so end this connection on its Browser extension page.",
        };
      }
    });
  return h(
    "footer",
    {},
    button("Open the console", () => open(`${origin}/console`), "link"),
    button("Disconnect", leave, "link"),
  );
}

async function reload(): Promise<void> {
  ui.stale = false; // what is stored from here on is read below
  ui.origins = Object.keys((await loadLocal(c)).connections);
  ui.state = await refresh(d);
  if (ui.state.kind === "expired") ui.connectOrigin = ui.state.origin;
  render();
}

/** The captured invoice as the popup holds it: a read that never finished counts as failed. */
async function current(p: Pending | null): Promise<Pending | null> {
  if (p === null || p.state !== "reading" || d.now() - p.started_at <= READING_LIMIT_MS) return p;
  const failed: Pending = {
    state: "error",
    text: "Reading the invoice took too long. Download it and drag the file here.",
    seen: p.seen,
  };
  await setPending(c, failed);
  return failed;
}

/**
 * Marks the captured invoice seen once a screen that shows it is on, and sets the badge to match. Only the Send
 * section shows it: behind Connect, an expired connection or an error it stays unseen, and the badge keeps its "+".
 * The toolbar popup read its inbox as it opened, so the badge takes that count. A tab view can stay open for hours, so
 * its count can be old: the inbox is read again for the badge, and the old count serves when Probarion can't be
 * reached.
 */
async function markSeen(): Promise<void> {
  const p = ui.pending;
  const s = ui.state;
  if (s?.kind !== "ok" || p === null || p.seen) return;
  ui.pending = { ...p, seen: true };
  // A read still running is stored again by the worker when it ends (handleMenu), and this marks that one.
  if (p.state === "reading") return;
  await setPending(c, ui.pending).catch(() => {});
  if (inTab) {
    const fresh = await refresh(d).catch(() => null);
    if (fresh !== null && fresh.kind !== "error") return;
  }
  await badgeShown(d, s).catch(() => {});
}

async function start(): Promise<void> {
  render();
  const [pending, tabs] = await Promise.all([
    getPending(c),
    c.tabs.query({ active: true, currentWindow: true }).catch(() => []),
  ]);
  ui.pending = await current(pending);
  const url = tabs[0]?.url;
  ui.tabPdf = isPdfUrl(url) ? url : null;
  await reload();
}

c.storage.onChanged.addListener((changes, area) => {
  // A menu click hands its invoice over through session storage, sometimes after the popup has opened.
  if (area === "session" && Object.hasOwn(changes, "pending")) {
    void getPending(c)
      .then(current)
      .then((p) => {
        ui.pending = p;
        render();
      });
    return;
  }
  // The worker stored a connection (the connect page, while the tab view stays open) or marked one expired, or another
  // popup switched or ended one: the screen follows. While an action runs, the change is read once it ends (act).
  if (
    area === "local" &&
    (Object.hasOwn(changes, "connections") || Object.hasOwn(changes, "selectedOrigin"))
  ) {
    if (ui.busy) {
      ui.stale = true;
      return;
    }
    // The new screen may lack the control that had focus (Reconnect, once connected): focus then settles as after an
    // action, and does not fall to the page.
    const key = focusedKey();
    const focused = document.activeElement !== null && document.activeElement !== document.body;
    void reload()
      .then(() => {
        if (focused && !ui.busy) settleFocus(key); // an action started meanwhile settles focus itself
      })
      .catch(() => {});
  }
});

// A file dropped outside the drop area must not navigate the popup away.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

void start();
