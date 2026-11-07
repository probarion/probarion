/** One "On this page" entry. Client-safe: no parser import. */
export interface TocItem {
  id: string;
  text: string;
  depth: number;
}
