import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findGitWorkTree, realDirectory } from "../src/git-work-tree.js";
import { tempDir } from "./helpers.js";

/** A directory link that works on Windows without elevation (a junction) and elsewhere (a symlink). */
async function link(target: string, at: string): Promise<void> {
  await symlink(target, at, "junction");
}

describe("findGitWorkTree", () => {
  it("finds the nearest ancestor holding a .git directory", async () => {
    const root = await realpath(await tempDir());
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "a", "b"), { recursive: true });
    expect(await findGitWorkTree(join(root, "a", "b", "agent.json"))).toBe(root);
    expect(await findGitWorkTree(join(root, "agent.json"))).toBe(root);
  });

  it("finds a .git file, which is how a linked worktree or a submodule looks", async () => {
    const root = await realpath(await tempDir());
    await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");
    expect(await findGitWorkTree(join(root, "keys", "agent.json"))).toBe(root);
  });

  it("uses the inner repository when repositories are nested", async () => {
    const outer = await realpath(await tempDir());
    await mkdir(join(outer, ".git"));
    await mkdir(join(outer, "inner", ".git"), { recursive: true });
    expect(await findGitWorkTree(join(outer, "inner", "agent.json"))).toBe(join(outer, "inner"));
  });

  it("answers for a folder that does not exist yet, and creates nothing", async () => {
    const root = await realpath(await tempDir());
    await mkdir(join(root, ".git"));
    expect(await findGitWorkTree(join(root, "new", "deeper", "agent.json"))).toBe(root);
    expect(await readdir(root)).toEqual([".git"]);
  });

  it("is null outside a work tree", async (context) => {
    const dir = await tempDir();
    // The temp folder is normally outside every repository; if this machine's is not, skip.
    if ((await findGitWorkTree(join(dir, "probe"))) !== null) context.skip();
    expect(await findGitWorkTree(join(dir, "agent.json"))).toBeNull();
    expect(await findGitWorkTree(join(dir, "new", "agent.json"))).toBeNull();
  });

  it("does not read .gitignore: a file the .gitignore covers is still inside the work tree", async () => {
    const root = await realpath(await tempDir());
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".gitignore"), ".keys/\n");
    expect(await findGitWorkTree(join(root, ".keys", "agent.json"))).toBe(root);
  });

  it("follows a symlinked parent into a repository", async () => {
    const outside = await tempDir();
    const repo = await realpath(await tempDir());
    await mkdir(join(repo, ".git"));
    await mkdir(join(repo, "keys"));
    await link(join(repo, "keys"), join(outside, "via"));
    expect(await findGitWorkTree(join(outside, "via", "agent.json"))).toBe(repo);
  });

  it("follows a symlinked parent through a folder that does not exist yet", async () => {
    const outside = await tempDir();
    const repo = await realpath(await tempDir());
    await mkdir(join(repo, ".git"));
    await mkdir(join(repo, "keys"));
    await link(join(repo, "keys"), join(outside, "via"));
    expect(await findGitWorkTree(join(outside, "via", "new", "agent.json"))).toBe(repo);
  });

  // T15-R3: Git for Windows walks into a junction and commits the target's files as ordinary files,
  // so a key under a link that sits inside a repository is in the work tree as git sees it, even
  // though its real path is elsewhere.
  it("finds the repository for a link inside it that points out of it (the logical path)", async (context) => {
    const repo = await realpath(await tempDir());
    await mkdir(join(repo, ".git"));
    const away = await realpath(await tempDir());
    if ((await findGitWorkTree(join(away, "probe"))) !== null) context.skip();
    await link(away, join(repo, "keys"));
    expect(await findGitWorkTree(join(repo, "keys", "agent.json"))).toBe(repo);
    // Through a folder that does not exist yet beyond the link, too.
    expect(await findGitWorkTree(join(repo, "keys", "new", "agent.json"))).toBe(repo);
  });

  it("looks at the logical and the real folder, and is null only when neither is in a repository", async (context) => {
    const outside = await realpath(await tempDir());
    const away = await realpath(await tempDir());
    if ((await findGitWorkTree(join(away, "probe"))) !== null) context.skip();
    if ((await findGitWorkTree(join(outside, "probe"))) !== null) context.skip();
    await link(away, join(outside, "via"));
    expect(await findGitWorkTree(join(outside, "via", "agent.json"))).toBeNull();
  });

  it("answers for a link inside one repository that points into another", async () => {
    const first = await realpath(await tempDir());
    const second = await realpath(await tempDir());
    await mkdir(join(first, ".git"));
    await mkdir(join(second, ".git"));
    await link(second, join(first, "keys"));
    expect(await findGitWorkTree(join(first, "keys", "agent.json"))).not.toBeNull();
  });
});

describe("realDirectory", () => {
  it("returns the real path of an existing folder and puts missing names back", async () => {
    const root = await realpath(await tempDir());
    expect(await realDirectory(root)).toBe(root);
    expect(await realDirectory(join(root, "a", "b"))).toBe(join(root, "a", "b"));
    expect(await readdir(root)).toEqual([]);
  });
});
