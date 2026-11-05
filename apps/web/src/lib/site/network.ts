import type { Network } from "@/lib/config";

/** The network this build runs on. next.config.ts maps NEAR_NETWORK (default testnet) onto this public variable. */
export const BUILD_NETWORK: Network =
  process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
