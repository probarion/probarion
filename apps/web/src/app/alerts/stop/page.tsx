import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";
import { inkPillClass } from "@/components/ui";
import { parseStopParams, verifyStopToken } from "@/lib/alerts/stop";
import { subkey } from "@/lib/crypto/server";

// The stop link of an alert email. A scanner that opens it stops nothing: this page only checks the token (no database,
// so it answers the same for a subscription that is gone) and the button POSTs to /api/alerts/stop. Not indexed, and not
// in the sitemap.
export const metadata: Metadata = {
  title: "Stop alerts",
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

export default async function StopAlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const link = parseStopParams(query);
  if (link === null || !(await verifyStopToken(await subkey("alerts"), link.id, link.token))) {
    return (
      <Card title="Stop alerts">
        <p className="mt-3 text-mute">This stop link is not valid.</p>
      </Card>
    );
  }
  if (query.done === "1") {
    return (
      <Card title="Alerts stopped.">
        <p className="mt-3 text-mute">
          You will get no more of these emails. To turn alerts on again, open the Alerts tab of the
          vault in the console.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Stop these alerts?">
      {query.failed === "1" ? (
        <p className="mt-3 text-rose-800">
          The alerts could not be stopped right now. Try again in a minute.
        </p>
      ) : null}
      <p className="mt-3 mb-6 text-mute">
        This ends the alerts that sent you the email, and only those. Nothing else about the vault
        changes.
      </p>
      <form action={`/api/alerts/stop?s=${link.id}&t=${link.token}`} method="post">
        <input type="hidden" name="from" value="page" />
        <button type="submit" className={inkPillClass}>
          Stop alerts
        </button>
      </form>
    </Card>
  );
}
