import { CopyButton } from "@/components/docs/CopyButton";
import { explorerAccountUrl } from "@/lib/config";
import { LIVE_CHECK, MAINNET_ASK, MAINNET_VERIFY } from "@/lib/site/facts";
import { fill } from "@/lib/site/live-check";
import { ASK_RPC, ASK_VAULT } from "@/lib/site/mainnet-ask";
import { MainnetAskClient } from "./MainnetAskClient";
import m from "./mainnet.module.css";
import { Away } from "./parts";
import { Rich } from "./Rich";

/** The lists say their role out loud (as in BuiltOn.tsx): Tailwind's preflight sets list-style: none. */
const LIST = { role: "list" } as const;

/**
 * The no-clone verify of the vault: one command per line, each with its copy button (hidden until the script runs).
 * Nothing renders while `lines` is empty.
 */
export function MainnetVerifyBlock({
  lines = MAINNET_VERIFY.lines,
}: {
  lines?: readonly string[];
}) {
  if (lines.length === 0) return null;
  return (
    <div className={m.askVerify}>
      <h4 className={m.askVerifyTitle}>{MAINNET_VERIFY.title}</h4>
      <p className={m.askNote}>{MAINNET_VERIFY.note}</p>
      <ol className={m.askLines} {...LIST}>
        {lines.map((line, i) => (
          <li key={line} className={m.askLine}>
            <code>{line}</code>
            <CopyButton
              text={line}
              label={MAINNET_VERIFY.copy}
              ariaLabel={fill(MAINNET_VERIFY.copyLabel, { n: i + 1 })}
              className={m.askCopy}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The visitor's own question to the mainnet vault: two amounts, one `check_spend` view a click, the contract's answer.
 * With no JavaScript a line says why there is no answer, and the vault's explorer page stays one link away.
 */
export function MainnetAsk() {
  return (
    <section className={m.ask} aria-labelledby="mainnet-ask-title">
      <div className={m.askHead}>
        <h3 className={m.sideTitle} id="mainnet-ask-title">
          {MAINNET_ASK.title}
        </h3>
        <p className={m.askLede}>
          <Rich text={MAINNET_ASK.lede} />
        </p>
        <noscript>
          <p className={m.askNote}>{MAINNET_ASK.noScript}</p>
        </noscript>
        <p className={m.askNote}>
          <Away href={explorerAccountUrl("mainnet", ASK_VAULT)} label={MAINNET_ASK.explorer} />
        </p>
      </div>
      <MainnetAskClient copy={MAINNET_ASK} codes={LIVE_CHECK.codes} host={new URL(ASK_RPC).host} />
      <MainnetVerifyBlock />
    </section>
  );
}
