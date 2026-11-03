import "server-only";
import { headers } from "next/headers";
import { newRequestId, REQUEST_ID_HEADER } from "./log";

/** The id set by src/proxy.ts (Task 5); it is also written into every ledger entry (SDK v2 `requestId`). */
export async function currentRequestId(): Promise<string> {
  const h = await headers();
  return h.get(REQUEST_ID_HEADER) ?? newRequestId();
}
