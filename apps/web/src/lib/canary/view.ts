import type { Network } from "@/lib/config";
import type { Env } from "@/lib/env";
import { log } from "@/lib/log";

/** The part of the environment that decides which Canary page a visitor gets. */
export type CanaryEnv = Pick<Env, "NEAR_NETWORK" | "CANARY_MODE" | "CANARY_VAULT_ID">;

/** Why the replay shows instead of the live page: paused by the owner, a chosen replay, or not open yet. */
export type Banner = "off" | "replay" | "closed";

export type CanaryView =
  | { kind: "live"; mode: "live" | "code-only"; vault: string; network: Network }
  | { kind: "replay"; banner: Banner; network: Network };

/**
 * Which Canary page to show. The form and the scoreboard need a live mode and a vault. Without them the page is the
 * replay, with the banner that says why. An environment that cannot be read (a preview or a build that lacks the
 * settings, or a setting that is invalid) is "not open yet" on the network the build was made for, never a 500.
 */
export function canaryView(read: () => CanaryEnv, buildNetwork: Network): CanaryView {
  let env: CanaryEnv;
  try {
    env = read();
  } catch (error) {
    log.warn("canary.page_env_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "replay", banner: "closed", network: buildNetwork };
  }
  const network = env.NEAR_NETWORK;
  if (env.CANARY_MODE === "off") return { kind: "replay", banner: "off", network };
  if (env.CANARY_MODE === "replay") return { kind: "replay", banner: "replay", network };
  if (!env.CANARY_VAULT_ID) return { kind: "replay", banner: "closed", network };
  return { kind: "live", mode: env.CANARY_MODE, vault: env.CANARY_VAULT_ID, network };
}
