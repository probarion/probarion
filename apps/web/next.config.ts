import type { NextConfig } from "next";

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
    NEXT_PUBLIC_NEAR_NETWORK: process.env.NEAR_NETWORK?.trim() || "testnet",
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
