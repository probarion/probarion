import { RouteLink } from "@/components/RouteLink";
import { buttonClass, Card } from "@/components/ui";
import type { Checklist, ChecklistStep } from "@/lib/console/checklist";

const MARKER = "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium";
const textLink =
  "inline-flex min-h-11 items-center text-sm text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

/** What a screen reader hears before each step; the marker beside it is only for the eye. */
function spoken(step: ChecklistStep, next: boolean): string {
  if (step.state === "done") return "Done.";
  if (step.state === "unknown") return "Could not check.";
  return next ? "Next." : "To do.";
}

function Marker({ step, n, next }: { step: ChecklistStep; n: number; next: boolean }) {
  if (step.state === "done")
    return (
      <span aria-hidden="true" className={`${MARKER} bg-ok-bg text-ok`}>
        ✓
      </span>
    );
  if (step.state === "unknown")
    return (
      <span aria-hidden="true" className={`${MARKER} bg-wait-bg text-wait`}>
        ?
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className={next ? `${MARKER} bg-ink text-paper` : `${MARKER} border border-line text-mute`}
    >
      {n}
    </span>
  );
}

/**
 * The "Your first agent payment" card on a vault's overview (site audit P1-8). The page shows it to the owner until
 * the first payment; `firstPaymentChecklist` decides each step. The next step's link is the ink pill, the others are
 * plain links, and a step that is done has none.
 */
export function FirstPaymentChecklist({
  vault,
  checklist,
}: {
  vault: string;
  checklist: Checklist;
}) {
  const base = `/console/${encodeURIComponent(vault)}`;
  return (
    <Card
      title="Your first agent payment"
      actions={
        <span className="text-sm text-mute">
          {checklist.done} of {checklist.steps.length} done
        </span>
      }
    >
      <p className="mb-2 text-sm text-mute">
        From a new vault to a payment your agent makes inside a mandate. This card goes away after
        the first payment.
      </p>
      <ol>
        {checklist.steps.map((step, i) => {
          const next = checklist.next === step.id;
          return (
            <li
              key={step.id}
              className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-t border-line py-3 sm:grid-cols-[28px_minmax(0,1fr)_auto]"
            >
              <Marker step={step} n={i + 1} next={next} />
              <div>
                <p className="text-sm font-medium text-ink">
                  <span className="sr-only">{spoken(step, next)}</span> {step.title}
                </p>
                <p className="text-sm text-mute">{step.text}</p>
                {step.state === "unknown" ? (
                  <p className="text-xs text-wait">Reload the page to check this step again.</p>
                ) : null}
              </div>
              {step.state !== "done" && step.tab !== null && step.action !== null ? (
                <div className="col-start-2 sm:col-start-3">
                  <RouteLink
                    route={`/console/[vault]${step.tab}`}
                    href={`${base}${step.tab}`}
                    className={next ? buttonClass : textLink}
                  >
                    {step.action}
                  </RouteLink>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
