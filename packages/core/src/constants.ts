// packages/core/src/constants.ts
export const NETWORKS = {
  mainnet: {
    rpcUrls: ["https://rpc.mainnet.fastnear.com", "https://rpc.intea.rs"], // intea answered on 2026-10-21 but ran nearcore 2.14.0-rc.2; S3 confirms. Configurable via NEAR_RPC_URLS
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // native USDC, 6 decimals
    intents: "intents.near",
    allowedAssets: {
      base: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", // POA USDC on Base, 6 decimals
      solana: "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", // POA USDC on Solana, 6 decimals (stretch)
    },
    factory: "vaults.probarion.near",
    explorerTx: "https://nearblocks.io/txns/",
  },
  testnet: {
    rpcUrls: ["https://rpc.testnet.fastnear.com"],
    usdc: "usdc.probarion.testnet", // test-ft deployment
    intents: "intents-stub.probarion.testnet", // intents-stub deployment (Intents has no testnet)
    allowedAssets: { base: "base-usdc.probarion.testnet", solana: "sol-usdc.probarion.testnet" }, // test-ft deployments acting as POA tokens
    factory: "vaults.probarion.testnet",
    explorerTx: "https://testnet.nearblocks.io/txns/",
  },
} as const;
export const USDC_DECIMALS = 6;
export const WITHDRAW_MEMO_PREFIX = "WITHDRAW_TO:";
export const EVENT_STANDARD = "probarion";
export const FACTORY_EVENT_STANDARD = "probarion_factory";
export const EVENT_VERSION = "1.0.0";
export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";

export type NetworkId = keyof typeof NETWORKS;
