// What the commands print to a person: an unknown argument named without a secret in it, and the command this
// binary was started as.
import { describe, expect, it } from "vitest";
import { argumentShown, invokedAs, shellWord } from "../src/words.js";

describe("an unknown argument as a usage error names it", () => {
  it("echoes a flag or a word, and of NAME=value only the name", () => {
    expect(argumentShown("--extra", 2)).toBe('"--extra"');
    expect(argumentShown("-x", 1)).toBe('"-x"');
    expect(argumentShown("statsu", 1)).toBe('"statsu"');
    expect(argumentShown("--keyfile=/home/me/keys.json", 3)).toBe('"--keyfile=..."');
    expect(argumentShown("PROBARION_AGENT_KEY=ed25519:abc", 1)).toBe('"PROBARION_AGENT_KEY=..."');
  });

  it("names anything else by its position only: a secret key cut short still gives the whole key away", () => {
    const secret = `ed25519:${"7".repeat(87)}`;
    for (const arg of [secret, secret.slice("ed25519:".length), "a b", "x".repeat(40), ""]) {
      const shown = argumentShown(arg, 4);
      expect(shown).toBe("4 (not shown: it is not a flag or a word, and could be a key)");
    }
  });
});

describe("the command this binary was started as", () => {
  it("is probarion-mcp when it is installed from npm, through a bin link or its Windows shims", () => {
    expect(invokedAs("/usr/local/bin/probarion-mcp", "0.1.1", "linux")).toBe("probarion-mcp");
    expect(
      invokedAs("C:\\Users\\me\\AppData\\Roaming\\npm\\probarion-mcp.cmd", "0.1.1", "win32"),
    ).toBe("probarion-mcp");
    expect(
      invokedAs(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@probarion\\mcp\\dist\\bin.js",
        "0.1.1",
        "win32",
      ),
    ).toBe("probarion-mcp");
    expect(invokedAs(undefined, "0.1.1", "linux")).toBe("probarion-mcp");
  });

  it("is the npx line when npx runs it", () => {
    expect(
      invokedAs(
        "/home/me/.npm/_npx/0a1b/node_modules/@probarion/mcp/dist/bin.js",
        "0.1.1",
        "linux",
      ),
    ).toBe("npx -y @probarion/mcp@0.1.1");
    expect(
      invokedAs(
        "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\@probarion\\mcp\\dist\\bin.js",
        "0.1.1",
        "win32",
      ),
    ).toBe("npx -y @probarion/mcp@0.1.1");
  });

  it("is node and the script's path from a clone, quoted only when the path needs it", () => {
    expect(invokedAs("/src/probarion/packages/mcp/dist/bin.js", "0.1.0", "linux")).toBe(
      "node /src/probarion/packages/mcp/dist/bin.js",
    );
    expect(invokedAs("C:\\src\\probarion\\packages\\mcp\\dist\\bin.js", "0.1.0", "win32")).toBe(
      "node C:/src/probarion/packages/mcp/dist/bin.js",
    );
    expect(invokedAs("/home/me/my code/probarion/packages/mcp/dist/bin.js", "0.1.0", "linux")).toBe(
      "node '/home/me/my code/probarion/packages/mcp/dist/bin.js'",
    );
  });

  it("quotes a value as one shell word, and refuses one with a single quote", () => {
    expect(shellWord("acme.testnet")).toBe("acme.testnet");
    expect(shellWord("ed25519:abc")).toBe("'ed25519:abc'");
    expect(shellWord("it's")).toBeNull();
  });
});
