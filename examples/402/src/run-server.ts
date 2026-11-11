// pnpm --filter @probarion/example-402 run paywall
// Serves GET /forecast for PAYWALL_PRICE_USDC (default 0.01) per call, paid to PAYWALL_PAYEE. Testnet only.
// PAYWALL_FLOOR_USDC (default: the price) is the least it takes for a counter on POST /counter.
import { NETWORKS } from "@probarion/core";
import { formatUsdc, parseUsdc } from "@probarion/mcp";
import { envValue, RpcClient, resolveRpcUrls } from "@probarion/sdk";
import { forecastData } from "./forecast.js";
import { chainReader, startPaywall } from "./paywall.js";

const env = process.env;
if ((envValue(env, "NEAR_NETWORK") ?? "testnet") !== "testnet") {
  console.error("This example runs on testnet only, with test USDC.");
  process.exit(2);
}
const payee = envValue(env, "PAYWALL_PAYEE") ?? "probarion-payee.testnet";
const price = parseUsdc(envValue(env, "PAYWALL_PRICE_USDC") ?? "0.01");
const floor = parseUsdc(envValue(env, "PAYWALL_FLOOR_USDC") ?? formatUsdc(price));
const port = Number(envValue(env, "PORT") ?? "4020");
const rpc = new RpcClient({ urls: resolveRpcUrls("testnet", undefined, env) });

const paywall = await startPaywall(
  {
    network: "testnet",
    payee,
    priceUnits: price,
    floorUnits: floor,
    path: "/forecast",
    reader: chainReader(rpc, "testnet"),
    data: forecastData,
  },
  port,
);
console.log(`402 paywall at ${paywall.url}`);
console.log(`price ${formatUsdc(price)} USDC per call, paid to ${payee} on testnet`);
console.log(
  floor === price
    ? "counters are refused (no floor below the price)"
    : `counters at or above the floor are taken (the floor is not sent to buyers)`,
);
console.log(`payments are read from vaults of ${NETWORKS.testnet.factory}. Ctrl+C stops it.`);
