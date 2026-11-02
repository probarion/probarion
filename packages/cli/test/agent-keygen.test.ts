import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicKeyFromSecret } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { findGitWorkTree } from "../src/git-work-tree.js";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

type Saved = { public_key: string; secret_key: string };

async function saved(dir: string, file: string): Promise<Saved> {
  return JSON.parse(await readFile(join(dir, file), "utf8")) as Saved;
}

describe("agent keygen: one of --out and --print-secret is required (T15-R1, ICR-7)", () => {
  it("with neither flag it fails cleanly, explains both options and prints no key", async () => {
    const dir = await tempDir();
    for (const argv of [
      ["agent", "keygen"],
      ["agent", "keygen", "--json"],
    ]) {
      const { io, state } = testIo(dir);
      expect(await runCli(argv, io)).toBe(1);
      expect(state.out).toBe("");
      expect(state.err).toContain("--out <file>");
      expect(state.err).toContain("--print-secret");
      expect(state.err).toMatch(/^error: agent keygen needs one of/);
      expect(state.err).not.toContain("ed25519:");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses both flags together", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--out", "k.json", "--print-secret"], io)).toBe(1);
    expect(state.err).toContain("not both");
    expect(state.out).toBe("");
    expect(await readdir(dir)).toEqual([]);
  });

  it("--print-secret --json prints a NEAR key pair whose secret derives the public key", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--print-secret", "--json"], io)).toBe(0);
    const pair = JSON.parse(state.out) as Saved;
    expect(publicKeyFromSecret(pair.secret_key)).toBe(pair.public_key);
    expect(Object.keys(pair).sort()).toEqual(["public_key", "secret_key"]);
  });

  it("--print-secret prints a readable pair with the secret-handling advice", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--print-secret"], io)).toBe(0);
    const secret = /^secret_key: (\S+)$/m.exec(state.out)?.[1] ?? "";
    const pub = /^public_key: (\S+)$/m.exec(state.out)?.[1] ?? "";
    expect(publicKeyFromSecret(secret)).toBe(pub);
    expect(state.out).toContain("Keep the secret server-side only");
    expect(state.out).toContain("--out");
    expect(await readdir(dir)).toEqual([]);
  });

  it("never gives two runs the same key", async () => {
    const dir = await tempDir();
    const a = testIo(dir);
    const b = testIo(dir);
    await runCli(["agent", "keygen", "--print-secret", "--json"], a.io);
    await runCli(["agent", "keygen", "--print-secret", "--json"], b.io);
    expect(JSON.parse(a.state.out).public_key).not.toBe(JSON.parse(b.state.out).public_key);
  });
});

