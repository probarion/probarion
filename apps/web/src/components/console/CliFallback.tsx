import { NETWORKS } from "@probarion/core";
import type { Network } from "@/lib/config";
import { CLI_ON_NPM, CLI_SETUP_LINES, cli } from "@/lib/proof/cli";

/** Why the console cannot offer the factory form right now, in words. */
const REASONS = {
  unreachable: "NEAR could not be reached, so the factory's settings cannot be read",
  not_deployed: "there is no factory contract at that account on this network",
  no_version: "the factory has no vault version registered yet",
  bad_answer: "the factory answered with something the console could not read",
} as const;

export type CliFallbackReason = keyof typeof REASONS;

/**
 * The lines to show, each one runnable as it is in bash and in Windows PowerShell 5.1 (`#` is a comment in both; no
 * `VAR=value` prefix, no `\` line continuation). The CLI has no flag for the factory: it reads PROBARION_FACTORY_ID,
 * else the network's own factory, so the variable is set only for another factory, with one labelled line per shell.
 */
export function cliFallbackLines(factory: string, network: Network): string[] {
  const lines: string[] = [];
  if (!CLI_ON_NPM) {
    lines.push(
      "# From a clone of the repository (the probarion npm package is coming), set up once:",
      ...CLI_SETUP_LINES.map((l) => `#   ${l}`),
      "# then, from that folder:",
    );
  }
  if (factory !== NETWORKS[network].factory) {
    lines.push(
      `# This console uses the factory ${factory}. Set it first, with the line for your shell:`,
      "# bash:",
      `export PROBARION_FACTORY_ID=${factory}`,
      "# Windows PowerShell:",
      `$env:PROBARION_FACTORY_ID = "${factory}"`,
    );
  }
  lines.push(
    cli(
      `--network ${network} vault create --name <name> --approvers <approver.near> --daily-backstop 500 --held-ttl-hours 72 --sign-as <you.near>`,
    ),
    "# Add --deposit <near> for an embedded factory version.",
    "# It reads the factory's min_deposit and mode, and prints the near-cli-rs command.",
    "# You sign it with your own key (OWNER SIGNS).",
  );
  return lines;
}

/**
 * Spec §17 cut line 6: if the factory cannot be used from here, create the vault white-glove with
 * the CLI (packages/cli). It prints the transaction for near-cli-rs and never signs.
 */
export function CliFallback({
  factory,
  network,
  reason,
}: {
  factory: string;
  network: Network;
  reason: CliFallbackReason;
}) {
  return (
    <div className="text-sm">
      <p className="mb-2">
        The console cannot create a vault through the factory (
        <span className="mono">{factory}</span>) right now: {REASONS[reason]}. Nothing was prepared
        or signed. You can create the vault with the CLI instead, then register it below:
      </p>
      <pre className="overflow-x-auto rounded-2xl bg-[#0B0B0C] p-4 text-xs text-[#F7F6F3]">
        {cliFallbackLines(factory, network).join("\n")}
      </pre>
    </div>
  );
}
