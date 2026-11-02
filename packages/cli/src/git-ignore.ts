import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// A best-effort answer to "would git ignore this file?", used only to warn before a secret key file
// lands in a repository. It reads the root .gitignore and nothing else (no git process): nested
// .gitignore files, .git/info/exclude and the global ignore file are not consulted, so a file that
// only those cover is reported as not ignored, which makes the caller warn. When in doubt, warn.

export interface GitIgnoreStatus {
  /** The work tree the file is in (the nearest ancestor holding `.git`), or null outside any. */
  root: string | null;
  /** True only when a pattern of the root .gitignore plainly covers the file. */
  ignored: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** One path segment of a pattern as a regular expression: `*` and `?` only; `[` classes are not supported. */
function segmentRegExp(segment: string): RegExp {
  const body = [...segment]
    .map((ch) => {
      if (ch === "*") return "[^/]*";
      if (ch === "?") return "[^/]";
      return ch.replace(/[.+^${}()|\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`);
}

/**
 * Whether the root .gitignore text plainly covers `relativePath` (slash-separated, relative to the
 * work tree root). Handles `name`, `name/`, `/name`, `dir/name` and `*` or `?` inside a segment.
 * Anything else (`!` negation, `**`, `[...]`, escapes) is not evaluated: a negation anywhere makes
 * the whole answer "not ignored", an unsupported pattern simply never matches.
 */
export function gitignoreCovers(gitignoreText: string, relativePath: string): boolean {
  const lines = gitignoreText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.some((line) => line.startsWith("!"))) return false;
  const parts = relativePath.split("/").filter((part) => part !== "");
  for (const line of lines) {
    if (/[[\]\\]|\*\*/.test(line)) continue;
    const dirOnly = line.endsWith("/");
    const pattern = line.replace(/\/+$/, "");
    if (pattern === "") continue;
    const anchored = pattern.includes("/");
    const segments = pattern.replace(/^\//, "").split("/");
    const regexps = segments.map(segmentRegExp);
    // Unanchored (a bare name): it may match any single path component. Anchored: it must match
    // the leading components, counted from the work tree root.
    const starts = anchored ? [0] : parts.map((_, index) => index);
    for (const start of starts) {
      const end = start + segments.length;
      if (end > parts.length) continue;
      if (!regexps.every((re, offset) => re.test(parts[start + offset] ?? ""))) continue;
      // The match ends at parts[end - 1]. Anything but the last part is a directory, so it covers
      // the file; the last part is the file itself, which a `name/` pattern does not cover.
      if (end < parts.length || !dirOnly) return true;
    }
  }
  return false;
}

export async function gitIgnoreStatus(file: string): Promise<GitIgnoreStatus> {
  const absolute = path.resolve(file);
  let dir = path.dirname(absolute);
  for (;;) {
    if (await exists(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) return { root: null, ignored: false };
    dir = parent;
  }
  let text: string;
  try {
    text = await readFile(path.join(dir, ".gitignore"), "utf8");
  } catch {
    return { root: dir, ignored: false };
  }
  const relative = path.relative(dir, absolute).split(path.sep).join("/");
  return { root: dir, ignored: gitignoreCovers(text, relative) };
}
