/**
 * Freezes `value` and everything reachable from it. The request template (the JSON schema, the allow-list
 * of system prompts) is part of the verification contract, so nothing running in the same process may be
 * able to change what `buildProposalRequest` produces. Internal: not exported from the package root.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
