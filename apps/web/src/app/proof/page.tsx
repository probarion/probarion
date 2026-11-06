import { isNearAccountId } from "@probarion/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Rich } from "@/components/site/Rich";
import s from "@/components/site/site.module.css";
import { TamperPanel } from "@/components/site/TamperPanel";
import { inkPillClass } from "@/components/ui";
import { publicDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { requestNetwork } from "@/lib/network";
import { publicDemoTarget } from "@/lib/proof/service";
import { PROOF_INDEX, TAMPER_COPY } from "@/lib/site/facts";

export const metadata: Metadata = { title: "Proof" };
export const dynamic = "force-dynamic";

type Props = { searchParams?: Promise<{ vault?: string | string[] }> };

/** A plain boolean: the core guard's type would narrow a rejected string to `never`. */
const isAccount = (value: string): boolean => isNearAccountId(value);

/** Where the demo vault's page is, if it is public. Without a demo vault this page needs no secret, so a bad env is no 500. */
async function demoTarget(): Promise<string | null> {
  try {
    // The demo vault of the network of this address (PROBARION_VAULT_ID[_<NET>]).
    const network = await requestNetwork();
    return await publicDemoTarget(
      { publicDb: publicDb(), network },
      getEnv().networks[network].demoVaultId,
    );
  } catch (error) {
    log.warn("proof.demo_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * `/proof` with no vault: the demo vault (PROBARION_VAULT_ID), when its proof page is public on this address's network.
 * Otherwise, and when the database cannot say (`publicDemoTarget` catches the error), rather than a redirect to a 404
 * or an error page, it says what a proof page shows, with a form that opens one and the ledger test.
 *
 * The form is a plain GET back to this page, so it works with no JavaScript: a NEAR account goes on to
 * `/proof/<account>`, and anything else gets an inline error here rather than a 404 there.
 */
export default async function ProofIndex({ searchParams }: Props = {}) {
  const target = await demoTarget();
  if (target) redirect(target);

  const asked = (await searchParams)?.vault;
  const typed = Array.isArray(asked) ? asked[0] : asked;
  const account = typed?.trim() ?? "";
  if (isAccount(account)) redirect(`/proof/${account}`);
  // Blank spaces are something typed too. Only an empty value stays quiet.
  const invalid = typed !== undefined && typed !== "";

  return (
    <div className={`${s.site} ${s.wrap} ${s.proofIndex}`}>
      <p className={s.eyebrow}>{PROOF_INDEX.eyebrow}</p>
      <h1 className={s.proofTitle}>{PROOF_INDEX.title}</h1>
      <p className={s.proofIntro}>{PROOF_INDEX.intro}</p>
      <p className={s.proofMuted}>{PROOF_INDEX.noneListed}</p>

      <form className={s.accountForm} method="get" action="/proof">
        <label htmlFor="proof-vault">{PROOF_INDEX.label}</label>
        <div className={s.accountRow}>
          <input
            // biome-ignore lint/a11y/noAutofocus: only after a failed submit, so that the label and the error are read.
            autoFocus={invalid}
            id="proof-vault"
            className={s.accountInput}
            name="vault"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            placeholder={PROOF_INDEX.placeholder}
            defaultValue={account.slice(0, 64)}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? "proof-vault-error" : undefined}
          />
          <button type="submit" className={inkPillClass}>
            {PROOF_INDEX.submit}
          </button>
        </div>
        {invalid ? (
          <p id="proof-vault-error" className={s.accountError}>
            {PROOF_INDEX.invalid}
          </p>
        ) : null}
      </form>
      <p className={s.proofMuted}>{PROOF_INDEX.publicOnly}</p>

      <section className={s.proofTamper}>
        <h2 className={s.proofTamperTitle}>{PROOF_INDEX.tamperTitle}</h2>
        <p className={s.proofTamperIntro}>
          <Rich text={TAMPER_COPY.intro} />
        </p>
        <TamperPanel />
      </section>
    </div>
  );
}
