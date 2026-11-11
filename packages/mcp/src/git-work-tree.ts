// Is this file inside a git work tree? Used to warn before a keys file lands in a repository; the same check as
// the probarion CLI's `agent keygen --out` (packages/cli/src/git-work-tree.ts). It does not try to say whether git
// ignores or tracks the file: that depends on nested .gitignore files, .git/info/exclude, the global ignore file
// and the index, and a partial answer is worse than none. So any file in a work tree gets the warning, and the
// warning names the git commands that answer it. No git process is started.
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The real path of `dir` (symlinks and junctions resolved) even when it does not exist yet. Creates nothing. */
async function realDirectory(dir: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The nearest ancestor of `start` (itself included) holding `.git`, or null. Walks the path as written. */
async function walkUp(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The work tree `file` is in, or null, looked for from the folder as written and from the real folder (links
 * resolved): either one inside a work tree puts the file where git sees it. `.git` is a folder in a repository
 * and a file in a linked worktree or a submodule.
 */
export async function findGitWorkTree(file: string): Promise<string | null> {
  const logical = path.dirname(path.resolve(file));
  return (await walkUp(logical)) ?? (await walkUp(await realDirectory(logical)));
}
