import { RouteLink } from "@/components/RouteLink";
import type { NextStepCopy } from "@/lib/site/next-step";

/** One line: the lead in plain text, then a link in this tab, its arrow hidden from screen readers. */
export function NextStep({
  step,
  className,
  linkClassName,
}: {
  step: NextStepCopy;
  className?: string;
  linkClassName?: string;
}) {
  return (
    <p className={className}>
      {step.lead === undefined ? null : `${step.lead} `}
      <RouteLink route={step.route} className={linkClassName}>
        {step.text} <span aria-hidden="true">→</span>
      </RouteLink>
    </p>
  );
}