describe("agent keygen --out writes the pair to a private file and keeps the secret off stdout", () => {
  it("prints only the public key and the path", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir, {}, "linux");
    expect(await runCli(["agent", "keygen", "--out", "keys/agent.json"], io)).toBe(0);
    const pair = await saved(dir, "keys/agent.json");
    expect(publicKeyFromSecret(pair.secret_key)).toBe(pair.public_key);
    expect(state.out).toContain(pair.public_key);
    expect(state.out).toContain("./keys/agent.json");
    expect(state.out).toContain("(mode 0600)");
    expect(state.out).not.toContain(pair.secret_key);
    expect(state.err).not.toContain(pair.secret_key);
  });

  it("keeps the secret off stdout in JSON mode too", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--json", "--out", "agent.json"], io)).toBe(0);
    const pair = await saved(dir, "agent.json");
    const printed = JSON.parse(state.out) as Record<string, string>;
    expect(Object.keys(printed).sort()).toEqual(["public_key", "secret_file"]);
    expect(printed.secret_file).toBe("./agent.json");
    expect(state.out).not.toContain(pair.secret_key);
  });

  it.skipIf(process.platform === "win32")(
    "creates the file readable by its owner only",
    async () => {
      const dir = await tempDir();
      const { io } = testIo(dir);
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect((await stat(join(dir, "agent.json"))).mode & 0o777).toBe(0o600);
    },
  );

  it("refuses to overwrite an existing file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "agent.json"), "precious");
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(1);
    expect(state.err).toContain("agent.json");
    expect(state.out).toBe("");
    expect(await readFile(join(dir, "agent.json"), "utf8")).toBe("precious");
  });

  it("refuses a path with a single quote, which bash and PowerShell quote differently", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--out", "o'brien/agent.json"], io)).toBe(1);
    expect(state.err).toMatch(/--out: the path .* single quote/);
    expect(state.out).toBe("");
    // Nothing was created, and no key was generated into a file.
    expect(await readdir(dir)).toEqual([]);
  });

  describe("warnings go to stderr, never into the JSON on stdout", () => {
    it("on Windows it says that mode bits do not restrict the file", async () => {
      const dir = await tempDir();
      const { io, state } = testIo(dir, {}, "win32");
      expect(await runCli(["agent", "keygen", "--json", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toContain("on Windows, file permissions are not restricted by mode bits");
      expect(state.err).toContain("./agent.json");
      expect(() => JSON.parse(state.out)).not.toThrow();
      expect(state.out).not.toContain("Windows");
      const text = testIo(dir, {}, "win32");
      expect(await runCli(["agent", "keygen", "--out", "second.json"], text.io)).toBe(0);
      expect(text.state.out).not.toContain("mode 0600");
    });

    it("elsewhere it does not", async () => {
      const dir = await tempDir();
      for (const platform of ["linux", "darwin"] as const) {
        const { io, state } = testIo(dir, {}, platform);
        expect(await runCli(["agent", "keygen", "--out", `${platform}.json`], io)).toBe(0);
        expect(state.err).not.toContain("Windows");
      }
    });

    async function inRepo(setup: (dir: string) => Promise<void>, out: string, json = false) {
      const dir = await tempDir();
      await mkdir(join(dir, ".git"));
      await setup(dir);
      const { io, state } = testIo(dir, {}, "linux");
      const code = await runCli(["agent", "keygen", ...(json ? ["--json"] : []), "--out", out], io);
      return { code, ...state, dir };
    }

    const WARNING = (file: string) =>
      `warning: this file is inside a git repository: make sure it is ignored and not tracked (git check-ignore -v ${file}; git ls-files ${file})\n`;

    it("always warns inside a git repository, and names the two commands that settle it", async () => {
      const r = await inRepo(async () => {}, "keys/agent.json");
      expect(r.code).toBe(0);
      expect(r.err).toBe(WARNING("./keys/agent.json"));
      expect(r.err).not.toContain("\\");
      expect(r.out).not.toContain("warning");
    });

    // T15-R2: a partial .gitignore parser gave false all-clears. These are the setups where git
    // would ignore or track the file differently from what the root .gitignore alone says; the
    // warning does not depend on any of them.
    it.each([
      ["a root .gitignore that plainly covers the folder", ".keys/\n", ".keys/agent.json"],
      ["a root .gitignore that covers the file by pattern", "*.json\n", "agent.json"],
      [
        "a pattern followed by a tab, which git keeps as part of the name",
        "keys/\t\n",
        "keys/agent.json",
      ],
      ["a pattern with CRLF line endings", "keys/\r\n", "keys/agent.json"],
      ["an anchored folder", "/secrets\n", "secrets/agent.json"],
      ["a .gitignore that does not mention it", "node_modules/\n", "keys/agent.json"],
    ])("warns with %s", async (_name, gitignore, out) => {
      const r = await inRepo(async (dir) => {
        await writeFile(join(dir, ".gitignore"), gitignore);
      }, out);
      expect(r.err).toBe(WARNING(`./${out}`));
    });

    it("warns when a nested .gitignore re-includes the file the root ignores", async () => {
      const r = await inRepo(async (dir) => {
        await writeFile(join(dir, ".gitignore"), "*.json\n");
        await mkdir(join(dir, "keys"));
        await writeFile(join(dir, "keys", ".gitignore"), "!agent.json\n");
      }, "keys/agent.json");
      expect(r.err).toBe(WARNING("./keys/agent.json"));
    });

    it("warns when the folder was ignored after the file was committed earlier", async () => {
      // `keys/` is in .gitignore, but .gitignore never applies to a path the index already tracks;
      // a committed keys/ entry is simulated by an index file next to a .gitignore that covers it.
      const r = await inRepo(async (dir) => {
        await writeFile(join(dir, ".git", "index"), "DIRC");
        await writeFile(join(dir, ".gitignore"), "keys/\n");
      }, "keys/agent.json");
      expect(r.err).toBe(WARNING("./keys/agent.json"));
    });

    it("quotes a path with a space in the two commands to run", async () => {
      const r = await inRepo(async () => {}, "my keys/agent.json");
      expect(r.err).toBe(WARNING("'./my keys/agent.json'"));
    });

    it("keeps the warning off stdout, so --json output stays parseable", async () => {
      const r = await inRepo(async () => {}, "agent.json", true);
      expect(r.err).toContain("this file is inside a git repository");
      expect(() => JSON.parse(r.out)).not.toThrow();
      expect(Object.keys(JSON.parse(r.out)).sort()).toEqual(["public_key", "secret_file"]);
    });

    it("recognises a .git file, which is how a linked worktree or submodule looks", async () => {
      const dir = await tempDir();
      await writeFile(join(dir, ".git"), "gitdir: /elsewhere\n");
      const { io, state } = testIo(dir, {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toBe(WARNING("./agent.json"));
    });

    it("looks above the file's own folder for the repository", async () => {
      const dir = await tempDir();
      await mkdir(join(dir, ".git"));
      await mkdir(join(dir, "a", "b"), { recursive: true });
      const { io, state } = testIo(join(dir, "a", "b"), {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toBe(WARNING("./agent.json"));
    });

    it("warns when --out goes through a symlinked folder into a repository", async () => {
      const outside = await tempDir();
      const repo = await tempDir();
      await mkdir(join(repo, ".git"));
      await mkdir(join(repo, "keys"));
      await symlink(join(repo, "keys"), join(outside, "via"), "junction");
      const { io, state } = testIo(outside, {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "via/agent.json"], io)).toBe(0);
      expect(state.err).toBe(WARNING("./via/agent.json"));
      // The key really is in the repository.
      expect(await readdir(join(repo, "keys"))).toEqual(["agent.json"]);
    });

    // T15-R3: keys/ is a junction to a folder outside the repository. The key is physically outside,
    // but Git for Windows walks into the junction, so `git add -A` would stage it. Warn.
    it("warns when --out goes through a link inside a repository that points out of it", async (context) => {
      const repo = await tempDir();
      const away = await tempDir();
      if ((await findGitWorkTree(join(away, "probe"))) !== null) context.skip();
      await mkdir(join(repo, ".git"));
      await symlink(away, join(repo, "keys"), "junction");
      const { io, state } = testIo(repo, {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "keys/agent.json"], io)).toBe(0);
      expect(state.err).toBe(WARNING("./keys/agent.json"));
      // The key really is outside the repository.
      expect(await readdir(away)).toEqual(["agent.json"]);
    });

    it("says nothing about git outside a work tree", async (context) => {
      const dir = await tempDir();
      // The temp folder is normally outside every repository; if this machine's is not, skip.
      if ((await findGitWorkTree(join(dir, "agent.json"))) !== null) context.skip();
      const { io, state } = testIo(dir, {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toBe("");
    });
  });
});
