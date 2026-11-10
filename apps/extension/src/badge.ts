// The toolbar badge (spec §5.7): "!" when the connection ended, "+" while a captured invoice waits for the popup,
// otherwise how many items wait for the person (nothing at 0).

export const BADGE_COLOR = "#7a5a18";
export const ALERT_COLOR = "#a32a1c";

export function badgeText(s: { expired: boolean; pending: boolean; count: number }): string {
  if (s.expired) return "!";
  if (s.pending) return "+";
  if (!Number.isSafeInteger(s.count) || s.count <= 0) return "";
  return s.count > 99 ? "99+" : String(s.count);
}

export const badgeColor = (text: string): string => (text === "!" ? ALERT_COLOR : BADGE_COLOR);
