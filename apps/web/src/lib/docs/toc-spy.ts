/** One "On this page" entry. Client-safe: no parser import. */
export interface TocItem {
  id: string;
  text: string;
  depth: number;
}

/** The heading the TOC marks: the last one whose top has passed `offset` px, else the first. */
export function pickActive(
  tops: readonly { id: string; top: number }[],
  offset: number,
): string | null {
  let current: string | null = tops[0]?.id ?? null;
  for (const t of tops) if (t.top <= offset) current = t.id;
  return current;
}
