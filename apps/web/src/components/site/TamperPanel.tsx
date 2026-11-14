import type { Snapshot } from "@probarion/core";
import type { ReactNode } from "react";
import { CHECK_LIST, RECORDED_RESULT, TAMPER_COPY, TAMPER_EVIDENCE } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import { ledgerRows, TAMPER_EDITS } from "@/lib/site/tamper";
import fixture from "@/lib/site/valid-snapshot.json";
import { NextStep } from "./NextStep";
import { Away, Parts } from "./parts";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";
import { TamperTest } from "./TamperTest";
import t from "./tamper.module.css";

/**
 * Reads the fixture on the server and hands the client only small props, so that the page is complete with no
 * JavaScript and the fixture stays out of the first-load bundle. The sheet's foot names its two files by their role,
 * each a link to GitHub. With `next`, a run the verifier failed is followed by the link to /proof; /proof itself
 * leaves it out, as its form is the next step there. With `foldChecks` the checks a to i fold (the landing); /proof
 * shows them open.
 */
export function TamperPanel({
  next = false,
  foldChecks = false,
}: {
  next?: boolean;
  foldChecks?: boolean;
}) {
  return (
    <TamperTest
      rows={ledgerRows(fixture as unknown as Snapshot)}
      checks={CHECK_LIST}
      edits={TAMPER_EDITS}
      recorded={RECORDED_RESULT}
      copy={TAMPER_COPY}
      foldChecks={foldChecks}
      source={
        <dl className={t.foot}>
          {/* A keyed div per pair: keyed fragments passed to the client component drew a missing-key warning. */}
          {TAMPER_EVIDENCE.map(({ label, path, href }) => (
            <div key={path} className={t.footRow}>
              <dt>{label}</dt>
              <dd>
                <Away href={href} code={path} />
              </dd>
            </div>
          ))}
        </dl>
      }
      next={
        next ? (
          <NextStep step={NEXT_STEP.tamper} className={t.next} linkClassName={s.link} />
        ) : undefined
      }
    />
  );
}

/**
 * The landing's #verify section: the tamper test with its checks folded, the line to the demo vault's proof page,
 * which runs the same checks on real data, then `children`, the blocks that follow it in the same section (what it
 * rests on, and what works today).
 */
export function LedgerTest({ children }: { children?: ReactNode } = {}) {
  return (
    <LandingSection
      id="verify"
      head={{ eyebrow: TAMPER_COPY.eyebrow, title: TAMPER_COPY.title, lede: TAMPER_COPY.intro }}
    >
      <TamperPanel next foldChecks />
      <p className={t.realData}>
        <Parts parts={TAMPER_COPY.realData} />
      </p>
      {children}
    </LandingSection>
  );
}
