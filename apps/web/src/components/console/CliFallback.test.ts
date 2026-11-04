import { NETWORKS } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLI_ON_NPM, CLI_SETUP_LINES, cli } from "@/lib/proof/cli";
import { CliFallback } from "./CliFallback";

/** The text a visitor copies from the command box: its content, entities decoded, newlines kept. */
const shown = (factory: string, network: "mainnet" | "testnet") =>
  (
    /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(
      renderToStaticMarkup(createElement(CliFallback, { factory, network, reason: "unreachable" })),
    )?.[1] ?? ""
  )
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

const command = (network: string) =>
  cli(
    `--network ${network} vault create --name <name> --approvers <approver.near> --daily-backstop 500 --held-ttl-hours 72 --sign-as <you.near>`,
  );

describe("the console's create-vault fallback", () => {
  it("shows one command line that both bash and Windows PowerShell run, for the network's own factory", () => {
    const text = shown(NETWORKS.mainnet.factory, "mainnet");
    const lines = text.split("\n");
    expect(lines).toContain(command("mainnet"));
    // No bash-only syntax: no VAR=value prefix, no backslash line continuation.
    expect(text).not.toContain("PROBARION_FACTORY_ID");
    expect(lines.some((l) => l.trimEnd().endsWith("\\"))).toBe(false);
    if (!CLI_ON_NPM) {
      for (const line of CLI_SETUP_LINES) expect(lines).toContain(`#   ${line}`);
    }
  });

  it("sets another factory with one labelled line per shell, before the same command", () => {
    const text = shown("vaults.staging.testnet", "testnet");
    const lines = text.split("\n");
    expect(lines).toContain("# bash:");
    expect(lines).toContain("export PROBARION_FACTORY_ID=vaults.staging.testnet");
    expect(lines).toContain("# Windows PowerShell:");
    expect(lines).toContain('$env:PROBARION_FACTORY_ID = "vaults.staging.testnet"');
    expect(lines).toContain(command("testnet"));
    expect(lines.indexOf(command("testnet"))).toBeGreaterThan(
      lines.indexOf('$env:PROBARION_FACTORY_ID = "vaults.staging.testnet"'),
    );
    expect(lines.some((l) => l.trimEnd().endsWith("\\"))).toBe(false);
  });
});
