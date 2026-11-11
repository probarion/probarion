// The audit links of /proof (G4) in the browser: open the decision card a #seq-N or #spend-N link points at, and the
// address a "Copy audit link" control copies. Without JavaScript a link to the card still scrolls to it (its id is on
// the card, outside its <details>); this only opens it, and the "older decisions" group around it. No imports, so the
// client component that calls it stays small.

/** The part of the DOM this needs: enough for a test to stand in for a browser. */
export interface HashElement {
  tagName: string;
  parentElement: HashElement | null;
  children: ArrayLike<HashElement>;
  open?: boolean;
  hasAttribute(name: string): boolean;
  scrollIntoView?(options?: ScrollIntoViewOptions): void;
}

export interface HashDocument {
  getElementById(id: string): HashElement | null;
}

/** The only fragments this acts on: a decision's seq anchor or a spend's anchor. */
const AUDIT_ID = /^(seq|spend)-(0|[1-9][0-9]*)$/;

const isDetails = (el: HashElement): boolean => el.tagName.toUpperCase() === "DETAILS";

/**
 * Opens the decision card that `hash` ("#seq-14", "#spend-4") points at: its own <details>, and every closed
 * <details> around it (the "older decisions" group). When one around it was closed, the browser could not scroll to
 * the card, so this scrolls it into view. True when a card was found. Any other fragment is left alone.
 */
export function openLinkedDecision(doc: HashDocument, hash: string): boolean {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!AUDIT_ID.test(id)) return false;
  const target = doc.getElementById(id);
  let card: HashElement | null = target;
  while (card !== null && !card.hasAttribute("data-decision")) card = card.parentElement;
  if (card === null) return false;
  let revealed = false;
  for (let p = card.parentElement; p !== null; p = p.parentElement) {
    if (isDetails(p) && p.open !== true) {
      p.open = true;
      revealed = true;
    }
  }
  for (const child of Array.from(card.children)) {
    if (isDetails(child)) {
      child.open = true;
      break;
    }
  }
  if (revealed) card.scrollIntoView?.({ block: "start" });
  return true;
}

/** The page's address with `anchor` as its fragment: what "Copy audit link" copies. */
export function auditUrl(href: string, anchor: string): string {
  return `${href.split("#")[0]}#${anchor}`;
}
