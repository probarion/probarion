import { createHash, timingSafeEqual } from "node:crypto";

/** A secret shorter than this is refused: `openssl rand -hex 32` (docs/runbooks/web-deploy.md) gives 64 characters. */
const MIN_SECRET_LENGTH = 32;

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; a Supabase Cron job is set up to send the same header
 * (docs/ops/metrics.md). Both sides are hashed before they are compared, so the comparison takes the same time
 * whatever the header's length or content (`timingSafeEqual` itself throws on two lengths that differ).
 */
export function cronAuthorized(req: Request, secret: string): boolean {
  if (secret.length < MIN_SECRET_LENGTH) return false;
  const got = digest(req.headers.get("authorization") ?? "");
  const want = digest(`Bearer ${secret}`);
  return timingSafeEqual(got, want);
}
