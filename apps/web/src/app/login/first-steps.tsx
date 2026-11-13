import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import type { Network } from "@/lib/config";

// What /login offers someone who cannot sign in yet: on testnet, where to get an account and the test NEAR a vault
// takes, and on either network, a way to see Probarion work with no wallet at all.

/** Meteor Wallet's web app, as the testnet wallet list names it (components/wallet/manifest.ts). */
export const METEOR_WEB = "https://wallet.meteorwallet.app";

/**
 * NEAR's testnet faucet page. It funds the account through NEAR's faucet service (helper.testnet.near.org, read
 * 2026-11-14), the one the owner quickstart names for new testnet accounts.
 */
export const NEAR_FAUCET = "https://docs.near.org/getting-started/faucet";

/** The demo video: the post the README links as "Demo video". */
export const DEMO_VIDEO = "https://x.com/probarionhq/status/2120882499689836651";

const link = "text-ink underline decoration-ink/60 hover:decoration-ink";

/** On testnet, under what signing in takes: where to create an account, and where to get test NEAR for it. */
export function NoAccountYet({ network }: { network: Network }) {
  if (network !== "testnet") return null;
  return (
    <p className="mt-4 text-mute">
      No testnet account?{" "}
      <ExternalLink className={link} href={METEOR_WEB}>
        Create one in Meteor Wallet
      </ExternalLink>{" "}
      <span aria-hidden="true">·</span>{" "}
      <ExternalLink className={link} href={NEAR_FAUCET}>
        get test NEAR
      </ExternalLink>
    </p>
  );
}

/** Under the wallet list: the proof page and the demo video, neither of which needs a wallet. */
export function WithoutWallet() {
  return (
    <p className="mt-6 text-mute">
      <RouteLink route="/proof" className={link}>
        See it without a wallet <span aria-hidden="true">→</span>
      </RouteLink>{" "}
      or{" "}
      <ExternalLink className={link} href={DEMO_VIDEO}>
        watch the demo video
      </ExternalLink>
    </p>
  );
}
