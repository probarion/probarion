import type { Fetch } from "./chrome";

// What the extension sends (spec §5.5): the PDF in the tab, a linked file, selected text, or a file the person
// chooses or drops. Each becomes a Captured: a name, a type, the bytes in base64 (chrome.storage.session holds JSON
// only), and for a selection the text's start, which the popup shows.

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SELECTION_BYTES = 64 * 1024;

/** The server reads at most this many UTF-16 units of a text, and refuses the amount of a longer one (extract.ts). */
export const MAX_TEXT_CHARS = 50_000;

export type InvoiceType = "application/pdf" | "text/plain";

export interface Captured {
  name: string;
  type: InvoiceType;
  size: number;
  base64: string;
  /** A selection's first 80 characters; null for a file, which the popup shows by name and size. */
  preview: string | null;
}

export type CaptureResult = { ok: true; item: Captured } | { ok: false; text: string };

export const TOO_LARGE = "The invoice must be 4 MiB at most.";
export const NOT_INVOICE = "Send a PDF or a plain text (.txt) file.";
export const LINK_ELSEWHERE = "Couldn't read this link. Download it and drag the file here.";
export const TOO_LONG =
  "This text is over 50,000 characters, more than Probarion reads. Send only the invoice part.";
export const NOT_UTF8 =
  "This text file isn't UTF-8. Save it as UTF-8 text, then choose or drop it here.";

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const s = atob(base64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export const isPdfBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);

/** Whether a tab's address is a PDF by its path: all the popup can tell without reading the page. */
export function isPdfUrl(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    const u = new URL(url);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.pathname.toLowerCase().endsWith(".pdf")
    );
  } catch {
    return false;
  }
}

export function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  try {
    const origin = new URL(a).origin;
    return origin !== "null" && origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** What a name must not keep, the server's rule (apps/web/src/lib/payables/upload.ts). */
const NOT_SHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A file name safe to show and to send: the last part of a path, printable, 100 characters at most. */
export function cleanName(raw: string, fallback: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let kept = [...base]
    .filter((ch) => !NOT_SHOWN.test(ch))
    .join("")
    .trim()
    .slice(0, 100);
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  kept = kept.trim();
  return kept === "" ? fallback : kept;
}

/** Bytes as an invoice of `type`, or why not. */
export function fromBytes(
  bytes: Uint8Array,
  name: string,
  type: InvoiceType,
  preview: string | null = null,
): CaptureResult {
  if (bytes.length === 0) return { ok: false, text: "This file is empty." };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, text: TOO_LARGE };
  if (type === "application/pdf" && !isPdfBytes(bytes)) {
    return { ok: false, text: "This file isn't a PDF." };
  }
  if (type === "text/plain") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, text: NOT_UTF8 };
    }
    // CRLF counts once: the server makes it one LF before it counts.
    if (text.replace(/\r\n/g, "\n").length > MAX_TEXT_CHARS) return { ok: false, text: TOO_LONG };
  }
  return { ok: true, item: { name, type, size: bytes.length, base64: toBase64(bytes), preview } };
}

export function captureSelection(text: string): CaptureResult {
  const trimmed = text.trim();
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.length === 0) return { ok: false, text: "Select the invoice text first." };
  if (bytes.length > MAX_SELECTION_BYTES) {
    return {
      ok: false,
      text: "The selection is over 64 KiB. Save it as a .txt file and choose it here.",
    };
  }
  const preview = [...trimmed.replace(/\s+/g, " ")].slice(0, 80).join("");
  return fromBytes(bytes, "selection.txt", "text/plain", preview);
}

/** How a file is sent, from its declared type or its name: the rule of the console's own upload. */
export function typeOf(declared: string, name: string): InvoiceType | null {
  const type = (declared.split(";")[0] ?? "").trim().toLowerCase();
  const lower = name.toLowerCase();
  if (type === "application/pdf" || lower.endsWith(".pdf")) return "application/pdf";
  if (type === "text/plain" || lower.endsWith(".txt")) return "text/plain";
  return null;
}

export async function captureFile(file: {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<CaptureResult> {
  const type = typeOf(file.type, file.name);
  if (type === null) return { ok: false, text: NOT_INVOICE };
  if (file.size > MAX_FILE_BYTES) return { ok: false, text: TOO_LARGE };
  const fallback = type === "application/pdf" ? "invoice.pdf" : "invoice.txt";
  return fromBytes(new Uint8Array(await file.arrayBuffer()), cleanName(file.name, fallback), type);
}

/** A body's bytes, or null past `max`: reading stops there, so a huge file is never held whole. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function lastPart(u: URL): string {
  const last = u.pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The file at a web address: the PDF in the tab, or the target of a right-clicked link. It is fetched with the
 * person's own cookies for that site, as their tab loaded it, and only a file that came from that same origin is kept
 * (a redirect to another address is refused). A PDF is known by its first bytes, whatever the server calls it; a text
 * file by its text/plain type.
 */
export async function captureUrl(url: string, fetchFn: Fetch): Promise<CaptureResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, text: LINK_ELSEWHERE };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, text: LINK_ELSEWHERE };
  let res: Response;
  try {
    // 25 s, not 30: an idle service worker can be stopped at 30 s.
    res = await fetchFn(u.href, { credentials: "include", signal: AbortSignal.timeout(25_000) });
  } catch {
    return { ok: false, text: LINK_ELSEWHERE };
  }
  // The request carries the person's cookies for this site, and a redirect can send it elsewhere (to another Probarion
  // address, say). The file counts only if it came from the address that was asked for: its origin is the page's.
  if (res.redirected || res.url !== "") {
    let landed = "";
    try {
      landed = new URL(res.url).origin;
    } catch {
      // no final address to trust
    }
    if (landed !== u.origin) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, text: LINK_ELSEWHERE };
    }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      text: `Couldn't read this file (HTTP ${res.status}). Download it and drag it here.`,
    };
  }
  const length = res.headers.get("content-length");
  if (length !== null && /^[0-9]{1,15}$/.test(length) && Number(length) > MAX_FILE_BYTES) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, text: TOO_LARGE };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, MAX_FILE_BYTES);
  } catch {
    return { ok: false, text: LINK_ELSEWHERE }; // the download broke off, or took too long
  }
  if (bytes === null) return { ok: false, text: TOO_LARGE };
  const name = cleanName(lastPart(u), "");
  if (isPdfBytes(bytes)) {
    return fromBytes(
      bytes,
      name.toLowerCase().endsWith(".pdf") ? name : "invoice.pdf",
      "application/pdf",
    );
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "text/plain") {
    return fromBytes(
      bytes,
      name.toLowerCase().endsWith(".txt") ? name : "invoice.txt",
      "text/plain",
    );
  }
  return { ok: false, text: "This link isn't a PDF or a text file." };
}

export function toBlob(item: Captured): Blob {
  return new Blob([fromBase64(item.base64)], { type: item.type });
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_BASE64 = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/** A Captured read back from chrome.storage.session, or null when it is not one this version wrote. */
export function readCaptured(raw: unknown): Captured | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { name, type, size, base64, preview } = r;
  if (typeof name !== "string" || name === "" || name.length > 100) return null;
  if (type !== "application/pdf" && type !== "text/plain") return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES)
    return null;
  if (typeof base64 !== "string" || base64.length > MAX_BASE64 || !BASE64.test(base64)) return null;
  if (preview !== null && (typeof preview !== "string" || preview.length > 160)) return null;
  return { name, type, size, base64, preview };
}
