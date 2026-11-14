import { ExternalLink } from "@/components/ui";
import { explorerAccountUrl } from "@/lib/config";
import { LIVE_CHECK } from "@/lib/site/facts";
import { fill, LIVE_VAULT, type RecordedFile } from "@/lib/site/live-check";
import recordedJson from "@/lib/site/live-check-recorded.json";
import { answerFromRecorded, verdictWord } from "@/lib/site/live-check-view";
import { ArrowLabel } from "./bits";
import { LiveCheckClient } from "./LiveCheckClient";
import lc from "./live.module.css";
import { LandingSection, SubHead } from "./SectionHead";
import s from "./site.module.css";

const recorded = recordedJson as unknown as RecordedFile;

/** The recorded answers, for a visitor with no JavaScript: the controls do nothing without it. */
function NoScriptAnswers() {
  return (
    <noscript>
      <p className={lc.noScript}>
        {fill(LIVE_CHECK.copy.noScript, { date: recorded.recordedAt.slice(0, 10) })}
      </p>
      <table className={lc.table} aria-label={LIVE_CHECK.copy.noScriptTable}>
        <tbody>
          {LIVE_CHECK.scenarios.map((x) => {
            const a = answerFromRecorded(recorded, x.id);
            return (
              <tr key={x.id}>
                <th scope="row">{x.title}</th>
                <td>{verdictWord(a, LIVE_CHECK.copy, "injected" in x)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </noscript>
  );
}

/**
 * The live check. On its own, a landing section. `embedded`, a block of the payment section under its steps
 * (SubHead, h3), with the same anchor #try, and its panels' headings one level down. Two columns either way: what the
 * agent tries and the contract's answer, then the fields and the mandate as the chain has it, with the explorer link.
 */
export function LiveCheck({ embedded = false }: { embedded?: boolean } = {}) {
  const body = (
    <>
      <NoScriptAnswers />
      <LiveCheckClient
        recorded={recorded}
        scenarios={LIVE_CHECK.scenarios}
        mandates={LIVE_CHECK.mandates}
        copy={LIVE_CHECK.copy}
        codes={LIVE_CHECK.codes}
        level={embedded ? 4 : 3}
        explorer={
          <ExternalLink
            className={`${s.link} ${lc.liveLink}`}
            href={explorerAccountUrl("testnet", LIVE_VAULT)}
          >
            <ArrowLabel text={LIVE_CHECK.copy.explorer} />
          </ExternalLink>
        }
      />
    </>
  );
  const head = { eyebrow: LIVE_CHECK.eyebrow, title: LIVE_CHECK.title, lede: LIVE_CHECK.intro };
  return embedded ? (
    <SubHead id="try" {...head}>
      {body}
    </SubHead>
  ) : (
    <LandingSection id="try" head={head}>
      {body}
    </LandingSection>
  );
}
