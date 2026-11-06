import { NETWORKS } from "@probarion/core";
import { isAttestedStructuredModel, parseModelCatalogPage } from "@probarion/sdk";
import type { Network } from "@/lib/config";

// The probes behind /api/health/rpc, /api/health/nearai and the /status page. Pure: no settings and no server-only
// import, so the tests inject `fetch` and the clock. One attempt per probe, 5 s at most. A detail is one of a fixed set
// of strings, so nothing a third party answered (an error text, a chain id, a URL) reaches a public page or a monitor.

export interface Probe {
  name: string;
  ok: boolean;
  latency_ms: number;
  detail: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export const SERVICE = "probarion-web";
export const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_CACHE_MS = 30_000;
/** A node whose last block is older than this is stale. */
export const MAX_BLOCK_LAG_S = 120;
/** `?provider=` takes one or two digits, so a list has at most this many probes. */
export const MAX_PROVIDERS = 100;
export const NEARAI_PROBE_NAME = "NEAR AI Cloud";

type Fetched =
  | { ok: true; json: unknown; latencyMs: number }
  | { ok: false; detail: string; latencyMs: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function fetchJson(
  url: string,
  init: RequestInit,
  opts: ProbeOptions,
  malformed: string,
): Promise<Fetched> {
  const call = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const failed = (detail: string): Fetched => ({
    ok: false,
    detail: timedOut ? `timeout after ${timeoutMs} ms` : detail,
    latencyMs: elapsed(),
  });
  try {
    const res = await call(url, { ...init, cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return failed(`HTTP ${res.status}`);
    }
    try {
      const json: unknown = await res.json();
      return { ok: true, json, latencyMs: elapsed() };
    } catch {
      return failed(malformed);
    }
  } catch {
    return failed("network error");
  } finally {
    clearTimeout(timer);
  }
}

/** The verdict on a JSON-RPC `status` answer: the right chain, not syncing, and a last block at most 120 s old. */
export function judgeStatus(
  network: Network,
  body: unknown,
  nowMs: number,
): { ok: boolean; detail: string } {
  if (!isRecord(body)) return { ok: false, detail: "malformed status answer" };
  if (body.error !== undefined && body.error !== null) return { ok: false, detail: "rpc error" };
  const result = body.result;
  if (!isRecord(result) || typeof result.chain_id !== "string") {
    return { ok: false, detail: "malformed status answer" };
  }
  // Never echo the chain id an RPC returned: it is text from a third party.
  if (result.chain_id !== network) return { ok: false, detail: "wrong chain" };
  const sync = result.sync_info;
  if (!isRecord(sync)) return { ok: false, detail: "no sync_info in the status response" };
  const height = sync.latest_block_height;
  const time = sync.latest_block_time;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || typeof time !== "string") {
    return { ok: false, detail: "no sync_info in the status response" };
  }
  if (sync.syncing === true) return { ok: false, detail: `syncing: block ${height}` };
  // NEAR gives nanoseconds; Date.parse is only sure of milliseconds.
  const at = Date.parse(time.replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isNaN(at)) return { ok: false, detail: "no sync_info in the status response" };
  const behind = Math.max(0, Math.round((nowMs - at) / 1000));
  if (behind > MAX_BLOCK_LAG_S)
    return { ok: false, detail: `stale: block ${height}, ${behind} s behind` };
  return { ok: true, detail: `block ${height}, ${behind} s behind` };
}

/** One JSON-RPC `status` call to one URL of `network`'s list. */
export async function probeNearRpc(
  network: Network,
  url: string,
  name: string,
  opts: ProbeOptions = {},
): Promise<Probe> {
  const got = await fetchJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "health", method: "status", params: [] }),
    },
    opts,
    "malformed status answer",
  );
  if (!got.ok) return { name, ok: false, latency_ms: got.latencyMs, detail: got.detail };
  const verdict = judgeStatus(network, got.json, (opts.now ?? Date.now)());
  return { name, ok: verdict.ok, latency_ms: got.latencyMs, detail: verdict.detail };
}

/** One page of NEAR AI Cloud's public model list. No key is sent: the list is public (packages/sdk/src/nearai.ts). */
export async function probeNearAi(baseUrl: string, opts: ProbeOptions = {}): Promise<Probe> {
  const base = baseUrl.replace(/\/+$/, "");
  const name = NEARAI_PROBE_NAME;
  const got = await fetchJson(
    `${base}/model/list?limit=100&offset=0`,
    { method: "GET", headers: { accept: "application/json" } },
    opts,
    "malformed catalog answer",
  );
  if (!got.ok) return { name, ok: false, latency_ms: got.latencyMs, detail: got.detail };
  if (!isRecord(got.json) || !Array.isArray(got.json.models)) {
    return { name, ok: false, latency_ms: got.latencyMs, detail: "malformed catalog answer" };
  }
  const { models } = parseModelCatalogPage(got.json);
  if (models.length === 0) {
    return { name, ok: false, latency_ms: got.latencyMs, detail: "no models listed" };
  }
  const attested = models.filter(isAttestedStructuredModel).length;
  return {
    name,
    ok: true,
    latency_ms: got.latencyMs,
    detail: `${models.length} model(s) listed, ${attested} with attestation and structured output`,
  };
}

/**
 * How a probe names an RPC URL. A URL of the built-in list for that network (packages/core NETWORKS) is public, so its
 * host is shown. Any other URL came from a setting and may carry a key, so only the variable and its place (counting
 * from 1, as `chain.wrong` logs it) are shown.
 */
export function providerName(
  network: Network,
  url: string,
  index: number,
  variable: string,
): string {
  const builtIn: readonly string[] = NETWORKS[network].rpcUrls;
  if (builtIn.includes(url)) {
    try {
      return new URL(url).host;
    } catch {
      // Not reachable for a built-in URL; fall through to the variable's name.
    }
  }
  return `${variable} entry ${index + 1}`;
}

/** `?provider=` of /api/health/rpc: missing is 0, one or two digits is that index, anything else is -1 (a 404). */
export function parseProvider(raw: string | null): number {
  const value = raw ?? "0";
  return /^\d{1,2}$/.test(value) ? Number(value) : -1;
}

interface Cached {
  at: number;
  probe: Promise<Probe>;
}

const cache = new Map<string, Cached>();

/**
 * One probe per key per 30 s on this server instance, failures included, so a monitor or a busy /status page cannot
 * turn into a stream of calls to an RPC or to NEAR AI Cloud. Callers in the same window share one call.
 */
export function cachedProbe(
  key: string,
  name: string,
  run: () => Promise<Probe>,
  opts: { ttlMs?: number; now?: () => number } = {},
): Promise<Probe> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? HEALTH_CACHE_MS;
  const hit = cache.get(key);
  if (hit !== undefined && now() - hit.at < ttlMs) return hit.probe;
  const probe = run().catch(
    (): Probe => ({ name, ok: false, latency_ms: 0, detail: "probe failed" }),
  );
  cache.set(key, { at: now(), probe });
  return probe;
}

/** For tests. */
export function clearHealthCache(): void {
  cache.clear();
}
