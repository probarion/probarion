import { execFileSync } from "node:child_process";

/**
 * The commit a build came from: Vercel's VERCEL_GIT_COMMIT_SHA, else `git rev-parse HEAD`, else
 * none.
 */
export function commitFrom(
  env: Readonly<Record<string, string | undefined>>,
  git: () => string | null,
): string | null {
  const fromVercel = env.VERCEL_GIT_COMMIT_SHA?.trim();
  return fromVercel ? fromVercel : git();
}

function gitHead(): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

let cached: string | null | undefined;

/** Server only: read once per build. */
export function buildCommit(): string | null {
  if (cached === undefined) cached = commitFrom(process.env, gitHead);
  return cached;
}
