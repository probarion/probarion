import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The store pack and the instructions around it: what a store reviewer, a judge and the OWNER read.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the store pack", () => {
  it("shows the connect page in a state the page really has", () => {
    // The page swaps the Connect extension button for a sentence once the extension took the token (ConnectPanel.tsx),
    // lists the browsers connected earlier with their dates and a Revoke button (ConnectedBrowsers.tsx), and shows the
    // green notice.
    const html = read("store/preview/connect.html");
    expect(html).toContain("To connect again, press Connect in the extension.");
    expect(html).toContain("Connected. You can close this tab.");
    expect(html).not.toMatch(/>\s*Connect extension\s*</);
    for (const part of ["Connected browsers", "last used", "ends", "Revoke", "pbx_"]) {
      expect(html).toContain(part);
    }
  });

  it("ends the manual checklist by disconnecting, which ends the token", () => {
    const items = read("TESTING.md")
      .split(/^- \[ \] /m)
      .slice(1);
    expect(items.length).toBeGreaterThan(10);
    expect(items.at(-1)).toMatch(/Disconnect/);
    // The offline step needs a connection that is still live, so it comes before the step that expires one.
    const at = (text: RegExp) => items.findIndex((i) => text.test(i));
    expect(at(/Stop `next dev`/)).toBeLessThan(at(/`expires_at` in the past/));
  });

  it("checks the Connected browsers list by a row's Connected time, and puts the owner back after the approver", () => {
    const items = read("TESTING.md")
      .split(/^- \[ \] /m)
      .slice(1);
    const find = (text: RegExp) => items.find((i) => text.test(i)) ?? "";
    // Other live connections of the account share the list, so a count cannot tell which row is this browser's.
    for (const step of [find(/\*\*Reconnect\*\* and connect again/), items.at(-1) ?? ""]) {
      expect(step).toMatch(/Connected time/);
      expect(step).not.toMatch(/not two|No browser is connected/);
    }
    // The approver's connection replaces the owner's and ends its token, so the owner connects again before the
    // steps that need the owner.
    const approver = find(/^Optional, with a second wallet/);
    expect(approver).toMatch(/Disconnect[\s\S]*Connect\*\* again/);
    expect(items.indexOf(find(/\*\*Confirm\*\* the first queued invoice/))).toBeGreaterThan(
      items.indexOf(approver),
    );
  });

  it("gives commands a shell can run: no && for Windows PowerShell 5.1", () => {
    for (const path of ["README.md", "TESTING.md", "store/README.md"]) {
      const lines = read(path)
        .split("\n")
        .filter((l) => l.includes("&&") && !l.includes("has no `&&`"));
      expect(lines, path).toEqual([]);
    }
  });
});
