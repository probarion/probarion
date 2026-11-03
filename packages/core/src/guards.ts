// The one place for core's small value guard (T14-R1 minor 11). Internal: not exported from the package root.

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
