import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkDocs,
  checkManifest,
  checkRelease,
  checkServerJson,
  checkTarball,
  entryPointState,
  expectedTarballName,
  exportTargets,
  inspectTarballs,
  loadRelease,
  main,
  type PackageInfo,
  PUBLISHED_DIRS,
  packedMcpNames,
  parseCliArgs,
  pnpmPackInvocation,
  REPOSITORY_URL,
  readTarball,
  SERVER_JSON,
  SERVER_SCHEMA,
  takeTarball,
} from "../release-check.js";

const pkgs = (version: string): PackageInfo[] => [
  { dir: "packages/core", name: "@probarion/core", version, private: false },
  { dir: "packages/sdk", name: "@probarion/sdk", version, private: false },
  { dir: "packages/cli", name: "probarion", version, private: false },
];
const changelog = "# Changelog\n\n## 0.1.0 - 2026-11-07\n\n### Added\n- first release\n";

describe("checkRelease", () => {
  it("accepts a consistent release", () => {
    expect(
      checkRelease({ tag: "sdk-v0.1.0", packages: pkgs("0.1.0"), changelog, cliVersion: "0.1.0" }),
    ).toEqual([]);
  });

  it("rejects a tag that is not sdk-v<semver>", () => {
    expect(
      checkRelease({ tag: "v0.1.0", packages: pkgs("0.1.0"), changelog, cliVersion: "0.1.0" })[0],
    ).toContain("sdk-v");
  });

  it("takes the whole tag, not a prefix of it", () => {
    for (const tag of [
      "sdk-v0.1.0+build",
      "sdk-v0.1.0 ",
      "sdk-v0.1.0-",
      "sdk-v0.1",
      "xsdk-v0.1.0",
    ]) {
      const problems = checkRelease({
        tag,
        packages: pkgs("0.1.0"),
        changelog,
        cliVersion: "0.1.0",
      });
      expect(problems[0], tag).toContain("does not match sdk-v<semver>");
    }
  });

  it("lists every mismatch", () => {
    const problems = checkRelease({
      tag: "sdk-v0.2.0",
      packages: [
        ...pkgs("0.1.0"),
        { dir: "packages/mcp", name: "@probarion/mcp", version: "0.2.0", private: true },
      ],
      changelog,
      cliVersion: "0.1.0",
    });
    expect(problems.join("\n")).toContain("@probarion/core is 0.1.0");
    expect(problems.join("\n")).toContain("private");
    expect(problems.join("\n")).toContain("version.ts");
    expect(problems.join("\n")).toContain('no "## 0.2.0" section');
  });

  it("accepts a bracketed changelog heading and a prerelease tag", () => {
    const pre = "# Changelog\n\n## [0.2.0-rc.1] - 2026-11-20\n";
    expect(
      checkRelease({
        tag: "sdk-v0.2.0-rc.1",
        packages: pkgs("0.2.0-rc.1"),
        changelog: pre,
        cliVersion: "0.2.0-rc.1",
      }),
    ).toEqual([]);
  });

  it("does not take 0.1.0 as a prefix of 0.1.01 or 0.1.0.1 in the changelog", () => {
    for (const heading of ["## 0.1.01 - x", "## 0.1.0.1 - x", "## 10.1.0 - x", "# 0.1.0"]) {
      const problems = checkRelease({
        tag: "sdk-v0.1.0",
        packages: pkgs("0.1.0"),
        changelog: `# Changelog\n\n${heading}\n`,
        cliVersion: "0.1.0",
      });
      expect(problems.join("\n")).toContain('no "## 0.1.0" section');
    }
  });

  it("requires @probarion/core and skips the cli version when there is no version.ts", () => {
    const problems = checkRelease({
      tag: "sdk-v0.1.0",
      packages: pkgs("0.1.0").filter((p) => p.name !== "@probarion/core"),
      changelog,
      cliVersion: null,
    });
    expect(problems).toEqual(["@probarion/core is missing"]);
  });

  it("publishes in dependency order, mcp last", () => {
    expect([...PUBLISHED_DIRS]).toEqual([
      "packages/near",
      "packages/core",
      "packages/sdk",
      "packages/cli",
      "packages/mcp",
    ]);
  });
});

describe("parseCliArgs", () => {
  it("takes the tag from the argument, ignoring the -- that pnpm may pass on", () => {
    expect(parseCliArgs(["--", "sdk-v0.1.0"], {})).toEqual({
      tag: "sdk-v0.1.0",
      pack: false,
      out: undefined,
    });
  });

  it("falls back to GITHUB_REF_NAME, and an empty one counts as unset", () => {
    expect(parseCliArgs([], { GITHUB_REF_NAME: "sdk-v0.1.0" }).tag).toBe("sdk-v0.1.0");
    expect(parseCliArgs([], { GITHUB_REF_NAME: "" }).tag).toBe("");
  });

  it("reads --pack and --out", () => {
    expect(parseCliArgs(["--pack", "--out", "/tmp/x", "sdk-v0.1.0"], {})).toEqual({
      tag: "sdk-v0.1.0",
      pack: true,
      out: "/tmp/x",
    });
  });

  it("refuses an unknown flag or a second tag", () => {
    expect(() => parseCliArgs(["--publish", "sdk-v0.1.0"], {})).toThrow();
    expect(() => parseCliArgs(["sdk-v0.1.0", "sdk-v0.1.1"], {})).toThrow(/one tag/);
  });
});

// ---------- manifests ----------

