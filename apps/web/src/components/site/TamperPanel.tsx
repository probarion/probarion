import type { Snapshot } from "@probarion/core";
import { ExternalLink } from "@/components/ui";
import { CHECK_LIST, FIXTURE_PATH, LINKS, RECORDED_RESULT, TAMPER_COPY } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import { ledgerRows, TAMPER_EDITS } from "@/lib/site/tamper";
import fixture from "@/lib/site/valid-snapshot.json";
import { NextStep } from "./NextStep";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";
import { TamperTest } from "./TamperTest";

/**
 * Reads the fixture on the server and hands the client only small props, so that the page is complete with no
 * JavaScript and the fixture stays out of the first-load bundle. With `next`, a run the verifier failed ends with the
 * link to /proof; /proof itself leaves it out, as its form is the next step there.
 */
export function TamperPanel({ next = false }: { next?: boolean }) {
  return (
    <TamperTest
      rows={ledgerRows(fixture as unknown as Snapshot)}
      checks={CHECK_LIST}
      edits={TAMPER_EDITS}
      recorded={RECORDED_RESULT}
      copy={TAMPER_COPY}
      source={
        <ExternalLink className={`${s.link} ${s.source}`} href={LINKS.fixture}>
          <code>{FIXTURE_PATH}</code>
        </ExternalLink>
      }
      next={
        next ? (
          <NextStep step={NEXT_STEP.tamper} className={s.sheetNext} linkClassName={s.link} />
        ) : undefined
      }
    />
  );
}

export function LedgerTest() {
  return (
    <LandingSection
      id="verify"
      head={{ eyebrow: TAMPER_COPY.eyebrow, title: TAMPER_COPY.title, lede: TAMPER_COPY.intro }}
    >
      <TamperPanel next />
    </LandingSection>
  );
}
