/** The logic of the code tabs (components/docs/CodeTabs.tsx): their names and the ARIA tabs keys. */

/**
 * The tab names from a CodeTabs `labels` prop ("TypeScript, Shell"). A count that does not match
 * the code blocks, or a repeated name, throws: the build fails instead of shipping tabs that lie.
 */
export function tabNames(labels: string, blocks: number): string[] {
  const names = labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  if (names.length !== blocks) {
    throw new Error(`CodeTabs: ${names.length} labels for ${blocks} code block(s)`);
  }
  const repeated = names.find((name, at) => names.indexOf(name) !== at);
  if (repeated !== undefined) throw new Error(`CodeTabs: the label "${repeated}" is repeated`);
  return names;
}

/** The tab of a remembered name, or null when this block has no tab of that name. */
export function tabFor(names: readonly string[], label: string | null): number | null {
  const at = label === null ? -1 : names.indexOf(label);
  return at >= 0 ? at : null;
}

const TAB_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** Whether a key moves between tabs, so the tab list takes it instead of the page. */
export function isTabKey(key: string): boolean {
  return TAB_KEYS.has(key);
}

/**
 * The tab a key moves to, as in the ARIA tabs pattern: the arrows step and wrap at both ends,
 * Home and End jump to the first and last tab. Any other key leaves the tab where it is.
 */
export function nextTab(active: number, key: string, count: number): number {
  if (count <= 0) return active;
  switch (key) {
    case "ArrowRight":
      return (active + 1) % count;
    case "ArrowLeft":
      return (active - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return active;
  }
}
