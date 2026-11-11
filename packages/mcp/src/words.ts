// Words for what the commands print to a person: a value as one shell word, a path as the user's shell takes it,
// an unknown argument named without echoing a secret, and the command this binary was started as.

/** A single quote: ASCII ', or U+2018 to U+201B, which PowerShell also reads as one. */
const isQuote = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return c === "'" || (code >= 0x2018 && code <= 0x201b);
};

/**
 * A word for a printed command: bare when plain, else in single quotes. Null when it holds a single quote, which
 * bash and PowerShell quote differently (the probarion CLI's shellQuote refuses such a value the same way).
 */
export function shellWord(value: string): string | null {
  if ([...value].some(isQuote)) return null;
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value}'`;
}

/** Backslashes to slashes on Windows, where Node and near-cli-rs read both and a JSON config needs no escape. */
export function shown(file: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? file.replaceAll("\\", "/") : file;
}

/** A flag or a plain word, as an unknown argument may be echoed: at most 34 characters, with no `:` or `=`. */
const ECHOABLE = /^-{0,2}[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * An unknown argument as a usage error names it. Only a flag or a plain word is echoed, and of `--name=value` or
 * `NAME=value` only the name and `=...`. Anything else, such as a secret key pasted by mistake, is named by its
 * position alone: a secret key cut short is still enough to recover the whole key.
 */
export function argumentShown(arg: string, position: number): string {
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  if (ECHOABLE.test(name)) return JSON.stringify(eq === -1 ? name : `${name}=...`);
  return `${position} (not shown: it is not a flag or a word, and could be a key)`;
}

/**
 * The command a person runs this binary as, for the commands it prints: `probarion-mcp` once it is installed from
 * npm, the npx line when npx runs it, and `node` with the script's path otherwise, as from a clone of the
 * repository. `script` is process.argv[1].
 */
export function invokedAs(
  script: string | undefined,
  version: string,
  platform: NodeJS.Platform,
): string {
  if (script === undefined || script === "") return "probarion-mcp";
  const file = shown(script, platform);
  if (/(^|\/)probarion-mcp(\.cmd|\.ps1|\.exe)?$/i.test(file)) return "probarion-mcp";
  if (file.includes("/_npx/")) return `npx -y @probarion/mcp@${version}`;
  if (file.includes("/node_modules/@probarion/mcp/")) return "probarion-mcp";
  // A colon (C:/...) needs no quotes in bash, PowerShell or cmd.
  return `node ${/^[A-Za-z0-9_./:-]+$/.test(file) ? file : (shellWord(file) ?? file)}`;
}