const goodManifest = () => ({
  name: "@probarion/sdk",
  version: "0.1.0",
  license: "MIT",
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
    "./testing": {
      types: "./dist/testing/index.d.ts",
      import: "./dist/testing/index.js",
      default: "./dist/testing/index.js",
    },
  },
  files: ["dist", "README.md"],
  scripts: { prepublishOnly: 'node -e "process.exit(1)"' },
  repository: { type: "git", url: REPOSITORY_URL, directory: "packages/sdk" },
  publishConfig: { access: "public" },
});

describe("checkManifest", () => {
  it("accepts a manifest with main, types, full conditions, files and public access", () => {
    expect(checkManifest(goodManifest())).toEqual([]);
    expect(checkManifest(goodManifest(), "packages/sdk")).toEqual([]);
  });

  it("asks for this repository and the package's own directory, which provenance compares", () => {
    const wrongUrl = {
      ...goodManifest(),
      repository: { ...goodManifest().repository, url: "git+https://github.com/someone/else.git" },
    };
    expect(checkManifest(wrongUrl).join("\n")).toContain(
      `repository.url must be ${REPOSITORY_URL}`,
    );
    const wrongDir = {
      ...goodManifest(),
      repository: { ...goodManifest().repository, directory: "packages/core" },
    };
    expect(checkManifest(wrongDir, "packages/sdk").join("\n")).toContain(
      "repository.directory must be packages/sdk",
    );
    // Without a directory to compare with, only the url is checked.
    expect(checkManifest(wrongDir)).toEqual([]);
    const { repository: _r, ...none } = goodManifest();
    expect(checkManifest(none, "packages/sdk")).toHaveLength(2);
  });

  it("asks for a prepublishOnly script, so that a local publish is refused", () => {
    const { scripts: _s, ...none } = goodManifest();
    expect(checkManifest(none).join("\n")).toContain("prepublishOnly");
  });

  it("asks for main and types at the top level", () => {
    const { main: _m, types: _t, ...rest } = goodManifest();
    const problems = checkManifest(rest).join("\n");
    expect(problems).toContain('"main"');
    expect(problems).toContain('"types"');
  });

  it('asks for the "default" condition and for "types" first', () => {
    const noDefault = goodManifest();
    noDefault.exports["./testing"] = {
      types: "./dist/testing/index.d.ts",
      import: "./dist/testing/index.js",
    } as never;
    expect(checkManifest(noDefault).join("\n")).toContain('"./testing"');
    expect(checkManifest(noDefault).join("\n")).toContain("default");

    const typesLast = goodManifest();
    typesLast.exports["."] = {
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    };
    expect(checkManifest(typesLast).join("\n")).toContain('"types" must come first');
  });

  it("asks for dist and README.md in files, and public access", () => {
    const m = goodManifest();
    m.files = ["dist"];
    m.publishConfig = { access: "restricted" } as never;
    const problems = checkManifest(m).join("\n");
    expect(problems).toContain("README.md");
    expect(problems).toContain("access");
  });
});

// ---------- tarballs ----------

/** A ustar header + body per file; the second form uses the prefix field, the third a PAX path. */
function tarEntry(
  path: string,
  body: string,
  how: "name" | "prefix" | "pax" | "gnu" = "name",
): Buffer {
  const data = Buffer.from(body);
  const chunks: Buffer[] = [];
  const header = (name: string, size: number, type: string, prefix = ""): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.write(prefix, 345, "utf8");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return h;
  };
  const padded = (b: Buffer): Buffer => {
    const out = Buffer.alloc(Math.ceil(b.length / 512) * 512);
    b.copy(out);
    return out;
  };
  if (how === "prefix") {
    const cut = path.lastIndexOf("/");
    chunks.push(header(path.slice(cut + 1), data.length, "0", path.slice(0, cut)));
  } else if (how === "pax") {
    const record = (key: string, value: string): string => {
      const rest = ` ${key}=${value}\n`;
      let len = rest.length + 1;
      while (`${len}${rest}`.length !== len) len = `${len}${rest}`.length;
      return `${len}${rest}`;
    };
    const pax = Buffer.from(record("path", path));
    chunks.push(header("PaxHeader", pax.length, "x"), padded(pax));
    chunks.push(header("short", data.length, "0"));
  } else if (how === "gnu") {
    const long = Buffer.from(`${path}\0`);
    chunks.push(header("././@LongLink", long.length, "L"), padded(long));
    chunks.push(header("short", data.length, "0"));
  } else {
    chunks.push(header(path, data.length, "0"));
  }
  chunks.push(padded(data));
  return Buffer.concat(chunks);
}

