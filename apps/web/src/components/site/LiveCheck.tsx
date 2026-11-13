import { ExternalLink } from "@/components/ui";
import { explorerAccountUrl } from "@/lib/config";
import { LIVE_CHECK } from "@/lib/site/facts";
import { fill, LIVE_VAULT, type RecordedFile } from "@/lib/site/live-check";
import recordedJson from "@/lib/site/live-check-recorded.json";
import { answerFromRecorded, verdictWord } from "@/lib/site/live-check-view";
import { LiveCheckClient } from "./LiveCheckClient";
import lc from "./live.module.css";
import { LandingSection } from "./SectionHead";

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
                <td>{verdictWord(a, LIVE_CHECK.copy)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </noscript>
  );
}

export function LiveCheck() {
  return (
    <LandingSection
      id="try"
      head={{ eyebrow: LIVE_CHECK.eyebrow, title: LIVE_CHECK.title, lede: LIVE_CHECK.intro }}
    >
      <NoScriptAnswers />
      <LiveCheckClient
        recorded={recorded}
        scenarios={LIVE_CHECK.scenarios}
        mandates={LIVE_CHECK.mandates}
        copy={LIVE_CHECK.copy}
        codes={LIVE_CHECK.codes}
        explorer={
          <ExternalLink className={lc.explorer} href={explorerAccountUrl("testnet", LIVE_VAULT)}>
            {LIVE_CHECK.copy.explorer}
            <span className={lc.ext} aria-hidden="true">
              ↗
            </span>
          </ExternalLink>
        }
      />
    </LandingSection>
  );
}
