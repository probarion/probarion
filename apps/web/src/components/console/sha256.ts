/**
 * Browser-side sha256 for the purpose document (R15). The file never leaves the device: only the 64
 * lowercase hex characters go on-chain as the mandate's `purpose_hash`, and the owner attaches the same
 * document to invoices later. Text is hashed as UTF-8.
 */
export async function sha256HexOf(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