function tarball(files: Record<string, string>, how: "name" | "prefix" | "pax" | "gnu" = "name") {
  const entries = Object.entries(files).map(([path, body]) => tarEntry(path, body, how));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("readTarball", () => {
  it("lists regular files without the package/ prefix, with their contents", () => {
    const files = readTarball(
      tarball({ "package/package.json": '{"name":"x"}', "package/dist/index.js": "export {};\n" }),
    );
    expect([...files.keys()].sort()).toEqual(["dist/index.js", "package.json"]);
    expect(text(files.get("dist/index.js"))).toBe("export {};\n");
  });

  it("reads a name split over the ustar prefix field, a PAX path and a GNU long name", () => {
    const long = `package/dist/${"deeper/".repeat(20)}file.js`;
    for (const how of ["prefix", "pax", "gnu"] as const) {
      const files = readTarball(tarball({ [long]: "x" }, how));
      expect([...files.keys()]).toEqual([long.slice("package/".length)]);
      expect(text(files.get(long.slice("package/".length)))).toBe("x");
    }
  });

  it("refuses something that is not a gzip tarball", () => {
    expect(() => readTarball(Buffer.from("not a tarball"))).toThrow();
  });
});

const sdkTarball = (over: Record<string, string | null> = {}): Map<string, Uint8Array> => {
  const manifest = {
    ...goodManifest(),
    dependencies: { "@probarion/core": "0.1.0", "near-api-js": "^7.4.0" },
  };
  const base: Record<string, string> = {
    "package.json": JSON.stringify(manifest),
    "README.md": "# sdk\n",
    LICENSE: "MIT License\n",
    "dist/index.js": "export {};\n",
    "dist/index.d.ts": "export {};\n",
    "dist/testing/index.js": "export {};\n",
    "dist/testing/index.d.ts": "export {};\n",
  };
  for (const [path, body] of Object.entries(over)) {
    if (body === null) delete base[path];
    else base[path] = body;
  }
  return new Map(Object.entries(base).map(([p, b]) => [p, new TextEncoder().encode(b)]));
};

const sdkInfo: PackageInfo = {
  dir: "packages/sdk",
  name: "@probarion/sdk",
  version: "0.1.0",
  private: false,
};
const internal = new Map([
  ["@probarion/core", "0.1.0"],
  ["@probarion/sdk", "0.1.0"],
]);

describe("checkTarball", () => {
  it("accepts a complete tarball", () => {
    expect(checkTarball({ info: sdkInfo, files: sdkTarball(), internal })).toEqual([]);
  });

  it("fails when the ./testing export points at a file that was not packed", () => {
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "dist/testing/index.js": null, "dist/testing/index.d.ts": null }),
      internal,
    });
    expect(problems.join("\n")).toContain("dist/testing/index.js");
    expect(problems.join("\n")).toContain("exports");
    expect(problems.join("\n")).toContain("not in the tarball");
  });

  it("fails when main or types is missing from the tarball", () => {
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "dist/index.js": null, "dist/index.d.ts": null }),
      internal,
    }).join("\n");
    expect(problems).toContain("main");
    expect(problems).toContain('"types"');
  });

  it("checks the bin target and its shebang", () => {
    const manifest = {
      ...goodManifest(),
      name: "probarion",
      bin: { probarion: "./dist/bin.js" },
    };
    const files = sdkTarball({ "package.json": JSON.stringify(manifest) });
    const info = { ...sdkInfo, name: "probarion", dir: "packages/cli" };
    expect(checkTarball({ info, files, internal }).join("\n")).toContain("dist/bin.js");
    const noShebang = sdkTarball({
      "package.json": JSON.stringify(manifest),
      "dist/bin.js": "console.log(1);\n",
    });
    expect(checkTarball({ info, files: noShebang, internal }).join("\n")).toContain("#!");
    const ok = sdkTarball({
      "package.json": JSON.stringify(manifest),
      "dist/bin.js": "#!/usr/bin/env node\nconsole.log(1);\n",
    });
    expect(checkTarball({ info, files: ok, internal })).toEqual([]);
  });

  it("matches a wildcard export against the packed files, and ignores a null (blocked) one", () => {
    const manifest = {
      ...goodManifest(),
      exports: {
        ".": goodManifest().exports["."],
        "./testing": goodManifest().exports["./testing"],
        "./dist/*": { types: "./dist/*.d.ts", import: "./dist/*.js", default: "./dist/*.js" },
        "./internal/*": null,
      },
    };
    const files = sdkTarball({ "package.json": JSON.stringify(manifest) });
    expect(checkTarball({ info: sdkInfo, files, internal })).toEqual([]);
    const none = sdkTarball({
      "package.json": JSON.stringify({
        ...manifest,
        exports: { ...manifest.exports, "./nothing/*": "./nothing/*.js" },
      }),
    });
    expect(checkTarball({ info: sdkInfo, files: none, internal }).join("\n")).toContain(
      "./nothing/*.js",
    );
  });

  it("refuses source maps, which would point at a src/ that is not shipped", () => {
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "dist/index.js.map": "{}", "dist/index.d.ts.map": "{}" }),
      internal,
    }).join("\n");
    expect(problems).toContain("source map");
    expect(problems).toContain("dist/index.js.map");
  });

  it("refuses server.json: the MCP registry entry is read from the repository, not the tarball", () => {
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "server.json": "{}" }),
      internal,
    });
    expect(problems).toEqual(["@probarion/sdk: unexpected file in the tarball: server.json"]);
  });

  it("allows only dist/, README.md, LICENSE and package.json", () => {
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "src/index.ts": "x", ".env": "SECRET=1", "test/a.test.ts": "x" }),
      internal,
    }).join("\n");
    for (const path of ["src/index.ts", ".env", "test/a.test.ts"]) expect(problems).toContain(path);
  });

  it("needs README.md and LICENSE", () => {
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "README.md": null, LICENSE: null }),
      internal,
    }).join("\n");
    expect(problems).toContain("README.md");
    expect(problems).toContain("LICENSE");
  });

  it("fails on a workspace: or link: specifier that pnpm pack left in the manifest", () => {
    const manifest = {
      ...goodManifest(),
      dependencies: { "@probarion/core": "workspace:*", other: "link:../other" },
    };
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "package.json": JSON.stringify(manifest) }),
      internal,
    }).join("\n");
    expect(problems).toContain("workspace:*");
    expect(problems).toContain("link:../other");
  });

  it("fails on a workspace: specifier for a package that is not part of the release", () => {
    const manifest = { ...goodManifest(), dependencies: { "some-tool": "workspace:^" } };
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "package.json": JSON.stringify(manifest) }),
      internal,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"workspace:^"');
  });

  it("fails when the packed dependency on a sibling is another version than this release", () => {
    for (const [spec, bad] of [
      ["0.1.0", false],
      ["^0.1.0", false],
      ["0.0.9", true],
      ["^0.2.0", true],
      [">=0.1.0", true],
    ] as const) {
      const manifest = { ...goodManifest(), dependencies: { "@probarion/core": spec } };
      const problems = checkTarball({
        info: sdkInfo,
        files: sdkTarball({ "package.json": JSON.stringify(manifest) }),
        internal,
      });
      expect(problems.length > 0, spec).toBe(bad);
    }
  });

  it("fails when the tarball's own name or version is not the one released", () => {
    const manifest = { ...goodManifest(), version: "0.0.9" };
    const problems = checkTarball({
      info: sdkInfo,
      files: sdkTarball({ "package.json": JSON.stringify(manifest) }),
      internal,
    }).join("\n");
    expect(problems).toContain("0.0.9");
  });

  it("needs the packed mcpName to be server.json's name, when one is asked for", () => {
    const mcpInfo: PackageInfo = { ...sdkInfo, dir: "packages/mcp", name: "@probarion/mcp" };
    const packed = (extra: object) =>
      sdkTarball({
        "package.json": JSON.stringify({ ...goodManifest(), name: "@probarion/mcp", ...extra }),
      });
    const mcpName = "io.github.acme/acme";
    expect(checkTarball({ info: mcpInfo, files: packed({ mcpName }), internal, mcpName })).toEqual(
      [],
    );
    expect(checkTarball({ info: mcpInfo, files: packed({}), internal, mcpName })).toEqual([
      '@probarion/mcp: the tarball\'s package.json has no "mcpName", which the MCP registry reads from npm before it lists "io.github.acme/acme"',
    ]);
    expect(
      checkTarball({
        info: mcpInfo,
        files: packed({ mcpName: "io.github.acme/other" }),
        internal,
        mcpName,
      }),
    ).toEqual([
      '@probarion/mcp: the tarball\'s package.json has "mcpName" "io.github.acme/other", but packages/mcp/server.json names "io.github.acme/acme"; the MCP registry compares the two',
    ]);
    // Without an expected name (no server.json) the field is not asked for.
    expect(checkTarball({ info: mcpInfo, files: packed({}), internal })).toEqual([]);
  });

  it("fails when package.json is missing or not JSON", () => {
    expect(
      checkTarball({ info: sdkInfo, files: sdkTarball({ "package.json": null }), internal }).join(
        "\n",
      ),
    ).toContain("package.json");
    expect(
      checkTarball({
        info: sdkInfo,
        files: sdkTarball({ "package.json": "{not json" }),
        internal,
      }).join("\n"),
    ).toContain("package.json");
  });
});

