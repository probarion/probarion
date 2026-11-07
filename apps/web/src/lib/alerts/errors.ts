const EMAIL_ADDRESS = /[^\s@<>,;"']+@[^\s@<>,;"']+/g;
const ERROR_MAX = 200;

/**
 * A provider's words about a failure, made fit for a log line and for the `alerts_sent` row: every email address is taken
 * out, so is the target of the send when it is long enough to be an address or a chat id and not a short number, and the
 * result is cut to 200 characters (after the removals, so no half of an address is left at the edge).
 */
export function providerError(error: string, target: string): string {
  let out = error.replace(EMAIL_ADDRESS, "[address]");
  if (target.length >= 5) out = out.split(target).join("[target]");
  return out.slice(0, ERROR_MAX);
}
