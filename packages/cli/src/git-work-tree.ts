import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// Answers one question: is this file inside a git work tree? It is used to warn before a secret key
// file lands in a repository, and it deliberately does not try to answer the harder questions
// ("would git ignore it?", "is it already tracked?"). Those depend on nested .gitignore files,
// .git/info/exclude, the global ignore file and the index, and a partial answer is worse than none:
// a reader of "no warning" takes it for "safe". So the caller warns whenever this finds a work
// tree, and tells the owner to run `git check-ignore -v` and `git ls-files` on the file. No git
// process is started.

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path of `dir`, resolving symlinks and junctions, even when `dir` does not exist yet: the
 * nearest existing ancestor is resolved and the missing names are put back. Creates nothing.
 */
export async function realDirectory(dir: string): Promise<string> {
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
 * The work tree `file` is in, or null. It looks from two places and answers yes if EITHER is inside
 * a work tree:
 * - the folder as written (`path.resolve(file)`, no link followed): a link inside a repository that
 *   points out of it still puts the key where git sees it, because Git for Windows walks into a
 *   junction and a plain `git add -A` stages the target's files as ordinary files;
 * - the real folder (symlinks and junctions resolved): a link outside every repository that points
 *   into one puts the key in that repository.
 * `.git` is a directory in a repository and a file in a linked worktree or a submodule.
 */
export async function findGitWorkTree(file: string): Promise<string | null> {
  const logical = path.dirname(path.resolve(file));
  return (await walkUp(logical)) ?? (await walkUp(await realDirectory(logical)));
}