describe("exportTargets", () => {
  it("collects every string leaf, through nested conditions and arrays, and skips null", () => {
    expect(
      exportTargets({
        ".": { types: "./a.d.ts", node: { import: "./a.js", default: ["./b.js", "./c.js"] } },
        "./x": null,
        "./y": "./y.js",
      }),
    ).toEqual(["./a.d.ts", "./a.js", "./b.js", "./c.js", "./y.js"]);
    expect(exportTargets("./index.js")).toEqual(["./index.js"]);
    expect(exportTargets(undefined)).toEqual([]);
  });
});

describe("expectedTarballName", () => {
  it("names a scoped and an unscoped package the way pnpm pack does", () => {
    expect(expectedTarballName("@probarion/core", "0.1.0")).toBe("probarion-core-0.1.0.tgz");
    expect(expectedTarballName("probarion", "0.1.0")).toBe("probarion-0.1.0.tgz");
  });
});

// ---------- a fixture repository ----------

let root: string;

function writeRepo(files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  }
}

const DIRS: Record<string, string> = {
  "@probarion/core": "packages/core",
  "@probarion/sdk": "packages/sdk",
  probarion: "packages/cli",
};
const manifestOf = (name: string, version: string, extra: object = {}) =>
  JSON.stringify({
    ...goodManifest(),
    name,
    version,
    repository: { type: "git", url: REPOSITORY_URL, directory: DIRS[name] },
    ...extra,
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-check-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadRelease", () => {
  it("reads the published packages that exist, the changelog and the cli version", async () => {
    writeRepo({
      "packages/core/package.json": manifestOf("@probarion/core", "0.1.0"),
      "packages/sdk/package.json": manifestOf("@probarion/sdk", "0.1.0"),
      "packages/cli/package.json": manifestOf("probarion", "0.1.0", { private: true }),
      "packages/cli/src/version.ts": 'export const CLI_VERSION = "0.1.0";\n',
      "CHANGELOG.md": changelog,
    });
    const release = await loadRelease(root);
    expect(release.packages).toEqual([
      { dir: "packages/core", name: "@probarion/core", version: "0.1.0", private: false },
      { dir: "packages/sdk", name: "@probarion/sdk", version: "0.1.0", private: false },
      { dir: "packages/cli", name: "probarion", version: "0.1.0", private: true },
    ]);
    expect(release.cliVersion).toBe("0.1.0");
    expect(release.changelog).toBe(changelog);
    expect(release.manifests.get("packages/sdk")?.name).toBe("@probarion/sdk");
  });

  it("reports a problem, not a skipped check, when version.ts has no CLI_VERSION", async () => {
    writeRepo({
      "packages/core/package.json": manifestOf("@probarion/core", "0.1.0"),
      "packages/cli/package.json": manifestOf("probarion", "0.1.0"),
      "packages/cli/src/version.ts": "export const OTHER = 1;\n",
      "CHANGELOG.md": changelog,
    });
    const release = await loadRelease(root);
    expect(release.cliVersion).toBeNull();
    expect(release.cliVersionProblem).toContain("no CLI_VERSION");
  });

  it("has no cli version problem when version.ts is absent or holds the version", async () => {
    writeRepo({
      "packages/core/package.json": manifestOf("@probarion/core", "0.1.0"),
      "CHANGELOG.md": changelog,
    });
    expect((await loadRelease(root)).cliVersionProblem).toBeNull();
    writeRepo({ "packages/cli/src/version.ts": 'export const CLI_VERSION = "0.1.0";\n' });
    expect((await loadRelease(root)).cliVersionProblem).toBeNull();
  });
});

