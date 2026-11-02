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

/**
 * The work tree `file` is in, or null. Resolves the real path of the file's folder first (a symlinked
 * parent pointing into a repository counts as inside it, and one pointing out of it does not), then
 * walks up looking for `.git`, which is a directory in a repository and a file in a linked worktree
 * or a submodule.
 */
export async function findGitWorkTree(file: string): Promise<string | null> {
  let dir = await realDirectory(path.dirname(path.resolve(file)));
  for (;;) {
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
