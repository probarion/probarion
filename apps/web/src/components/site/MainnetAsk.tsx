import { CopyButton } from "@/components/docs/CopyButton";
import { explorerAccountUrl } from "@/lib/config";
import { LIVE_CHECK, MAINNET_ASK, MAINNET_VERIFY } from "@/lib/site/facts";
import { fill } from "@/lib/site/live-check";
import { ASK_RPC, ASK_VAULT } from "@/lib/site/mainnet-ask";
import { MainnetAskClient } from "./MainnetAskClient";
import m from "./mainnet.module.css";
import { Away } from "./parts";
import { Rich } from "./Rich";

/**
 * The no-clone verify of the vault: the Bash block, then the PowerShell one, each with a copy button (hidden until the
 * script runs) that copies the whole block. The lines wrap, so no block scrolls sideways; the copy keeps them as they are.
 * Then, in one paragraph, what the run prints, what it does not check and where its recorded runs are.
 */
export function MainnetVerifyBlock() {
  const V = MAINNET_VERIFY;
  return (
    <div className={m.askVerify}>
      <h4 className={m.askVerifyTitle}>{V.title}</h4>
      <p className={m.askNote}>{V.intro}</p>
      {V.blocks.map((b) => {
        const code = b.lines.join("\n");
        return (
          <div key={b.shell} className={m.askBlock}>
            <div className={m.askBlockHead}>
              <span>{b.label}</span>
              <CopyButton
                text={code}
                label={V.copy}
                ariaLabel={fill(V.copyLabel, { shell: b.shell })}
                className={m.askCopy}
              />
            </div>
            <pre className={m.askCode}>
              <code>{code}</code>
            </pre>
          </div>
        );
      })}
      <p className={m.askNote}>
        <Rich text={V.expected} /> <Rich text={V.caveat} />{" "}
        <Away href={V.evidence.href} label={V.evidence.label} />
      </p>
    </div>
  );
}

/**
 * The visitor's own question to the mainnet vault: two amounts, one `check_spend` view a click, the contract's answer.
 * With no JavaScript a line says why there is no answer, and the vault's explorer page stays one link away. The no-clone
 * verify of the same vault follows.
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