describe("inspectTarballs", () => {
  const sdkInfo2 = sdkInfo;
  const coreInfo: PackageInfo = {
    dir: "packages/core",
    name: "@probarion/core",
    version: "0.1.0",
    private: false,
  };

  function writeTarballs(over: Record<string, Buffer | null> = {}): void {
    const core = JSON.stringify({
      ...goodManifest(),
      name: "@probarion/core",
      exports: { ".": goodManifest().exports["."] },
    });
    const sdk = JSON.stringify({
      ...goodManifest(),
      dependencies: { "@probarion/core": "0.1.0" },
    });
    const body = (manifest: string) => ({
      "package/package.json": manifest,
      "package/README.md": "# r\n",
      "package/LICENSE": "MIT\n",
      "package/dist/index.js": "export {};\n",
      "package/dist/index.d.ts": "export {};\n",
      "package/dist/testing/index.js": "export {};\n",
      "package/dist/testing/index.d.ts": "export {};\n",
    });
    const entries: Record<string, Buffer | null> = {
      "probarion-core-0.1.0.tgz": tarball(body(core)),
      "probarion-sdk-0.1.0.tgz": tarball(body(sdk)),
      ...over,
    };
    mkdirSync(root, { recursive: true });
    for (const [name, data] of Object.entries(entries)) {
      if (data !== null) writeFileSync(join(root, name), data);
    }
  }

  it("checks every tarball and returns the publish list in order", () => {
    writeTarballs();
    const result = inspectTarballs([coreInfo, sdkInfo2], root);
    expect(result.problems).toEqual([]);
    expect(result.entries).toEqual([
      { name: "@probarion/core", version: "0.1.0", file: "probarion-core-0.1.0.tgz" },
      { name: "@probarion/sdk", version: "0.1.0", file: "probarion-sdk-0.1.0.tgz" },
    ]);
  });

  it("says which package has the bad export, and which tarball is missing", () => {
    const sdk = JSON.stringify({ ...goodManifest(), dependencies: {} });
    writeTarballs({
      "probarion-sdk-0.1.0.tgz": tarball({
        "package/package.json": sdk,
        "package/README.md": "r",
        "package/LICENSE": "m",
        "package/dist/index.js": "x",
        "package/dist/index.d.ts": "x",
      }),
      "probarion-core-0.1.0.tgz": null,
    });
    const problems = inspectTarballs([coreInfo, sdkInfo2], root).problems.join("\n");
    expect(problems).toContain("@probarion/core: probarion-core-0.1.0.tgz was not produced");
    expect(problems).toContain("@probarion/sdk");
    expect(problems).toContain("dist/testing/index.js");
  });

  it("asks a package for the mcpName it is given, and no other package", () => {
    writeTarballs();
    const mcpNames = new Map([["@probarion/sdk", "io.github.acme/acme"]]);
    expect(inspectTarballs([coreInfo, sdkInfo2], root, mcpNames).problems).toEqual([
      '@probarion/sdk: the tarball\'s package.json has no "mcpName", which the MCP registry reads from npm before it lists "io.github.acme/acme"',
    ]);
  });
});

describe("packedMcpNames", () => {
  const manifests = new Map([["packages/mcp", { name: "@probarion/mcp" }]]);

  it("asks the mcp package for server.json's name", () => {
    expect(
      packedMcpNames({ manifests, serverJson: { parsed: { name: "io.github.acme/acme" } } }),
    ).toEqual(new Map([["@probarion/mcp", "io.github.acme/acme"]]));
  });

  it("asks for nothing without server.json, a valid one or a string name, or without packages/mcp", () => {
    expect(packedMcpNames({ manifests, serverJson: null }).size).toBe(0);
    expect(packedMcpNames({ manifests, serverJson: { invalid: "x" } }).size).toBe(0);
    expect(packedMcpNames({ manifests, serverJson: { parsed: { name: 7 } } }).size).toBe(0);
    expect(
      packedMcpNames({ manifests: new Map(), serverJson: { parsed: { name: "io.github.a/b" } } })
        .size,
    ).toBe(0);
  });
});

// ---------- the MCP registry entry ----------

const mcpManifest = { name: "@probarion/mcp", version: "0.1.1", mcpName: "io.github.acme/acme" };
const goodServer = () => ({
  $schema: SERVER_SCHEMA,
  name: "io.github.acme/acme",
  description: "Pay under a mandate.",
  version: "0.1.1",
  packages: [
    {
      registryType: "npm",
      identifier: "@probarion/mcp",
      version: "0.1.1",
      transport: { type: "stdio" },
    },
  ],
});

