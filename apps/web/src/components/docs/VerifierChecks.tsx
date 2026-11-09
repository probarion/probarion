import { CHECK_NAMES } from "@probarion/core";
import { Rich } from "@/components/site/Rich";
import { checkAnchor, selectChecks, VERIFIER_DOCS } from "@/lib/docs/verifier";
import { CHECK_LABELS } from "@/lib/site/facts";
import d from "./docs.module.css";

/** One block per verifier check, each with its own H3 anchor (#check-a ... #check-i). */
export function VerifierChecks({ only }: { only?: string }) {
  return (
    <div className={d.checks}>
      {selectChecks(only).map((id) => (
        <section key={id} className={d.check} aria-labelledby={checkAnchor(id)}>
          <h3 id={checkAnchor(id)}>
            {id}. {CHECK_LABELS[id]} <code>{CHECK_NAMES[id]}</code>
          </h3>
          <p>
            <strong>Proves.</strong> <Rich text={VERIFIER_DOCS[id].proves} />
          </p>
          <p>
            <strong>Does not prove.</strong> <Rich text={VERIFIER_DOCS[id].limits} />
          </p>
        </section>
      ))}
    </div>
  );
}
