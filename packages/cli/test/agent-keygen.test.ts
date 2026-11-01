import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publicKeyFromSecret } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

describe("agent keygen", () => {
  it("prints a NEAR key pair whose secret derives the public key", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen", "--json"], io)).toBe(0);
    const pair = JSON.parse(state.out) as { public_key: string; secret_key: string };
    expect(publicKeyFromSecret(pair.secret_key)).toBe(pair.public_key);
  });

  it("prints a readable pair by default, with the secret-handling advice", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    expect(await runCli(["agent", "keygen"], io)).toBe(0);
    const secret = /^secret_key: (\S+)$/m.exec(state.out)?.[1] ?? "";
    const pub = /^public_key: (\S+)$/m.exec(state.out)?.[1] ?? "";
    expect(publicKeyFromSecret(secret)).toBe(pub);
    expect(state.out).toContain("Keep the secret server-side only");
    expect(state.out).toContain("--out");
  });

  it("never gives two runs the same key", async () => {
    const dir = await tempDir();
    const a = testIo(dir);
    const b = testIo(dir);
    await runCli(["agent", "keygen", "--json"], a.io);
    await runCli(["agent", "keygen", "--json"], b.io);
    expect(JSON.parse(a.state.out).public_key).not.toBe(JSON.parse(b.state.out).public_key);
  });

  describe("--out writes the pair to a private file and keeps the secret off stdout", () => {
    it("prints only the public key and the path", async () => {
      const dir = await tempDir();
      const { io, state } = testIo(dir);
      expect(await runCli(["agent", "keygen", "--out", "keys/agent.json"], io)).toBe(0);
      const saved = JSON.parse(await readFile(join(dir, "keys/agent.json"), "utf8")) as {
        public_key: string;
        secret_key: string;
      };
      expect(publicKeyFromSecret(saved.secret_key)).toBe(saved.public_key);
      expect(state.out).toContain(saved.public_key);
      expect(state.out).toContain("./keys/agent.json");
      expect(state.out).not.toContain(saved.secret_key);
      expect(state.err).not.toContain(saved.secret_key);
    });

    it("keeps the secret off stdout in JSON mode too", async () => {
      const dir = await tempDir();
      const { io, state } = testIo(dir);
      expect(await runCli(["agent", "keygen", "--json", "--out", "agent.json"], io)).toBe(0);
      const saved = JSON.parse(await readFile(join(dir, "agent.json"), "utf8")) as {
        secret_key: string;
      };
      const printed = JSON.parse(state.out) as Record<string, string>;
      expect(Object.keys(printed).sort()).toEqual(["public_key", "secret_file"]);
      expect(state.out).not.toContain(saved.secret_key);
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
  });
});
