import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { displayPath, printOwnerTx, renderNearCliCommand, shellQuote } from "../src/owner-tx.js";
import { runCli } from "../src/program.js";
import { argsFileFor, tempDir, testIo } from "./helpers.js";

const TX = {
  network: "testnet",
  contractId: "acme.vaults.probarion.testnet",
  method: "freeze",
  args: {},
  gasTgas: "30.0",
  deposit: "0 NEAR",
} as const;

// The args file of a `freeze` print: {} is its whole content.
const FREEZE_FILE = argsFileFor("freeze", {});

describe("displayPath (R11: forward slashes, always)", () => {
  it("shows a file under the working directory as ./relative", () => {
    expect(displayPath("C:\\work", "C:\\work\\tx\\a.args.json", win32)).toBe("./tx/a.args.json");
    expect(displayPath("C:\\work", "C:\\work\\a.args.json", win32)).toBe("./a.args.json");
    expect(displayPath("/home/u", "/home/u/tx/a.args.json", posix)).toBe("./tx/a.args.json");
  });

  it("shows a file outside it as an absolute path with forward slashes", () => {
    expect(displayPath("C:\\work", "C:\\other\\a.args.json", win32)).toBe("C:/other/a.args.json");
    expect(displayPath("C:\\work\\sub", "C:\\work\\a.args.json", win32)).toBe(
      "C:/work/a.args.json",
    );
    expect(displayPath("/home/u", "/etc/a.args.json", posix)).toBe("/etc/a.args.json");
  });

  it("does not turn a path on another drive into ./D:/...", () => {
    expect(displayPath("C:\\work", "D:\\x\\a.args.json", win32)).toBe("D:/x/a.args.json");
  });

  it("does not treat a name that merely starts with two dots as outside", () => {
    expect(displayPath("/home/u", "/home/u/..hidden/a.json", posix)).toBe("./..hidden/a.json");
  });
});

describe("renderNearCliCommand", () => {
  it("quotes anything outside a plain path or account-id alphabet", () => {
    const line = renderNearCliCommand(TX, "C:/Users/Jo Doe/tx/freeze.args.json");
    expect(line).toContain("file-args 'C:/Users/Jo Doe/tx/freeze.args.json' prepaid-gas");
    expect(renderNearCliCommand(TX, "./tx/freeze.args.json")).toContain(
      "file-args ./tx/freeze.args.json prepaid-gas",
    );
  });

  // bash writes a quote inside single quotes as '\'' and PowerShell as '', and no spelling works in
  // both, so a value with a single quote is refused instead of printed.
  it("refuses a value with a single quote, which no quoting works for in both bash and PowerShell", () => {
    expect(() => renderNearCliCommand(TX, "./o'brien/freeze.args.json")).toThrow(CliError);
    expect(() => renderNearCliCommand(TX, "./o'brien/freeze.args.json")).toThrow(/single quote/);
    expect(() => shellQuote("it's")).toThrow(/bash and PowerShell/);
    expect(shellQuote("it is")).toBe("'it is'");
    expect(shellQuote("plain-path/ok_1.json")).toBe("plain-path/ok_1.json");
  });

  // PowerShell reads U+2018 to U+201B as single quotes, and a name pasted from a word processor or a
  // chat client carries them. Other non-ASCII text is fine inside single quotes.
  it.each([
    ["U+2018", "o‘brien"],
    ["U+2019", "o’brien"],
    ["U+201A", "o‚brien"],
    ["U+201B", "o‛brien"],
  ])("refuses the typographic single quote %s too", (_name, value) => {
    expect(() => shellQuote(value)).toThrow(/single quote .*bash and PowerShell/);
    expect(() => renderNearCliCommand(TX, `./${value}/freeze.args.json`)).toThrow(CliError);
  });

  it("still quotes other non-ASCII text, double typographic quotes included", () => {
    expect(shellQuote("café")).toBe("'café'");
    expect(shellQuote("say “hi”")).toBe("'say “hi”'");
  });

  it("puts a placeholder where the signer is unknown", () => {
    expect(renderNearCliCommand(TX, "./a.json")).toContain(
      "sign-as <owner-account-id> network-config",
    );
    expect(renderNearCliCommand({ ...TX, signer: "approver" }, "./a.json")).toContain(
      "sign-as <approver-account-id> network-config",
    );
    expect(renderNearCliCommand({ ...TX, signAs: "cfo.testnet" }, "./a.json")).toContain(
      "sign-as cfo.testnet network-config",
    );
  });
});

describe("printOwnerTx", () => {
  it("refuses an out dir with a single quote before it creates anything", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    await expect(printOwnerTx(io, TX, "o'brien")).rejects.toThrow(
      /--out-dir: the path .* single quote/,
    );
    expect(state.out).toBe("");
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses an out dir with a typographic single quote too, before it creates anything", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    await expect(printOwnerTx(io, TX, "o’brien")).rejects.toThrow(
      /--out-dir: the path .* single quote \(’\)/,
    );
    expect(state.out).toBe("");
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a quote only when the printed path shows it: the working directory itself is not printed", async () => {
    const parent = await tempDir();
    const cwd = join(parent, "o'brien");
    await mkdir(cwd);
    const { io, state } = testIo(cwd);
    await printOwnerTx(io, TX, ".");
    expect(state.out).toContain(`file-args ./${FREEZE_FILE} `);
    // From the parent folder the same directory is printed as ./o'brien/..., so that is refused.
    const fromParent = testIo(parent);
    await expect(printOwnerTx(fromParent.io, TX, cwd)).rejects.toThrow(/single quote/);
    expect(fromParent.state.out).toBe("");
  });

  it("writes <outDir>/<method>.<hash>.args.json and prints the command with forward slashes only", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    const file = await printOwnerTx(io, { ...TX, args: { a: 1 } }, "deep/er");
    const named = argsFileFor("freeze", { a: 1 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ a: 1 });
    const command = state.out.split("\n").find((l) => l.startsWith("near contract"));
    expect(command).toContain(`file-args ./deep/er/${named} `);
    const header = state.out.split("\n").find((l) => l.startsWith("freeze arguments ("));
    expect(header).toBe(`freeze arguments (./deep/er/${named}):`);
    expect(command).not.toContain("\\");
    expect(header).not.toContain("\\");
  });

  it("shows an absolute path with forward slashes when the out dir is outside the cwd", async () => {
    const dir = await tempDir();
    const elsewhere = await tempDir();
    const { io, state } = testIo(dir);
    await printOwnerTx(io, TX, elsewhere);
    const command = state.out.split("\n").find((l) => l.startsWith("near contract")) ?? "";
    const shown = /file-args (?:'([^']+)'|(\S+)) prepaid-gas/.exec(command);
    const path = shown?.[1] ?? shown?.[2] ?? "";
    expect(path).not.toContain("\\");
    expect(path.endsWith(`/${FREEZE_FILE}`)).toBe(true);
    expect(path).toBe(`${elsewhere.replaceAll("\\", "/")}/${FREEZE_FILE}`);
  });

  it("says plainly that it never signs, and offers the Ledger variant", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir);
    await printOwnerTx(io, TX, ".");
    expect(state.out).toContain("probarion never signs owner or approver transactions");
    expect(state.out).toContain(
      "replace `sign-with-keychain send` with `sign-with-ledger usb send`",
    );
  });

  it("goes through the CLI with a nested --out-dir", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: "acme.vaults.probarion.testnet" });
    expect(await runCli(["vault", "freeze", "--out-dir", "a/b"], io)).toBe(0);
    expect(state.out).toContain(`file-args ./a/b/${FREEZE_FILE} `);
  });
});
