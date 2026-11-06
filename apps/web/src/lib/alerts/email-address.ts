/**
 * The one address an alert is sent to, or null. Stricter than the table's own check (migration 0001), and the same rule
 * as `alert_subscription_create` (migration 0011): at most 254 characters; one `@`; a local part of 1 to 64 printable
 * ASCII characters with none of `, ; < > " ' ( )` or a backslash (nothing a mailer reads as a list, a display name or a
 * comment, so `a@b.co,victim@x.co` is not an address); a domain of dot-separated labels of letters, digits and inner
 * hyphens, with at least one dot. The result is trimmed and lower-cased.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  if (address.length > 254) return null;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@")) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !/^[\x21-\x7e]+$/.test(local) || /[,;<>"'()\\]/.test(local)) return null;
  const label = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
  return new RegExp(`^${label}(\\.${label})+$`).test(domain) ? address : null;
}
