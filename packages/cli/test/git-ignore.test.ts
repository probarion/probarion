import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitIgnoreStatus, gitignoreCovers } from "../src/git-ignore.js";
import { tempDir } from "./helpers.js";

describe("gitignoreCovers: the patterns it evaluates", () => {
  it.each([
    // [gitignore, path, covered]
    [".keys/", ".keys/agent.json", true],
    [".keys/", "sub/.keys/agent.json", true],
    [".keys/", ".keys", false], // a file named .keys is not the directory
    [".keys", ".keys", true],
    [".keys", "a/.keys/x.json", true],
    ["/keys/", "keys/a.json", true],
    ["/keys/", "sub/keys/a.json", false],
    ["/keys", "keys", true],
    ["keys/agent.json", "keys/agent.json", true],
    ["keys/agent.json", "sub/keys/agent.json", false],
    ["*.pem", "a/b/key.pem", true],
    ["*.pem", "key.pem.txt", false],
    ["*.json", "agent.json", true],
    ["agent?.json", "agent1.json", true],
    ["agent?.json", "agent.json", false],
    ["dist/", "dist/x/y.js", true],
    ["docs/*.md", "docs/a.md", true],
    ["docs/*.md", "docs/sub/a.md", false],
    ["a.b", "axb", false], // the dot is a dot, not a wildcard
    ["# a comment\n.keys/", ".keys/k.json", true],
    ["\n\n  \n.keys/  \n", ".keys/k.json", true],
    [".keys/\r\n", ".keys/k.json", true],
    ["", "k.json", false],
    ["node_modules/\ntarget/\n", ".keys/k.json", false],
  ])("%j covers %j: %s", (text, path, expected) => {
    expect(gitignoreCovers(text, path)).toBe(expected);
  });

  it("gives up, so the caller warns, on what it does not evaluate", () => {
    expect(gitignoreCovers("!keep.json\n.keys/", ".keys/k.json")).toBe(false); // a negation anywhere
    expect(gitignoreCovers("**/keys/", "keys/k.json")).toBe(false);
    expect(gitignoreCovers("keys/**", "keys/k.json")).toBe(false);
    expect(gitignoreCovers("[kK]eys/", "keys/k.json")).toBe(false);
    expect(gitignoreCovers("ke\\ys/", "keys/k.json")).toBe(false);
  });

  it("does not let an earlier unsupported line hide a later plain one", () => {
    expect(gitignoreCovers("**/x/\n.keys/", ".keys/k.json")).toBe(true);
  });
});

describe("gitIgnoreStatus", () => {
  it("finds the nearest ancestor with .git and reads its .gitignore", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".gitignore"), ".keys/\n");
    await mkdir(join(root, "a", "b"), { recursive: true });
    const covered = await gitIgnoreStatus(join(root, ".keys", "agent.json"));
    expect(covered.root).toBe(root);
    expect(covered.ignored).toBe(true);
    const nested = await gitIgnoreStatus(join(root, "a", "b", "agent.json"));
    expect(nested.root).toBe(root);
    expect(nested.ignored).toBe(false);
  });

  it("uses the inner repository when repositories are nested", async () => {
    const outer = await tempDir();
    await mkdir(join(outer, ".git"));
    await writeFile(join(outer, ".gitignore"), "inner/\n");
    await mkdir(join(outer, "inner", ".git"), { recursive: true });
    const status = await gitIgnoreStatus(join(outer, "inner", "agent.json"));
    expect(status.root).toBe(join(outer, "inner"));
    expect(status.ignored).toBe(false);
  });

  it("is not ignored when the root has no .gitignore", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"));
    expect(await gitIgnoreStatus(join(root, "k.json"))).toEqual({ root, ignored: false });
  });
});
