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

/** A step's two ways, side by side from 640px: who pays from the vault decides which tab comes next. */
function Choices({ base, step }: { base: string; step: ChecklistStep }) {
  return (
    <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
      {(step.choices ?? []).map((c) => (
        <div key={c.tab} className="rounded-2xl border border-line bg-paper px-3.5 py-3">
          <h3 className="text-sm font-semibold text-ink">{c.title}</h3>
          <p className="text-[13px] text-mute">{c.text}</p>
          <RouteLink
            route={`/console/[vault]${c.tab}`}
            href={`${base}${c.tab}`}
            className={textLink}
          >
            {c.action}
          </RouteLink>
        </div>
      ))}
    </div>
  );
}

/**
 * The "Your first agent payment" card on a vault's overview (site audit P1-8). The page shows it to the owner until
 * the first payment; `firstPaymentChecklist` decides each step. The next step's link is the ink pill, the others are
 * plain links, and a step that is done has none. A step with two ways to do it shows both, as plain links, in place
 * of its one link.
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
          const choices = step.state !== "done" && (step.choices?.length ?? 0) > 0;
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
                {choices ? <Choices base={base} step={step} /> : null}
              </div>
              {!choices && step.state !== "done" && step.tab !== null && step.action !== null ? (
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
