/**
 * A dynamic segment's value from useParams(), as its page shows it: decoded, or as it came when it is not valid
 * percent-encoding (the page then answers for that address itself). Null when the route has no such segment, or it is
 * empty. A loading shell uses it to show the vault's name before the page has read anything.
 */
export function segmentText(value: string | readonly string[] | undefined): string | null {
  const raw = typeof value === "string" ? value : value?.[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
