// The browser half of /proof's audit links (G4) on a stand-in DOM: a link to #seq-N or #spend-N opens that card, and
// the "older decisions" group around it, and nothing else on the page is touched.
import { describe, expect, it } from "vitest";
import { auditUrl, type HashDocument, type HashElement, openLinkedDecision } from "./decision-hash";

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
