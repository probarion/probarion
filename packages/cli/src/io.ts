import type { OnlineAttestationVerifier, TxIndex } from "@probarion/sdk";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  now(): Date;
  setExitCode(code: number): void;
  /** Defaults to the running platform; only the Windows-specific warnings read it. */
  platform?: NodeJS.Platform;
  /**
   * Tests and hosts only: what `verify --online` uses instead of the SDK's defaults (`@nearai/inference-sdk` for
   * O1/O2 and FastNEAR's tx index). The `probarion` binary passes nothing.
   */
  verifyDeps?: {
    onlineVerifier?: OnlineAttestationVerifier | null;
    txIndex?: TxIndex | null;
  };
  /** Tests and hosts only: the fetch `payee check` reads the chains with. The `probarion` binary passes nothing. */
  payeeDeps?: {
    fetch?: typeof fetch;
  };
}

export function processIo(): CliIo {
  return {
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    platform: process.platform,
  };
}
