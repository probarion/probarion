#!/usr/bin/env node
import { homedir } from "node:os";
import { main } from "./main.js";
import { safeMessage } from "./server.js";

main({
  env: process.env,
  home: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
})
  .then((r) => {
    if (r === 2) process.exit(2);
  })
  .catch((e: unknown) => {
    process.stderr.write(`probarion-mcp: fatal: ${safeMessage(e)}\n`);
    process.exit(1);
  });
