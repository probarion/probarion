export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  now(): Date;
  setExitCode(code: number): void;
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
  };
}
