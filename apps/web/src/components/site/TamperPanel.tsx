import type { Snapshot } from "@probarion/core";
import { ExternalLink } from "@/components/ui";
import { CHECK_LIST, FIXTURE_PATH, LINKS, RECORDED_RESULT, TAMPER_COPY } from "@/lib/site/facts";
import { ledgerRows, TAMPER_EDITS } from "@/lib/site/tamper";
import fixture from "@/lib/site/valid-snapshot.json";
import { Rich } from "./Rich";
import s from "./site.module.css";
import { TamperTest } from "./TamperTest";

/**
 * Reads the fixture on the server and hands the client only small props, so that the page is complete with no
 * JavaScript and the fixture stays out of the first-load bundle.
 */
export function TamperPanel() {
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
    />
  );
}

export function LedgerTest() {
  return (
    <section className={`${s.section} ${s.anchor}`} id="verify">
      <div className={s.wrap}>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{TAMPER_COPY.title}</h2>
          <p>
            <Rich text={TAMPER_COPY.intro} />
          </p>
        </div>
        <TamperPanel />
      </div>
    </section>
  );
}
