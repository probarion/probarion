#!/usr/bin/env node
import { homedir } from "node:os";
import { runCommand } from "./cli.js";
import { main, VERSION } from "./main.js";
import { safeMessage } from "./server.js";
import { invokedAs } from "./words.js";

const args = process.argv.slice(2);
// The command a person runs this binary as, for the commands init and status print (node and a path, from a clone).
const self = invokedAs(process.argv[1], VERSION, process.platform);

if (args.length > 0) {
  // A command for a person (init, status, demo, --version, --help). The exit code is set, not forced, so the transcript
  // is written out in full before the process ends.
  runCommand(args, { env: process.env, out: process.stdout, err: process.stderr, self })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`probarion-mcp: fatal: ${safeMessage(e)}\n`);
      process.exitCode = 1;
    });
} else {
  main({
    env: process.env,
    home: homedir(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    self,
  })
    .then((r) => {
      if (r === 2) process.exit(2);
    })
    .catch((e: unknown) => {
      process.stderr.write(`probarion-mcp: fatal: ${safeMessage(e)}\n`);
      process.exit(1);
    });
}
