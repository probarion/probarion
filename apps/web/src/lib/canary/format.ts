/** Small formatting helpers of the Canary pages. Pure, and safe in the browser. */

/** "4000" as "4,000": the same text in every runtime, whatever its locale data. */
export const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** "2026-11-06 10:15" for an ISO time, read in UTC. Text that is not a time is shown as it is. */
export function utcMinute(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
