// The browser half of /proof's audit links (G4) on a stand-in DOM: a link to #seq-N or #spend-N opens that card, and
// the "older decisions" group around it, and nothing else on the page is touched.
import { describe, expect, it } from "vitest";
import {
  type AuditClick,
  auditUrl,
  copyAuditClick,
  type HashDocument,
  type HashElement,
  type HashWindow,
  openLinkedDecision,
  watchLinkedDecision,
} from "./decision-hash";

class El implements HashElement {
  children: El[] = [];
  parentElement: El | null = null;
  open?: boolean;
  scrolls = 0;
  constructor(
    public tagName: string,
    private attrs: Record<string, string> = {},
  ) {
    if (tagName === "DETAILS") this.open = false;
  }
  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attrs, name);
  }
  get id(): string | undefined {
    return this.attrs.id;
  }
  add(...kids: El[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  scrollIntoView(): void {
    this.scrolls++;
  }
}

function find(el: El, id: string): El | null {
  if (el.id === id) return el;
  for (const k of el.children) {
    const hit = find(k, id);
    if (hit) return hit;
  }
  return null;
}

/** The Decisions section as ProofView renders it: two cards in the list, one more in the closed older group. */
function page() {
  const card14 = new El("DETAILS");
  const card12 = new El("DETAILS");
  const card2 = new El("DETAILS");
  const older = new El("DETAILS");
  const li14 = new El("LI", { id: "seq-14", "data-decision": "14" }).add(
    new El("SPAN", { id: "spend-4" }),
    card14,
  );
  const li12 = new El("LI", { id: "seq-12", "data-decision": "12" }).add(card12);
  const li2 = new El("LI", { id: "seq-2", "data-decision": "2" }).add(card2);
  const root = new El("SECTION", { id: "decisions" }).add(
    new El("OL").add(li14, li12),
    older.add(new El("SUMMARY"), new El("OL").add(li2)),
    new El("SPAN", { id: "seq-99" }),
  );
  const doc: HashDocument = { getElementById: (id) => find(root, id) };
  return { doc, card14, card12, card2, older, li14, li2 };
}

describe("openLinkedDecision", () => {
  it("opens the card a #seq-N link points at, and only that card", () => {
    const p = page();
    expect(openLinkedDecision(p.doc, "#seq-14")).toBe(true);
    expect(p.card14.open).toBe(true);
    expect(p.card12.open).toBe(false);
    expect(p.older.open).toBe(false);
    // The browser scrolled to the card already: nothing around it was closed.
    expect(p.li14.scrolls).toBe(0);
  });

  it("opens the card a spend's anchor sits in", () => {
    const p = page();
    expect(openLinkedDecision(p.doc, "#spend-4")).toBe(true);
    expect(p.card14.open).toBe(true);
  });

  it("opens the older group around a card, and then scrolls to the card", () => {
    const p = page();
    expect(openLinkedDecision(p.doc, "#seq-2")).toBe(true);
    expect(p.older.open).toBe(true);
    expect(p.card2.open).toBe(true);
    expect(p.li2.scrolls).toBe(1);
  });

  it("leaves any other fragment alone", () => {
    for (const hash of [
      "",
      "#",
      "#verify",
      "#decisions",
      "#check-e",
      "#seq-01",
      "#seq-x",
      "#spend-",
    ]) {
      const p = page();
      expect(openLinkedDecision(p.doc, hash), hash).toBe(false);
      expect(
        [p.card14, p.card12, p.card2, p.older].some((d) => d.open),
        hash,
      ).toBe(false);
    }
    // An audit-shaped id that is not on a decision card, and one that is on no element.
    expect(openLinkedDecision(page().doc, "#seq-99")).toBe(false);
    expect(openLinkedDecision(page().doc, "#spend-7")).toBe(false);
  });

  it("takes the fragment with or without its #", () => {
    const p = page();
    expect(openLinkedDecision(p.doc, "seq-12")).toBe(true);
    expect(p.card12.open).toBe(true);
  });

  it("opens the older group around an older decision's summary line, which has no <details> of its own", () => {
    const older = new El("DETAILS");
    const line = new El("LI", { id: "seq-1", "data-decision": "1", "data-light": "" }).add(
      new El("SPAN", { id: "spend-9" }),
      new El("DIV"),
    );
    const root = new El("SECTION").add(older.add(new El("SUMMARY"), new El("OL").add(line)));
    const doc: HashDocument = { getElementById: (id) => find(root, id) };
    expect(openLinkedDecision(doc, "#spend-9")).toBe(true);
    expect(older.open).toBe(true);
    expect(line.scrolls).toBe(1);
  });
});

/** A window that holds a fragment and its hashchange listeners. */
class FakeWindow implements HashWindow {
  location = { hash: "" };
  listeners = new Set<() => void>();
  addEventListener(_type: "hashchange", fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: "hashchange", fn: () => void): void {
    this.listeners.delete(fn);
  }
  go(hash: string): void {
    this.location.hash = hash;
    for (const fn of this.listeners) fn();
  }
}

describe("watchLinkedDecision", () => {
  it("opens the linked card at once, then on each fragment change, until it is stopped", () => {
    const p = page();
    const win = new FakeWindow();
    win.location.hash = "#seq-14";
    const stop = watchLinkedDecision(win, p.doc);
    expect(p.card14.open).toBe(true);
    expect(win.listeners.size).toBe(1);
    win.go("#spend-4");
    win.go("#seq-2");
    expect(p.older.open).toBe(true);
    expect(p.card2.open).toBe(true);
    stop();
    expect(win.listeners.size).toBe(0);
    win.go("#seq-12");
    expect(p.card12.open).toBe(false);
  });
});

describe("copyAuditClick", () => {
  const click = (over: Partial<AuditClick> = {}) => {
    const e = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      prevented: 0,
      preventDefault() {
        e.prevented++;
      },
      ...over,
    };
    return e;
  };
  const place = (href: string) => {
    const set: string[] = [];
    return { set, href, setHash: (a: string) => set.push(a) };
  };

  it("copies the page's address with the card's anchor on a plain click, instead of following the link", async () => {
    const e = click();
    const at = place("https://probarion.xyz/proof/demo.vaults.probarion.testnet#verify");
    const copied: string[] = [];
    const result = await copyAuditClick(e, "spend-4", at, async (t) => {
      copied.push(t);
      return true;
    });
    expect(result).toBe("copied");
    expect(e.prevented).toBe(1);
    expect(copied).toEqual(["https://probarion.xyz/proof/demo.vaults.probarion.testnet#spend-4"]);
    expect(at.set).toEqual([]);
  });

  it("follows the link when the copy fails, so the address bar holds it", async () => {
    const e = click();
    const at = place("https://probarion.xyz/proof/v.testnet");
    expect(await copyAuditClick(e, "seq-3", at, async () => false)).toBe("followed");
    expect(e.prevented).toBe(1);
    expect(at.set).toEqual(["seq-3"]);
  });

  it("leaves a click with a modifier or another button to the browser", async () => {
    for (const over of [
      { button: 1 },
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      const e = click(over);
      const at = place("https://probarion.xyz/proof/v.testnet");
      let copies = 0;
      const result = await copyAuditClick(e, "seq-3", at, async () => {
        copies++;
        return true;
      });
      expect(result, JSON.stringify(over)).toBe("browser");
      expect(e.prevented).toBe(0);
      expect(copies).toBe(0);
      expect(at.set).toEqual([]);
    }
  });
});

describe("auditUrl", () => {
  it("is the page's address with the card's anchor as its fragment", () => {
    expect(auditUrl("https://probarion.xyz/proof/demo.vaults.probarion.testnet", "spend-4")).toBe(
      "https://probarion.xyz/proof/demo.vaults.probarion.testnet#spend-4",
    );
    expect(auditUrl("https://probarion.xyz/proof/v.testnet?x=1#seq-3", "seq-14")).toBe(
      "https://probarion.xyz/proof/v.testnet?x=1#seq-14",
    );
  });
});
