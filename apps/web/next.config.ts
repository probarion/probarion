import type { NextConfig } from "next";
import { publicRoutingVars } from "./src/lib/site/network";

// Which network an address is, as the browser needs it: the default network (NEAR_NETWORK) and each network's origin
// (APP_ORIGIN_MAINNET and APP_ORIGIN_TESTNET, else the default's production address), from the same settings the
// server reads and with the same rule (lib/site/network.ts). The static pages learn their network from this map and the
// browser's address bar. A change to any of those settings needs a redeploy.
const routing = publicRoutingVars(process.env);

const nextConfig: NextConfig = {
  // Native/wasm packages stay outside the server bundle (Verify on first use #4, #5).
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas", "libsodium-wrappers", "libsodium"],
  transpilePackages: ["@probarion/core", "@probarion/sdk"],
  // `next build` typechecks with tsconfig.build.json, which leaves out tests; `pnpm typecheck`
  // uses tsconfig.json and still checks them. Tests never gate a deploy.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  poweredByHeader: false,
  env: {
    // The Sentry DSN is public by design; IF §14 has only SENTRY_DSN, so expose it at build time.
    // R12: an empty or whitespace-only value counts as unset, here as in loadEnv.
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN?.trim() || "",
    NEXT_PUBLIC_DEFAULT_NETWORK: routing.NEXT_PUBLIC_DEFAULT_NETWORK,
    NEXT_PUBLIC_ORIGIN_MAINNET: routing.NEXT_PUBLIC_ORIGIN_MAINNET,
    NEXT_PUBLIC_ORIGIN_TESTNET: routing.NEXT_PUBLIC_ORIGIN_TESTNET,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // near-connect's `near-wallet-injected` message listener does not check the sender's origin.
          // A page that opened the console in a window keeps no `window.opener` handle to it, while
          // the popups the console opens for a wallet still work (W-T6-R1).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
};

export default nextConfig;
