import c from "@/components/site/canary.module.css";
import { brandCardClass } from "@/components/ui";
import { CANARY_COPY, rehearsalSteps } from "@/lib/canary/copy";
import { Rich } from "./Rich";

const R = CANARY_COPY.rehearsal;

/**
 * The replay of the team's own attempt on the testnet Canary of 2026-11-10 (lib/canary/rehearsal.ts), in three steps:
 * what the model wanted, what code did, what the contract did. It is always shown: under the form on the live page, and
 * under the recorded attacks on the replay, since it describes a run that already happened on testnet, whatever the
 * live Canary does now. It reads nothing: its facts are fixed, and rehearsal.test.ts holds them to the evidence.
 */
export function RehearsalCard() {
  return (
    <section className={brandCardClass}>
      <p className={c.tag}>{R.tag}</p>
      <h2 className={c.cardTitle}>{R.title}</h2>
      <ol className={c.steps}>
        {rehearsalSteps().map((step) => (
          <li key={step.title}>
            <b>{step.title}</b> <Rich parts={step.body} />
          </li>
        ))}
      </ol>
      <p className={`${c.muted} ${c.line}`}>{R.footer}</p>
    </section>
  );
}
