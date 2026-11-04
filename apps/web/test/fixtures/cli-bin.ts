// The built CLI, as the site's commands run it. The tests that use it start `packages/cli/dist/bin.js` as a child
// process, so they need the three packages built: `pnpm build` does it before the tests in `verify:ts`. A dist older
// than its sources would test old code, so that is refused with a clear message instead.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository folder the displayed commands run from: this checkout. */
export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

const BIN = "packages/cli/dist/bin.js";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
  );
}

/**
 * The bin's absolute path, after checking that `packages/{core,sdk,cli}/dist` exist and that no file under a `src` is
 * newer than the oldest file of its `dist`.
 */
export function builtCliBin(): string {
  for (const pkg of ["core", "sdk", "cli"]) {
    const src = join(REPO, "packages", pkg, "src");
    const dist = join(REPO, "packages", pkg, "dist");
    if (!existsSync(dist)) {
      throw new Error(`packages/${pkg}/dist is missing: run pnpm build before these tests`);
    }
    const built = Math.min(...files(dist).map((f) => statSync(f).mtimeMs));
    const stale = files(src).filter((f) => statSync(f).mtimeMs > built);
    if (stale.length > 0) {
      throw new Error(
        `packages/${pkg}/dist is older than ${stale.length} source file(s), e.g. ${stale[0]}: run pnpm build before these tests`,
      );
    }
  }
  return join(REPO, BIN);
}

/**
 * The arguments of a command as the site shows it, after the program: `npx probarion <args>` (the package on npm) or
 * `node packages/cli/dist/bin.js <args>` (from the repository). The published package's bin is this same file.
 */
export function shownArgs(command: string): string[] {
  for (const program of ["npx probarion ", `node ${BIN} `]) {
    if (command.startsWith(program)) return command.slice(program.length).split(" ");
  }
  throw new Error(`not a probarion command: ${command}`);
}

/** Runs the built bin with `args` in `cwd`, as a child process. */
export function runBuiltCli(
  args: readonly string[],
  opts: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = builtCliBin();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd: opts.cwd, env: (opts.env ?? process.env) as NodeJS.ProcessEnv },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
