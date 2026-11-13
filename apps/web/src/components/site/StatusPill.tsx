import { STATUS_BOARD, type StatusTone, statusOf } from "@/lib/site/facts";
import s from "./site.module.css";

const TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

/**
 * A status row's pill, as the comparison and the integrate cards show it. It links its row on the status board below,
 * where the key says what the row's marks mean, so the page speaks one status language. `inline`: a pill inside a
 * line of text or a heading, which wraps inside itself.
 */
export function StatusPill({
  row,
  inline = true,
}: {
  row: Parameters<typeof statusOf>[0];
  inline?: boolean;
}) {
  const st = statusOf(row);
  return (
    <a
      className={`${s.pill} ${inline ? s.pillInline : ""} ${s.pillLink} ${TONE[st.tone]}`}
      href={`#${st.id}`}
    >
      {st.pill}
      <span className="sr-only">{STATUS_BOARD.pillSuffix}</span>
    </a>
  );
}
