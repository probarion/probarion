/**
 * Read an environment variable, treating an empty or whitespace-only value as unset (R12).
 * Anyone who sources `.env.example` gets `NAME=` lines; those must fall back to the default, not
 * become an empty path, model or network. A set value is returned trimmed.
 */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
