import type { Network } from "@/lib/config";
import { connectorOptions, type DataStorage, hardenConnector } from "./manifest";

/**
 * Our own narrow view of near-connect 0.11.4, so its missing @near-js/* types cannot leak
 * (Verify on first use #1). Matches the installed build/types: `NearWalletBase` and `NearConnector`.
 */
export interface ConnectorLike {
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  getConnectedWallet(): Promise<{ wallet: unknown; accounts: { accountId: string }[] }>;
  on(event: "wallet:signIn" | "wallet:signOut", callback: (payload: unknown) => void): void;
  off(event: "wallet:signIn" | "wallet:signOut", callback: (payload: unknown) => void): void;
}

async function build(network: Network): Promise<ConnectorLike> {
  const { NearConnector, LocalStorage } = await import("@hot-labs/near-connect"); // client-only, never at SSR
  // Our pinned wallet list (manifest.ts), never the one the library would fetch from GitHub.
  const options = connectorOptions(network, new LocalStorage() as DataStorage);
  // (The library types `platform` as string[], but its own manifest, and ours, use an object.)
  const built = new NearConnector(
    options as unknown as ConstructorParameters<typeof NearConnector>[0],
  );
  return hardenConnector(built) as unknown as ConnectorLike;
}

const connectors = new Map<Network, Promise<ConnectorLike>>();

/**
 * The one connector for a network. The library has no dispose and its window listeners stay until a reload, so a new
 * one on each client-side visit to /login or /console would add listeners every time. A failed load is not kept, so a
 * later visit tries again.
 */
export function connectorFor(network: Network): Promise<ConnectorLike> {
  const known = connectors.get(network);
  if (known !== undefined) return known;
  const pending = build(network);
  connectors.set(network, pending);
  pending.catch(() => connectors.delete(network));
  return pending;
}
