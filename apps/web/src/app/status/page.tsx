import type { Metadata } from "next";
import Link from "next/link";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { brandCardClass, ExternalLink, linePillClass, PANEL_TONES } from "@/components/ui";
import type { Probe } from "@/lib/health";
import { type HealthReport, healthReport } from "@/lib/health-server";
import { log } from "@/lib/log";
import { softRequestNetwork } from "@/lib/network";
import { STATUS_PAGE as P } from "@/lib/site/ops-copy";

export const metadata: Metadata = { title: P.meta.title, description: P.meta.description };
export const dynamic = "force-dynamic";

function ProbeRow({ probe }: { probe: Probe }) {
  const tone = PANEL_TONES[probe.ok ? "good" : "bad"];
  return (
    <li className={`mb-3 flex items-start gap-3 rounded-2xl border p-4 ${tone.box}`}>
      <span aria-hidden="true" className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
      <div className="min-w-0">
        <p className="break-words font-medium">
          {probe.name}: {probe.ok ? P.up : P.down}
        </p>
        <p className="text-sm">
          {probe.detail} ({probe.latency_ms} ms)
        </p>
      </div>
    </li>
  );
}

/**
 * The live checks of the address it is opened at, for that address's network only (one network per request). The
 * probes run in this process, through the same cache as /api/health/*. It never answers 500: if the report cannot be
 * made, it says so.
 */
export default async function StatusPage() {
  const network = await softRequestNetwork();
  let report: HealthReport | null = null;
  try {
    report = await healthReport(network);
  } catch (error) {
    log.error("status.report_failed", { network, error });
  }
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <p className={s.eyebrow}>{P.eyebrow}</p>
      <h1 className={c.title}>{P.title}</h1>
      <p className={c.lede}>{P.lede(network)}</p>
      {report === null ? (
        <p className={`rounded-2xl border p-4 ${PANEL_TONES.warn.box}`}>{P.failed}</p>
      ) : (
        <>
          <section className={brandCardClass}>
            <h2 className="mb-3 text-xl font-semibold">{P.rpcTitle}</h2>
            {report.settings ? (
              <ul>
                {report.rpc.map((row) => (
                  <ProbeRow key={row.provider} probe={row.probe} />
                ))}
              </ul>
            ) : (
              <p className={`rounded-2xl border p-4 ${PANEL_TONES.warn.box}`}>{P.settings}</p>
            )}
          </section>
          <section className={brandCardClass}>
            <h2 className="mb-3 text-xl font-semibold">{P.nearaiTitle}</h2>
            <ul>
              <ProbeRow probe={report.nearai.probe} />
            </ul>
            {report.settings && !report.nearai.configured ? (
              <p className="text-sm">{P.noKey}</p>
            ) : null}
          </section>
          <p className="text-sm">{P.checkedAt(report.checkedAt)}</p>
        </>
      )}
      <p className="text-sm">{P.funds}</p>
      <p className={`${c.back} flex flex-wrap gap-2`}>
        <Link className={linePillClass} href="/#status">
          {P.whatWorks}
        </Link>
        {report?.other.origin ? (
          <ExternalLink className={linePillClass} href={`${report.other.origin}/status`}>
            {P.other(report.other.network)}
          </ExternalLink>
        ) : null}
      </p>
    </div>
  );
}
