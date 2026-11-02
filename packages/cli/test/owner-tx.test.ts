import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { displayPath, printOwnerTx, renderNearCliCommand } from "../src/owner-tx.js";
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

  it("closes a quote inside a path instead of letting it break out", () => {
    const line = renderNearCliCommand(TX, "./o'brien/freeze.args.json");
    expect(line).toContain("file-args './o'\\''brien/freeze.args.json' prepaid-gas");
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
