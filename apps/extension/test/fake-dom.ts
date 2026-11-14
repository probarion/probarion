// A small DOM for the popup's tests: what src/popup/main.ts and dom.ts call, and no more. Focus follows the browser's
// rules the popup relies on: only a control that is on the page and enabled (or an element given a tabIndex) takes it,
// and when the focused element leaves the page, focus falls back to the body.

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement;
  currentTarget: FakeElement;
  defaultPrevented: boolean;
  preventDefault(): void;
  [key: string]: unknown;
}

export class FakeText {
  parent: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

type FakeNode = FakeElement | FakeText;

const FOCUSABLE = new Set(["button", "select", "input", "textarea"]);

/** One selector of a comma-separated list: a tag, then any `.class`, `[attr]` and `[attr="value"]`. */
function compile(selectors: string): (el: FakeElement) => boolean {
  const tests = selectors.split(",").map((one) => {
    const m = /^([a-z][a-z0-9]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(one.trim());
    if (m === null) throw new Error(`the fake DOM can't read the selector ${one}`);
    const tag = m[1]?.toLowerCase();
    const parts = [...(m[2] ?? "").matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)];
    return (el: FakeElement) =>
      (tag === undefined || el.localName === tag) &&
      parts.every(([, cls, attr, value]) => {
        if (cls !== undefined) return el.classList.contains(cls);
        if (attr === undefined) return false;
        return value === undefined ? el.hasAttribute(attr) : el.getAttribute(attr) === value;
      });
  });
  return (el) => tests.some((t) => t(el));
}

export class FakeElement {
  parent: FakeElement | null = null;
  children: FakeNode[] = [];
  disabled = false;
  files: unknown[] | null = null;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private chosen: string | null = null;
  private typed = "";
  /** A tabIndex a script gave the element: it lets an element that is not a control take focus. */
  private index: number | null = null;

  constructor(
    readonly localName: string,
    readonly doc: FakeDocument,
  ) {}

  get tabIndex(): number {
    return this.index ?? (FOCUSABLE.has(this.localName) ? 0 : -1);
  }

  set tabIndex(v: number) {
    this.index = v;
  }

  get tagName(): string {
    return this.localName.toUpperCase();
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(v: string) {
    this.setAttribute("class", v);
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter((n) => n !== "");
    const set = (list: string[]) => {
      this.className = list.join(" ");
    };
    return {
      contains: (n: string) => names().includes(n),
      add: (n: string) => {
        if (!names().includes(n)) set([...names(), n]);
      },
      remove: (n: string) => set(names().filter((x) => x !== n)),
      toggle: (n: string, on?: boolean) => {
        const want = on ?? !names().includes(n);
        set(want ? [...names().filter((x) => x !== n), n] : names().filter((x) => x !== n));
        return want;
      },
    };
  }

  get title(): string {
    return this.getAttribute("title") ?? "";
  }

  set title(v: string) {
    this.setAttribute("title", v);
  }

  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of this.attrs) {
      if (name.startsWith("data-")) {
        out[name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] = value;
      }
    }
    return out;
  }

  get value(): string {
    if (this.localName !== "select") return this.typed;
    const values = this.options().map((o) => o.getAttribute("value") ?? o.textContent);
    if (this.chosen !== null) return values.includes(this.chosen) ? this.chosen : "";
    return values[0] ?? "";
  }

  set value(v: string) {
    if (this.localName === "select") this.chosen = v;
    else this.typed = v;
  }

  options(): FakeElement[] {
    return this.querySelectorAll("option");
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  addEventListener(type: string, f: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }

  /** Fires `type` at this element, as the browser does for a person's action. */
  dispatch(type: string, extra: Record<string, unknown> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      ...extra,
    };
    for (const f of this.listeners.get(type) ?? []) f(event);
    return event;
  }

  click(): void {
    if (!this.disabled) this.dispatch("click");
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) {
      const node = typeof n === "string" ? new FakeText(n) : n;
      if (node.parent !== null) {
        node.parent.children = node.parent.children.filter((x) => x !== node);
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const old of this.children) old.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  get textContent(): string {
    return this.children.map((n) => n.textContent).join("");
  }

  /** Whether the element is on the page. */
  get isConnected(): boolean {
    let at: FakeElement | null = this;
    while (at !== null) {
      if (at === this.doc.documentElement) return true;
      at = at.parent;
    }
    return false;
  }

  focus(): void {
    if (!this.isConnected) return;
    const control = FOCUSABLE.has(this.localName);
    if (control ? this.disabled : this.index === null) return;
    this.doc.focused = this;
  }

  scrollIntoView(): void {
    this.doc.scrolled.push(this);
  }

  querySelectorAll(selectors: string): FakeElement[] {
    const test = compile(selectors);
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child instanceof FakeElement) {
          if (test(child)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selectors: string): FakeElement | null {
    return this.querySelectorAll(selectors)[0] ?? null;
  }

  /** The element's text with its runs of spaces made one, as a person reads it. */
  get text(): string {
    return this.textContent.replace(/\s+/g, " ").trim();
  }
}

export class FakeDocument {
  focused: FakeElement | null = null;
  /** Each element a script scrolled into view, in order. */
  readonly scrolled: FakeElement[] = [];
  readonly documentElement: FakeElement;
  readonly body: FakeElement;

  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toLowerCase(), this);
  }

  createTextNode(data: string): FakeText {
    return new FakeText(data);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.querySelector(`[id="${id}"]`);
  }

  get activeElement(): FakeElement {
    const f = this.focused;
    return f?.isConnected && !f.disabled ? f : this.body;
  }
}
