import { STATUS, type StatusTone } from "@/lib/site/facts";
import type { FeatureStatus } from "./types";

const TONE_STATUS: Readonly<Record<StatusTone, FeatureStatus>> = {
  live: "live",
  work: "preview",
  plan: "planned",
};

/** The landing page's STATUS rows in docs words: live → Live, work → Preview, plan → Planned. */
export function docsStatusRows(): {
  id: string;
  feature: string;
  status: FeatureStatus;
  detail: string;
}[] {
  return STATUS.rows.map((r) => ({
    id: r.id,
    feature: r.row,
    status: TONE_STATUS[r.tone],
    detail: r.pill,
  }));
}
