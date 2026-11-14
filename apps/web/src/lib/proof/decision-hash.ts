// The audit links of /proof (G4) in the browser: open the decision card a #seq-N or #spend-N link points at, and the
// address a "Copy audit link" control copies. Without JavaScript a link to the card still scrolls to it (its id is on
// the card, outside its <details>); this only opens it, and the closed groups around it (the next and the older
// decisions). No imports, so the client component that calls it stays small.

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
 * <details> around it (the "next" or "older decisions" group). When one around it was closed, the browser could not
 * scroll to the card, so this scrolls it into view. True when a card was found. Any other fragment is left alone.
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

/** The part of the window `watchLinkedDecision` needs. */
export interface HashWindow {
  location: { hash: string };
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/**
 * Opens the card the address's fragment points at now, and again on each later fragment change. Returns what stops
 * it (the effect's cleanup).
 */
export function watchLinkedDecision(win: HashWindow, doc: HashDocument): () => void {
  const open = () => {
    openLinkedDecision(doc, win.location.hash);
  };
  open();
  win.addEventListener("hashchange", open);
  return () => win.removeEventListener("hashchange", open);
}

/** The page's address with `anchor` as its fragment: what "Copy audit link" copies. */
export function auditUrl(href: string, anchor: string): string {
  return `${href.split("#")[0]}#${anchor}`;
}

/** The parts of a click that `copyAuditClick` reads. */
export interface AuditClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
}

/** Where the copy control is: the page's address, and how to set its fragment. */
export interface AuditPlace {
  href: string;
  setHash(anchor: string): void;
}

/**
 * What "Copy audit link" does with a click. A plain primary click copies the page's address with `anchor` as its
 * fragment instead of following the link ("copied"); when the copy fails it sets the fragment, so the address bar
 * holds the link ("followed"). A click with a modifier or another button is left to the browser, which may open a
 * new tab ("browser").
 */
export async function copyAuditClick(
  e: AuditClick,
  anchor: string,
  place: AuditPlace,
  copy: (text: string) => Promise<boolean>,
): Promise<"copied" | "followed" | "browser"> {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return "browser";
  e.preventDefault();
  if (await copy(auditUrl(place.href, anchor))) return "copied";
  place.setHash(anchor);
  return "followed";
}
