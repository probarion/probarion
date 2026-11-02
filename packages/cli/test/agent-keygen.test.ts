import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicKeyFromSecret } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { gitIgnoreStatus } from "../src/git-ignore.js";
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

    async function inRepo(gitignore: string | null, out: string) {
      const dir = await tempDir();
      await mkdir(join(dir, ".git"));
      if (gitignore !== null) await writeFile(join(dir, ".gitignore"), gitignore);
      const { io, state } = testIo(dir, {}, "linux");
      const code = await runCli(["agent", "keygen", "--out", out], io);
      return { code, ...state, dir };
    }

    it("warns when the file sits in a git work tree with no .gitignore at all", async () => {
      const r = await inRepo(null, "keys/agent.json");
      expect(r.code).toBe(0);
      expect(r.err).toContain("is inside the git work tree");
      expect(r.err).toContain("./keys/agent.json");
      expect(r.err).toContain('before you run "git add"');
      expect(r.err).not.toContain("\\");
    });

    it("warns when the .gitignore does not cover it", async () => {
      const r = await inRepo("node_modules/\n*.pem\n", "keys/agent.json");
      expect(r.err).toContain("is inside the git work tree");
    });

    it("warns when it cannot decide: a negation, or a pattern it does not evaluate", async () => {
      expect((await inRepo("keys/\n!keys/agent.json\n", "keys/agent.json")).err).toContain(
        "is inside the git work tree",
      );
      expect((await inRepo("**/keys/\n", "keys/agent.json")).err).toContain(
        "is inside the git work tree",
      );
    });

    it("stays quiet when the .gitignore plainly covers the file", async () => {
      expect((await inRepo(".keys/\n", ".keys/agent.json")).err).toBe("");
      expect((await inRepo("# keys\nkeys/\n", "keys/agent.json")).err).toBe("");
      expect((await inRepo("/secrets\n", "secrets/agent.json")).err).toBe("");
      expect((await inRepo("*.json\n", "agent.json")).err).toBe("");
      expect((await inRepo("agent.json\r\n", "keys/agent.json")).err).toBe("");
    });

    it("recognises a .git file, which is how a linked worktree or submodule looks", async () => {
      const dir = await tempDir();
      await writeFile(join(dir, ".git"), "gitdir: /elsewhere\n");
      const { io, state } = testIo(dir, {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toContain("is inside the git work tree");
    });

    it("looks above the file's own folder for the repository", async () => {
      const dir = await tempDir();
      await mkdir(join(dir, ".git"));
      await mkdir(join(dir, "a", "b"), { recursive: true });
      const { io, state } = testIo(join(dir, "a", "b"), {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toContain("is inside the git work tree");
    });

    it("says nothing about git outside a work tree", async (context) => {
      const dir = await tempDir();
      // The temp folder is normally outside every repository; if this machine's is not, skip.
      if ((await gitIgnoreStatus(join(dir, "agent.json"))).root !== null) context.skip();
      const { io, state } = testIo(dir, {}, "linux");
      expect(await runCli(["agent", "keygen", "--out", "agent.json"], io)).toBe(0);
      expect(state.err).toBe("");
    });
  });
});
