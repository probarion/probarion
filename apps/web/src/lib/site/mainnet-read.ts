// One page-wide signal: "read this payout's chain now". The hero's link sends it as it scrolls to #mainnet, and the
// stone of that payout (components/site/MainnetPayoutClient.tsx) runs its own check, the one its button runs. No import,
// so both client components load it for free.

const EVENT = "probarion:mainnet-read";

/** Asks the stone of payout `id` to read the chain. A stone that is reading already ignores it. */
export function requestMainnetRead(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: id }));
}

/** Calls `run` whenever payout `id` is asked to read the chain; returns the function that stops listening. */
export function onMainnetRead(id: string, run: () => void): () => void {
  const listener = (e: Event) => {
    if (e instanceof CustomEvent && e.detail === id) run();
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