describe("checkServerJson", () => {
  it("accepts an entry that names the package, its mcpName and the tag's version", () => {
    expect(checkServerJson(goodServer(), mcpManifest, "0.1.1")).toEqual([]);
  });

  it("names the 2025-12-11 registry schema", () => {
    expect(SERVER_SCHEMA).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(SERVER_JSON).toBe("packages/mcp/server.json");
  });

  it("refuses an entry left at the last release's version, at the top or on its package", () => {
    expect(checkServerJson(goodServer(), mcpManifest, "0.1.2")).toEqual([
      'version is "0.1.1", the tag says 0.1.2',
      `the npm package's version is "0.1.1", the tag says 0.1.2`,
    ]);
  });

  it("refuses a name that is not the package's mcpName, and a package without one", () => {
    const other = { ...goodServer(), name: "io.github.acme/other" };
    expect(checkServerJson(other, mcpManifest, "0.1.1")).toEqual([
      'name is "io.github.acme/other", but the "mcpName" of @probarion/mcp is "io.github.acme/acme"',
    ]);
    const { mcpName: _dropped, ...noMcpName } = mcpManifest;
    expect(checkServerJson(goodServer(), noMcpName, "0.1.1")).toEqual([
      '@probarion/mcp has no "mcpName" in package.json, which the registry checks',
    ]);
  });

  it("refuses a description over the registry's 100 characters, or none", () => {
    const long = { ...goodServer(), description: "x".repeat(101) };
    expect(checkServerJson(long, mcpManifest, "0.1.1").join(" | ")).toContain("101 characters");
    const atLimit = { ...goodServer(), description: "x".repeat(100) };
    expect(checkServerJson(atLimit, mcpManifest, "0.1.1")).toEqual([]);
    const { description: _gone, ...none } = goodServer();
    expect(checkServerJson(none, mcpManifest, "0.1.1").join(" | ")).toContain("missing");
  });

  it("refuses another schema, another package and no npm package", () => {
    expect(checkServerJson({ ...goodServer(), $schema: "x" }, mcpManifest, "0.1.1")).toEqual([
      `$schema must be ${SERVER_SCHEMA}`,
    ]);
    const server = goodServer();
    const [pkg] = server.packages;
    const renamed = { ...server, packages: [{ ...pkg, identifier: "@probarion/sdk" }] };
    expect(checkServerJson(renamed, mcpManifest, "0.1.1")).toEqual([
      'the npm package is "@probarion/sdk", expected "@probarion/mcp"',
    ]);
    const none = { ...server, packages: [{ ...pkg, registryType: "pypi" }] };
    expect(checkServerJson(none, mcpManifest, "0.1.1")).toEqual([
      "packages must hold one npm package, it holds 0",
    ]);
    expect(checkServerJson([], mcpManifest, "0.1.1")).toEqual(["is not a JSON object"]);
  });
});

describe("checkDocs", () => {
  it("flags every TODO(release) note and nothing else", () => {
    const docs = new Map([
      ["CHANGELOG.md", "# Changelog\n\n## 0.1.0 - x\n<!-- TODO(release): set the date -->\n"],
      ["packages/cli/README.md", "# cli\nA TODO(release) line\n\nand a normal TODO\n"],
      ["packages/core/README.md", "# core\n"],
    ]);
    const problems = checkDocs(docs);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("CHANGELOG.md");
    expect(problems[0]).toContain("set the date");
    expect(problems[1]).toContain("packages/cli/README.md");
  });
});

describe("loadRelease docs", () => {
  it("reads the changelog and the README of every published package", async () => {
    writeRepo({
      "packages/core/package.json": manifestOf("@probarion/core", "0.1.0"),
      "packages/core/README.md": "# core\n",
      "packages/sdk/package.json": manifestOf("@probarion/sdk", "0.1.0"),
      "CHANGELOG.md": changelog,
    });
    const { docs } = await loadRelease(root);
    expect([...docs.keys()].sort()).toEqual(["CHANGELOG.md", "packages/core/README.md"]);
  });
});

