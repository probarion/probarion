import { problem } from "@/lib/http";
import { type InvoiceMediaType, MAX_INVOICE_BYTES } from "./extract";

// An invoice as a route receives it (the console upload and the browser extension), and the checks both make on it.

export interface InvoiceUpload {
  bytes: Uint8Array;
  mediaType: InvoiceMediaType;
  filename: string | null;
}

/**
 * The whole multipart body (the invoice, the optional purpose document and the framing) is at most the invoice cap
 * plus 64 KiB, 4,259,840 bytes: a maximum-size invoice fits with its form, and the limit stays under
 * Vercel's 4.5 MB body cap, which refuses a larger body before this code runs. A request must state its length
 * (Content-Length), so the limit is checked before any of the body is read.
 */
export const MAX_REQUEST_BYTES = MAX_INVOICE_BYTES + 64 * 1024;

/** 4259840 -> "4,259,840". */
export const byteCount = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const fileTooLarge = (what: string) =>
  problem(
    413,
    "too_large",
    `The ${what} is larger than 4 MiB (${byteCount(MAX_INVOICE_BYTES)} bytes).`,
  );

/**
 * What a stored file name must not keep: C0 and C1 controls, format characters (U+202E reverses how the rest of
 * a name is shown), and the line and paragraph separators.
 */
const UNSAFE_NAME_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Only the base name, without unsafe characters, at most 200 characters (the column's limit). */
export function cleanName(name: string): string | null {
  const last = name.split(/[\\/]/).pop() ?? "";
  const base = [...last]
    .filter((c) => !UNSAFE_NAME_CHAR.test(c))
    .join("")
    .trim();
  return base === "" ? null : [...base].slice(0, 200).join("");
}

export function mediaTypeOf(file: File): InvoiceMediaType | null {
  const type = (file.type.split(";")[0] ?? "").trim().toLowerCase();
  const name = file.name.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "application/pdf";
  if (type === "text/plain" || name.endsWith(".txt")) return "text/plain";
  return null;
}
