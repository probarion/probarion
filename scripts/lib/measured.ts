/** `{{MEASURED:<root>.<path>}}` where root is `proof` (docs/mainnet-proof.json) or `eval` (eval/results/latest.json). */
export const MEASURED_RE = /\{\{MEASURED:([A-Za-z0-9_.-]+)\}\}/g;

export interface Sources {
  proof?: unknown;
  eval?: unknown;
}

export function lookup(sources: Sources, path: string): string | null {
  let cur: unknown = sources;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    if (!Object.hasOwn(cur, part)) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "string") return cur.length > 0 ? cur : null;
  if (typeof cur === "number") return Number.isFinite(cur) ? String(cur) : null;
  if (typeof cur === "boolean") return String(cur);
  return null;
}

export interface FillResult {
  text: string;
  resolved: number;
  unresolved: string[];
}

export function fillMeasured(text: string, sources: Sources): FillResult {
  let resolved = 0;
  const unresolved = new Set<string>();
  const out = text.replace(MEASURED_RE, (token: string, path: string) => {
    const value = lookup(sources, path);
    if (value === null) {
      unresolved.add(path);
      return token;
    }
    resolved += 1;
    return value;
  });
  return { text: out, resolved, unresolved: [...unresolved].sort() };
}
