import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../src/io.js";

export const NOW = new Date("2026-11-05T12:00:00.000Z");

export function testIo(cwd: string, env: Record<string, string | undefined> = {}) {
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
  };
  return { io, state };
}

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "probarion-cli-"));
}
