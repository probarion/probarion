import type { Metadata } from "next";
import { headers } from "next/headers";
import { PublicCard } from "@/components/site/PublicCard";
import { inkPillClass } from "@/components/ui";
import { isLinkCode, peekEmailLink } from "@/lib/alerts/links";
import { serviceDb } from "@/lib/db/clients";
import { clientIp } from "@/lib/http";
import { LIMITS, takeToken } from "@/lib/ratelimit";

// A confirmation link is opened by mail scanners as well as by people, so opening it changes nothing: this page only
// reads the code to name the vault, and the button POSTs. Not indexed, and not in the sitemap.
export const metadata: Metadata = {
  title: "Confirm alerts",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const EXPIRED = "This link has expired or was already used.";

export default async function ConfirmAlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  if (!isLinkCode(code)) {
    return (
      <PublicCard title="Confirm alerts">
        <p className="mt-3 text-mute">{EXPIRED}</p>
      </PublicCard>
    );
  }
  let vault: string | null;
  try {
    const [max, windowSeconds] = LIMITS.alertLink;
    const bucket = `alerts:link:${clientIp(await headers())}`;
    if (!(await takeToken(serviceDb(), bucket, max, windowSeconds)).allowed) {
      return (
        <PublicCard title="Confirm alerts">
          <p className="mt-3 text-mute">Too many tries. Wait a minute and open the link again.</p>
        </PublicCard>
      );
    }
    vault = await peekEmailLink(serviceDb(), code);
  } catch {
    return (
      <PublicCard title="Confirm alerts">
        <p className="mt-3 text-mute">
          This link could not be checked right now. Try it again in a minute.
        </p>
      </PublicCard>
    );
  }
  if (vault === null) {
    return (
      <PublicCard title="Confirm alerts">
        <p className="mt-3 text-mute">{EXPIRED}</p>
      </PublicCard>
    );
  }
  return (
    <PublicCard title={`Confirm alerts for ${vault}?`}>
      <p className="mt-3 mb-6 text-mute">
        Press the button to confirm that this email address should get payment alerts for this
        vault. If you did not ask for this, close the page: nothing is turned on until you press it.
      </p>
      <form action="/api/alerts/confirm" method="post">
        <input type="hidden" name="code" value={code} />
        <button type="submit" className={inkPillClass}>
          Confirm alerts
        </button>
      </form>
    </PublicCard>
  );
}