describe("main", () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const coreManifest = (version: string) =>
    manifestOf("@probarion/core", version, { exports: { ".": goodManifest().exports["."] } });
  const sdkManifest = (version: string) =>
    manifestOf("@probarion/sdk", version, { dependencies: { "@probarion/core": version } });

  function writeCleanRepo(version = "0.1.0"): void {
    writeRepo({
      "packages/core/package.json": coreManifest(version),
      "packages/core/README.md": "# core\n",
      "packages/sdk/package.json": sdkManifest(version),
      "packages/sdk/README.md": "# sdk\n",
      "CHANGELOG.md": `# Changelog\n\n## ${version} - 2026-11-07\n`,
    });
  }

  const packedBody = (manifest: string): Record<string, string> => ({
    "package/package.json": manifest,
    "package/README.md": "# r\n",
    "package/LICENSE": "MIT\n",
    "package/dist/index.js": "export {};\n",
    "package/dist/index.d.ts": "export {};\n",
    "package/dist/testing/index.js": "export {};\n",
    "package/dist/testing/index.d.ts": "export {};\n",
  });

  /** What `pnpm pack` would have produced for the fixture packages, one tarball per package. */
  function writeFakeTarballs(dir: string, over: Record<string, Buffer> = {}): void {
    mkdirSync(dir, { recursive: true });
    const files: Record<string, Buffer> = {
      "probarion-core-0.1.0.tgz": tarball(packedBody(coreManifest("0.1.0"))),
      "probarion-sdk-0.1.0.tgz": tarball(packedBody(sdkManifest("0.1.0"))),
      ...over,
    };
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  }

  /** A stand-in for pnpm's entry point: `pack --pack-destination DIR` copies the prepared tarball of the package in cwd. */
  function fakePnpm(): string {
    const script = join(root, "fake-bin", "pnpm.cjs");
    mkdirSync(join(root, "fake-bin"), { recursive: true });
    writeFileSync(
      script,
      [
        'const fs = require("node:fs"); const path = require("node:path");',
        'if (process.argv[2] !== "pack") process.exit(3);',
        'const dest = process.argv[process.argv.indexOf("--pack-destination") + 1];',
        'const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));',
        'const file = pkg.name.replace(/^@/, "").replace("/", "-") + "-" + pkg.version + ".tgz";',
        "fs.copyFileSync(path.join(process.env.FAKE_TARBALLS, file), path.join(dest, file));",
      ].join("\n"),
    );
    return script;
  }

  it("passes on a consistent repository", async () => {
    writeCleanRepo();
    expect(await main(["sdk-v0.1.0"], {}, root)).toBe(0);
    expect(stdout.join("")).toBe("release check ok: @probarion/core@0.1.0, @probarion/sdk@0.1.0\n");
  });

  it("fails with every problem on stderr: tag, changelog, manifest shape and open release notes", async () => {
    writeCleanRepo();
    writeRepo({
      "packages/sdk/package.json": JSON.stringify({ name: "@probarion/sdk", version: "0.1.0" }),
      "packages/core/README.md": "# core\n<!-- TODO(release): fix -->\n",
    });
    expect(await main(["sdk-v0.2.0"], {}, root)).toBe(1);
    const err = stderr.join("");
    expect(err).toContain("@probarion/core is 0.1.0, the tag says 0.2.0");
    expect(err).toContain('no "## 0.2.0" section');
    expect(err).toContain('@probarion/sdk: "main" is missing');
    expect(err).toContain("packages/core/README.md still has an open release note");
  });

  it("fails the run when version.ts exists but holds no CLI_VERSION", async () => {
    writeCleanRepo();
    writeRepo({
      "packages/cli/package.json": manifestOf("probarion", "0.1.0"),
      "packages/cli/README.md": "# cli\n",
      "packages/cli/src/version.ts": "export const OTHER = 1;\n",
    });
    expect(await main(["sdk-v0.1.0"], {}, root)).toBe(1);
    expect(stderr.join("")).toContain("no CLI_VERSION");
  });

  it("checks packages/mcp/server.json against the tag and the package's mcpName", async () => {
    writeCleanRepo();
    const mcp = manifestOf("@probarion/mcp", "0.1.0", {
      mcpName: "io.github.acme/acme",
      repository: { type: "git", url: REPOSITORY_URL, directory: "packages/mcp" },
    });
    writeRepo({
      "packages/mcp/package.json": mcp,
      "packages/mcp/README.md": "# mcp\n",
      "packages/mcp/server.json": JSON.stringify({
        ...goodServer(),
        version: "0.1.0",
        packages: [{ ...goodServer().packages[0], version: "0.1.0" }],
      }),
    });
    expect(await main(["sdk-v0.1.0"], {}, root)).toBe(0);
    writeRepo({ "packages/mcp/server.json": JSON.stringify(goodServer()) });
    expect(await main(["sdk-v0.1.0"], {}, root)).toBe(1);
    expect(stderr.join("")).toContain(
      'packages/mcp/server.json: version is "0.1.1", the tag says 0.1.0',
    );
    writeRepo({ "packages/mcp/server.json": "{ not json" });
    expect(await main(["sdk-v0.1.0"], {}, root)).toBe(1);
    expect(stderr.join("")).toContain("packages/mcp/server.json is not valid JSON");
  });

  it("refuses bad arguments with exit code 2", async () => {
    writeCleanRepo();
    expect(await main(["--nope"], {}, root)).toBe(2);
    expect(stderr.join("")).toContain("usage:");
  });

  it("packs every package, inspects the tarballs and writes the publish list", async () => {
    writeCleanRepo();
    const prepared = join(root, "prepared");
    writeFakeTarballs(prepared);
    const out = join(root, "out");
    const env = { npm_execpath: fakePnpm(), FAKE_TARBALLS: prepared };
    expect(await main(["--pack", "--out", out, "sdk-v0.1.0"], env, root)).toBe(0);
    expect(stdout.join("")).toContain("2 tarballs checked in");
    const list = JSON.parse(readFileSync(join(out, "packages.json"), "utf8")) as {
      tag: string;
      packages: { name: string; file: string }[];
    };
    expect(list.tag).toBe("sdk-v0.1.0");
    expect(list.packages.map((p) => p.file)).toEqual([
      "probarion-core-0.1.0.tgz",
      "probarion-sdk-0.1.0.tgz",
    ]);
  });

  it("leaves no publish list behind when a packed export is missing", async () => {
    writeCleanRepo();
    const prepared = join(root, "prepared");
    const withoutTesting = packedBody(sdkManifest("0.1.0"));
    delete withoutTesting["package/dist/testing/index.js"];
    delete withoutTesting["package/dist/testing/index.d.ts"];
    writeFakeTarballs(prepared, { "probarion-sdk-0.1.0.tgz": tarball(withoutTesting) });
    const out = join(root, "out");
    // A publish list from an earlier, good run must not survive a bad one.
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "packages.json"), "{}");
    const env = { npm_execpath: fakePnpm(), FAKE_TARBALLS: prepared };
    expect(await main(["--pack", "--out", out, "sdk-v0.1.0"], env, root)).toBe(1);
    expect(stderr.join("")).toContain(
      'exports "./testing" → ./dist/testing/index.js is not in the tarball',
    );
    expect(existsSync(join(out, "packages.json"))).toBe(false);
  });

  it("under --pack, refuses an mcp tarball whose package.json lost the mcpName server.json names", async () => {
    writeCleanRepo();
    const mcpManifestAt = (extra: object) =>
      manifestOf("@probarion/mcp", "0.1.0", {
        repository: { type: "git", url: REPOSITORY_URL, directory: "packages/mcp" },
        ...extra,
      });
    writeRepo({
      "packages/mcp/package.json": mcpManifestAt({ mcpName: "io.github.acme/acme" }),
      "packages/mcp/README.md": "# mcp\n",
      "packages/mcp/server.json": JSON.stringify({
        ...goodServer(),
        version: "0.1.0",
        packages: [{ ...goodServer().packages[0], version: "0.1.0" }],
      }),
    });
    const prepared = join(root, "prepared");
    const out = join(root, "out");
    const env = { npm_execpath: fakePnpm(), FAKE_TARBALLS: prepared };
    // The repository's manifest has the field; the packed one does not.
    writeFakeTarballs(prepared, {
      "probarion-mcp-0.1.0.tgz": tarball(packedBody(mcpManifestAt({}))),
    });
    expect(await main(["--pack", "--out", out, "sdk-v0.1.0"], env, root)).toBe(1);
    expect(stderr.join("")).toContain(
      '@probarion/mcp: the tarball\'s package.json has no "mcpName", which the MCP registry reads from npm before it lists "io.github.acme/acme"',
    );
    expect(existsSync(join(out, "packages.json"))).toBe(false);
    writeFakeTarballs(prepared, {
      "probarion-mcp-0.1.0.tgz": tarball(
        packedBody(mcpManifestAt({ mcpName: "io.github.acme/acme" })),
      ),
    });
    expect(await main(["--pack", "--out", out, "sdk-v0.1.0"], env, root)).toBe(0);
    expect(stdout.join("")).toContain("3 tarballs checked in");
  });

  it("reports a failing pnpm pack", async () => {
    writeCleanRepo();
    const script = join(root, "fake-bin", "pnpm.cjs");
    mkdirSync(join(root, "fake-bin"), { recursive: true });
    writeFileSync(script, "process.exit(7);\n");
    const code = await main(
      ["--pack", "--out", join(root, "out"), "sdk-v0.1.0"],
      { npm_execpath: script },
      root,
    );
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("@probarion/core: pnpm pack failed");
  });
});

