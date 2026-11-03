import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@probarion/core";
import type { CliIo } from "../src/io.js";

export const NOW = new Date("2026-11-05T12:00:00.000Z");

export function testIo(
  cwd: string,
  env: Record<string, string | undefined> = {},
  platform?: NodeJS.Platform,
) {
  const state = { out: "", err: "" };
  const io: CliIo = {
    out: (text) => {
      state.out += text;
    },
    err: (text) => {
      state.err += text;
    },
    env,
    cwd,
    now: () => NOW,
    setExitCode: () => {},
    ...(platform === undefined ? {} : { platform }),
  };
  return { io, state };
}

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "probarion-cli-"));
}

/** The text a printer writes to the args file: 2-space JSON and a final newline. */
export function argsJsonText(args: unknown): string {
  return `${JSON.stringify(args, null, 2)}\n`;
}

/**
 * The name T15-R1 gives the args file: `<method>.<first 12 hex of sha256(args JSON)>.args.json`.
 * Written out here from the rule, not imported from the source, so a change to the rule fails.
 */
export function argsFileFor(method: string, args: unknown): string {
  return `${method}.${sha256Hex(argsJsonText(args)).slice(0, 12)}.args.json`;
}

/** The path after `file-args` in the first printed `near contract call-function` line. */
export function printedArgsPath(out: string): string {
  const line = out.split("\n").find((l) => l.startsWith("near contract call-function")) ?? "";
  const match = /file-args (?:'([^']+)'|(\S+)) prepaid-gas/.exec(line);
  const path = match?.[1] ?? match?.[2];
  if (path === undefined) throw new Error(`no file-args in: ${line}`);
  return path;
}

/** Splits a printed command the way bash would (single quotes only, with `'\''` for a quote). */
export function shellSplit(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === "'") quoted = false;
      else current += ch;
    } else if (ch === "'") {
      quoted = true;
      inWord = true;
    } else if (ch === "\\" && line[i + 1] === "'") {
      current += "'";
      i++;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quoted) throw new Error(`unterminated quote in: ${line}`);
  if (inWord) words.push(current);
  return words;
}
