// What the probarion-mcp binary does, with its streams passed in so a test can drive it. stdout carries the
// MCP protocol, so every line for a person goes to stderr, the SDK's warnings included.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProbarionDeps } from "@probarion/sdk";
import { ConfigError, loadConfig, type McpConfig } from "./config.js";
import { buildPort } from "./probarion-port.js";
import { createServer, safeMessage } from "./server.js";

export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export interface MainIo {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Test seam: the SDK's clock and friends. The logger is always the one writing to `stderr`. */
  deps?: Omit<ProbarionDeps, "logger">;
}

/** Starts the server, or returns exit code 2 after naming every configuration problem on stderr. */
export async function main(io: MainIo): Promise<McpServer | 2> {
  let cfg: McpConfig;
  try {
    cfg = loadConfig(io.env, io.home);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.stderr.write(`probarion-mcp: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (!cfg.readOnly) mkdirSync(dirname(cfg.ledgerPath), { recursive: true });
  const logger = {
    warn: (message: string) => {
      io.stderr.write(`probarion-mcp: ${safeMessage(message)}\n`);
    },
  };
  const server = createServer(buildPort(cfg, { ...io.deps, logger }), {
    vault: cfg.vault,
    network: cfg.network,
    version: VERSION,
    readOnly: cfg.readOnly,
    agentPublicKey: cfg.agentPublicKey,
  });
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
  io.stderr.write(
    `probarion-mcp ${VERSION}: vault ${cfg.vault} on ${cfg.network}${cfg.readOnly ? " (read-only: no keys set)" : ""}, ledger ${cfg.ledgerPath}\n`,
  );
  return server;
}