describe("pnpmPackInvocation", () => {
  const out = join(tmpdir(), "a folder with spaces & more");

  it("starts pnpm's own entry point under node when run through pnpm: no shell, one argument per word", () => {
    const run = pnpmPackInvocation({ npm_execpath: "/x/pnpm/bin/pnpm.cjs" }, out, "win32");
    expect(run).toEqual({
      command: process.execPath,
      args: ["/x/pnpm/bin/pnpm.cjs", "pack", "--pack-destination", resolve(out)],
      shell: false,
      inPlace: false,
    });
  });

  it("uses the constant shell command `pnpm pack` on Windows without pnpm's entry point, and no path in it", () => {
    for (const env of [
      {},
      { npm_execpath: "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" },
    ]) {
      const run = pnpmPackInvocation(env, out, "win32");
      expect(run.shell).toBe(true);
      // No argument list next to a shell (DEP0190), and nothing a shell could misread.
      expect(run.args).toEqual([]);
      expect(run.command).toBe("pnpm pack");
      expect(run.inPlace).toBe(true);
    }
  });

  it("does not take a file that merely has pnpm in its path for pnpm's entry point", () => {
    expect(pnpmPackInvocation({ npm_execpath: "/pnpm/bin/pnpm" }, out, "linux").command).toBe(
      "pnpm",
    );
    expect(pnpmPackInvocation({ npm_execpath: "/pnpm/bin/pnpmXjs" }, out, "linux").command).toBe(
      "pnpm",
    );
  });

  it("starts pnpm directly elsewhere", () => {
    const run = pnpmPackInvocation({ npm_execpath: "/usr/bin/npm-cli.js" }, out, "linux");
    expect(run).toEqual({
      command: "pnpm",
      args: ["pack", "--pack-destination", resolve(out)],
      shell: false,
      inPlace: false,
    });
  });
});

describe("takeTarball", () => {
  const info: PackageInfo = {
    dir: "packages/core",
    name: "@probarion/core",
    version: "0.1.0",
    private: false,
  };

  it("moves the tarball from the package directory to the out directory, spaces and all", () => {
    const pkgDir = join(root, "pkg with space");
    const outDir = join(root, "out dir");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(pkgDir, "probarion-core-0.1.0.tgz"), "tarball");
    expect(takeTarball(info, pkgDir, outDir)).toBeNull();
    expect(readFileSync(join(outDir, "probarion-core-0.1.0.tgz"), "utf8")).toBe("tarball");
    expect(existsSync(join(pkgDir, "probarion-core-0.1.0.tgz"))).toBe(false);
  });

  it("reports a tarball that pnpm did not write", () => {
    mkdirSync(join(root, "p"), { recursive: true });
    mkdirSync(join(root, "o"), { recursive: true });
    expect(takeTarball(info, join(root, "p"), join(root, "o"))).toContain(
      "did not write probarion-core-0.1.0.tgz",
    );
  });
});

describe("entryPointState", () => {
  const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const here = join(scriptsDir, "release-check.ts");
  const url = pathToFileURL(here).href;

  it("is main when started as this file, however the path is spelled", () => {
    expect(entryPointState(here, url, "linux")).toBe("main");
    expect(entryPointState(join(scriptsDir, "test", "..", "release-check.ts"), url, "linux")).toBe(
      "main",
    );
    // Windows paths differ in case only.
    expect(entryPointState(here.toUpperCase(), url, "win32")).toBe("main");
  });

  it("is imported when another program started the process", () => {
    expect(
      entryPointState(join(scriptsDir, "node_modules", "vitest", "vitest.mjs"), url, "linux"),
    ).toBe("imported");
    expect(entryPointState(undefined, url, "linux")).toBe("imported");
  });

  it("is a mismatch, not a quiet success, when a release-check script that is not this file was started", () => {
    expect(entryPointState(join(tmpdir(), "elsewhere", "release-check.ts"), url, "linux")).toBe(
      "mismatch",
    );
    expect(entryPointState(join(tmpdir(), "elsewhere", "release-check.mjs"), url, "linux")).toBe(
      "mismatch",
    );
  });
});
