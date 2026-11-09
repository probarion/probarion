import { ExternalLink } from "@/components/ui";
import { explorerAccountUrl } from "@/lib/config";
import { LIVE_CHECK } from "@/lib/site/facts";
import { fill, LIVE_VAULT, type RecordedFile } from "@/lib/site/live-check";
import recordedJson from "@/lib/site/live-check-recorded.json";
import { answerFromRecorded } from "@/lib/site/live-check-view";
import { LiveCheckClient } from "./LiveCheckClient";
import { Rich } from "./Rich";
import s from "./site.module.css";

const recorded = recordedJson as unknown as RecordedFile;

/** The recorded answers, for a visitor with no JavaScript: the controls do nothing without it. */
function NoScriptAnswers() {
  return (
    <noscript>
      <p className={s.liveHint}>
        {fill(LIVE_CHECK.copy.noScript, { date: recorded.recordedAt.slice(0, 10) })}
      </p>
      <table className={s.liveTable}>
        <tbody>
          {LIVE_CHECK.scenarios.map((x) => {
            const a = answerFromRecorded(recorded, x.id);
            return (
              <tr key={x.id}>
                <th scope="row">{x.title}</th>
                <td>{a.verdict.ok ? LIVE_CHECK.copy.verdictPay : a.verdict.code}</td>
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
    <section className={s.section} id="try">
      <div className={s.wrap}>
        <p className={s.eyebrow}>{LIVE_CHECK.eyebrow}</p>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{LIVE_CHECK.title}</h2>
          <p>
            <Rich text={LIVE_CHECK.intro} />
          </p>
        </div>
        <NoScriptAnswers />
        <LiveCheckClient
          recorded={recorded}
          scenarios={LIVE_CHECK.scenarios}
          mandates={LIVE_CHECK.mandates}
          copy={LIVE_CHECK.copy}
          codes={LIVE_CHECK.codes}
          explorer={
            <ExternalLink className={s.link} href={explorerAccountUrl("testnet", LIVE_VAULT)}>
              {LIVE_CHECK.copy.explorer}
            </ExternalLink>
          }
        />
      </div>
    </section>
  );
}
