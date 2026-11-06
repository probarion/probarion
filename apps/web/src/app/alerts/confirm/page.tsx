import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
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

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Container>
      <div className="mx-auto my-6 max-w-lg rounded-3xl border border-line bg-surface p-6 sm:my-10 sm:p-8">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold-small">Alerts</p>
        <h1 className="mt-3 text-3xl font-light tracking-tight">{title}</h1>
        {children}
      </div>
    </Container>
  );
}

const EXPIRED = "This link has expired or was already used.";

export default async function ConfirmAlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  if (!isLinkCode(code)) {
    return (
      <Card title="Confirm alerts">
        <p className="mt-3 text-mute">{EXPIRED}</p>
      </Card>
    );
  }
  let vault: string | null;
  try {
    const [max, windowSeconds] = LIMITS.alertLink;
    const bucket = `alerts:link:${clientIp(await headers())}`;
    if (!(await takeToken(serviceDb(), bucket, max, windowSeconds)).allowed) {
      return (
        <Card title="Confirm alerts">
          <p className="mt-3 text-mute">Too many tries. Wait a minute and open the link again.</p>
        </Card>
      );
    }
    vault = await peekEmailLink(serviceDb(), code);
  } catch {
    return (
      <Card title="Confirm alerts">
        <p className="mt-3 text-mute">
          This link could not be checked right now. Try it again in a minute.
        </p>
      </Card>
    );
  }
  if (vault === null) {
    return (
      <Card title="Confirm alerts">
        <p className="mt-3 text-mute">{EXPIRED}</p>
      </Card>
    );
  }
  return (
    <Card title={`Confirm alerts for ${vault}?`}>
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
    </Card>
  );
}
