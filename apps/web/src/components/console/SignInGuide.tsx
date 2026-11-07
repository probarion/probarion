import { RouteLink } from "@/components/RouteLink";
import type { Network } from "@/lib/config";

// What /login says around the wallet list: what signing in is for and what it takes, before the list, and a way to look
// around with no wallet, after it. It names no wallet, as the list depends on the network.

/**
 * What the console asks for a new vault on testnet, rounded up to a tenth: the factory's 0.5 NEAR `min_deposit` plus
 * the console's estimate of the storage for the vault's own copy of the code (embedded). SignInGuide.test.ts checks it
 * against contracts/deployments/testnet.json.
 */
export const TESTNET_VAULT_DEPOSIT_NEAR = 3.3;

const link = "text-ink underline decoration-ink/30 hover:decoration-ink";

/** What signing in is for, and the account and deposit it takes on this network. */
export function SignInIntro({ network }: { network: Network }) {
  return (
    <>
      <p className="mt-3 text-mute">
        Sign in to set up your agent&apos;s guardrails: create a vault, sign a mandate, and give
        your agent a key that can only call <code>spend</code>. A vault&apos;s approvers sign in
        here too, to approve or reject a held payment.
      </p>
      <p className="mt-3 text-mute">
        {network === "testnet"
          ? `You need a NEAR testnet account, such as name.testnet. Creating a vault later takes about ${TESTNET_VAULT_DEPOSIT_NEAR} test NEAR, which stays in the vault for its storage and gas and cannot be withdrawn.`
          : "You need a NEAR mainnet account. Vaults cannot be created on mainnet yet: its factory is not deployed."}
      </p>
    </>
  );
}

/** Below the button: the ledger test, which needs no wallet, then the terms and the privacy notice. */
export function JustLooking() {
  return (
    <div className="mt-6 border-t border-line pt-4 text-sm text-mute">
      <p>
        Just looking?{" "}
        <RouteLink route="/" href="/#verify" className={link}>
          Break a signed record <span aria-hidden="true">→</span>
        </RouteLink>{" "}
        <span className="whitespace-nowrap">(no wallet needed)</span>
      </p>
      <p className="mt-3">
        <RouteLink route="/terms" className={link}>
          Terms
        </RouteLink>{" "}
        <span aria-hidden="true">·</span>{" "}
        <RouteLink route="/privacy" className={link}>
          Privacy
        </RouteLink>
      </p>
    </div>
  );
}
