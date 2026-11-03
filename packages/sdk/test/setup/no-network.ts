// R20: unit tests never touch the network. Any fetch to a non-loopback host throws before a socket
// is opened; loopback (localhost, 127.0.0.1, [::1], *.localhost) still goes through for local fakes.
const realFetch = globalThis.fetch;

function requestUrl(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}

globalThis.fetch = (async (input, init) => {
  const url = requestUrl(input);
  if (url === null || !isLoopback(url)) {
    throw new Error(
      `network access is disabled in unit tests (fetch ${url?.origin ?? "<unparseable url>"})`,
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
