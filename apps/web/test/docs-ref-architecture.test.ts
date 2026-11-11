import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ARCH_GROUP_LABELS,
  ARCH_TEXT,
  ARCHITECTURE,
  type ArchEdge,
  type Architecture,
  edgeLine,
  layoutProblems,
} from "@/lib/docs/architecture";
import { mdxToMarkdown } from "@/lib/docs/markdown";
import { ROOT, readMdx, WEB, walkFiles } from "./docs-helpers";

// The architecture page (/docs/operate/architecture), pinned to the code. The diagram's data lives in
// lib/docs/architecture.ts; everything below that names the code reads the code itself (the
// workspace folders, vercel.json, the API folders, the vault's cross-contract interfaces and its
// caller checks, the factory's owner methods and deployment record, the migrations, the app's
// settings and its server-side signers, read from the TypeScript syntax tree), both ways where the
// page names a list: a part added to or taken from the code fails this test until the diagram and
// the page follow, and so does a page that still names a part the code no longer has.

const PAGE = "operate/architecture";
const MDX = readMdx(PAGE);
const TWIN = mdxToMarkdown(MDX, { file: `${PAGE}.mdx`, origin: "https://probarion.xyz" });
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const named = (name: string) => MDX.includes(`\`${name}\``);
const byId = new Map(ARCHITECTURE.nodes.map((n) => [n.id, n]));
const key = (e: ArchEdge) => `${e.from}>${e.to}`;

/** The page's H2 sections by heading text; "" is the text before the first H2. */
function h2Sections(src: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = "";
  let body: string[] = [];
  for (const line of src.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    if (m) {
      out.set(name, body.join("\n"));
      name = (m[1] ?? "").trim();
      body = [];
    } else body.push(line);
  }
  out.set(name, body.join("\n"));
  return out;
}

const SECTIONS = h2Sections(MDX);

// --- the diagram ----------------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where an arrow's label is drawn: centred on the arrow's midpoint, its baseline 6 above it. */
function labelRect(e: ArchEdge): Rect {
  const l = edgeLine(ARCHITECTURE, e);
  const w = e.label.length * ARCH_TEXT.detail.perChar;
  const baseline = l.my - 6;
  return {
    x: l.mx - w / 2,
    y: baseline - ARCH_TEXT.detail.size + 1,
    w,
    h: ARCH_TEXT.detail.size + 2,
  };
}

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The paper halo the CSS strokes round an arrow label (4px wide), on each side. */
const HALO = 2;

/**
 * The room an arrow label takes: its text, ARCH_TEXT.detail.perChar per character and
 * ARCH_TEXT.detail.size high, centred on the arrow's midpoint 6 above it (mx, my - 6), grown by the
 * halo on every side and by half a character on the left and the right. Two labels whose rooms do
 * not meet keep at least one character of space between them, so they never read as one.
 */
function labelRoom(arch: Architecture, e: ArchEdge): Rect {
  const l = edgeLine(arch, e);
  const w = e.label.length * ARCH_TEXT.detail.perChar + ARCH_TEXT.detail.perChar + 2 * HALO;
  const h = ARCH_TEXT.detail.size + 2 * HALO;
  return { x: l.mx - w / 2, y: l.my - 6 - h / 2, w, h };
}

/** Each arrow label whose room meets another label's room or a box. */
function crowdedLabels(arch: Architecture): string[] {
  const out: string[] = [];
  for (const [i, e] of arch.edges.entries()) {
    const r = labelRoom(arch, e);
    for (const n of arch.nodes)
      if (overlap(r, n)) out.push(`"${e.label}" touches the box "${n.id}"`);
    for (const other of arch.edges.slice(i + 1)) {
      if (overlap(r, labelRoom(arch, other))) {
        out.push(`"${e.label}" and "${other.label}" run into each other`);
      }
    }
  }
  return out;
}

/** True when the arrow's line passes through the inside of `r`. */
function lineThrough(e: ArchEdge, r: Rect): boolean {
  const l = edgeLine(ARCHITECTURE, e);
  for (let s = 0; s <= 400; s++) {
    const x = l.x1 + ((l.x2 - l.x1) * s) / 400;
    const y = l.y1 + ((l.y2 - l.y1) * s) / 400;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

/** True when two arrows cross each other between their ends. */
function cross(a: ArchEdge, b: ArchEdge): boolean {
  const p = edgeLine(ARCHITECTURE, a);
  const q = edgeLine(ARCHITECTURE, b);
  const side = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) =>
    Math.sign((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1));
  const d1 = side(q.x1, q.y1, q.x2, q.y2, p.x1, p.y1);
  const d2 = side(q.x1, q.y1, q.x2, q.y2, p.x2, p.y2);
  const d3 = side(p.x1, p.y1, p.x2, p.y2, q.x1, q.y1);
  const d4 = side(p.x1, p.y1, p.x2, p.y2, q.x2, q.y2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

describe("the architecture diagram", () => {
  it("passes the layout rules: arrows name boxes, boxes fit and do not overlap, text fits", () => {
    expect(layoutProblems(ARCHITECTURE)).toEqual([]);
  });

  it("names a repository path that exists for every box", () => {
    for (const n of ARCHITECTURE.nodes) {
      expect(existsSync(join(ROOT, n.source)), `${n.id}: ${n.source}`).toBe(true);
    }
  });

  it("gives every box its own label and every group at least one box", () => {
    const labels = ARCHITECTURE.nodes.map((n) => n.label);
    expect(new Set(labels).size, "a label is repeated").toBe(labels.length);
    for (const g of Object.keys(ARCH_GROUP_LABELS)) {
      expect(
        ARCHITECTURE.nodes.some((n) => n.group === g),
        g,
      ).toBe(true);
    }
    const pairs = ARCHITECTURE.edges.map((e) => [e.from, e.to].sort().join("|"));
    expect(new Set(pairs).size, "two arrows join the same two boxes").toBe(pairs.length);
  });

  it("draws each arrow label in the open: inside the frame, off every box and every other label", () => {
    const problems: string[] = [];
    const frame: Rect = { x: 0, y: 0, w: ARCHITECTURE.width, h: ARCHITECTURE.height };
    for (const e of ARCHITECTURE.edges) {
      const r = labelRect(e);
      if (r.x < frame.x || r.y < frame.y || r.x + r.w > frame.w || r.y + r.h > frame.h) {
        problems.push(`"${e.label}" leaves the frame`);
      }
      for (const n of ARCHITECTURE.nodes) {
        if (overlap(r, n)) problems.push(`"${e.label}" sits on the box "${n.id}"`);
      }
      for (const other of ARCHITECTURE.edges) {
        if (other === e) continue;
        if (overlap(r, labelRect(other)) && key(e) < key(other)) {
          problems.push(`"${e.label}" and "${other.label}" overlap`);
        }
        if (lineThrough(other, r))
          problems.push(`the arrow ${key(other)} runs through "${e.label}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("leaves a character of space between two arrow labels, and the halo's room next to a box", () => {
    expect(crowdedLabels(ARCHITECTURE)).toEqual([]);
    // The layout this check was written for: USDC and NEAR Intents on the agent's row put "ft_transfer"
    // on the line of "spend, anchor", 7 units after it, which the plain overlap test above lets pass.
    const move: Readonly<Record<string, { x: number; y: number }>> = {
      usdc: { x: 195, y: 392 },
      intents: { x: 375, y: 392 },
    };
    const before: Architecture = {
      ...ARCHITECTURE,
      nodes: ARCHITECTURE.nodes.map((n) => ({ ...n, ...move[n.id] })),
    };
    expect(crowdedLabels(before)).toEqual([
      '"spend, anchor" and "ft_transfer" run into each other',
    ]);
  });

  it("draws no arrow through a box it does not join, and no two arrows that cross", () => {
    const problems: string[] = [];
    for (const [i, e] of ARCHITECTURE.edges.entries()) {
      for (const n of ARCHITECTURE.nodes) {
        if (n.id !== e.from && n.id !== e.to && lineThrough(e, n)) {
          problems.push(`${key(e)} runs through "${n.id}"`);
        }
      }
      for (const other of ARCHITECTURE.edges.slice(i + 1)) {
        if (cross(e, other)) problems.push(`${key(e)} crosses ${key(other)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// --- the arrows, each backed by the code that makes it --------------------------------------------

/** For each arrow, the files and the code in them that show it happens. */
const EVIDENCE: Readonly<Record<string, readonly (readonly [string, RegExp])[]>> = {
  "owner>wallet": [
    ["packages/cli/src/owner-tx.ts", /SIGNS: probarion never signs owner or approver transactions/],
    ["contracts/vault/src/mandates.rs", /env::predecessor_account_id\(\) != self\.owner/],
  ],
  "approver>wallet": [
    [
      "contracts/vault/src/held.rs",
      /self\.approvers\.contains\(&env::predecessor_account_id\(\)\)/,
    ],
  ],
  "console>wallet": [["apps/web/src/lib/near/send.ts", /wallet\.signAndSendTransaction\(/]],
  "wallet>factory": [
    ["apps/web/src/lib/near/tx.ts", /"create_vault"/],
    ["contracts/factory/src/lib.rs", /pub fn create_vault\(/],
  ],
  "wallet>vault": [["apps/web/src/lib/near/send.ts", /receiverId/]],
  "factory>vault": [
    [
      "contracts/factory/src/lib.rs",
      /create_account\(\)\.transfer\(deposit\)[\s\S]*?use_global_contract[\s\S]*?deploy_contract[\s\S]*?"new"/,
    ],
  ],
  "agent>vault": [
    ["packages/sdk/src/vault-client.ts", /methodName: "spend"[\s\S]*methodName: "anchor"/],
  ],
  "agent>nearai": [
    ["packages/sdk/src/nearai.ts", /\/chat\/completions/],
    ["packages/core/src/constants.ts", /NEARAI_BASE_URL = "https:\/\/cloud-api\.near\.ai\/v1"/],
  ],
  "vault>usdc": [
    ["contracts/vault/src/ext.rs", /fn ft_transfer\(/],
    ["contracts/vault/src/spend.rs", /ext_ft::ext\(self\.usdc\.clone\(\)\)/],
  ],
  "vault>intents": [
    ["contracts/vault/src/ext.rs", /fn ft_withdraw\(/],
    ["contracts/vault/src/spend.rs", /ext_intents::ext\(self\.intents\.clone\(\)\)/],
  ],
  "console>vault": [
    ["apps/web/src/app/api/console/[vault]/invoices/route.ts", /makePayablesProbarion\(/],
    ["apps/web/src/lib/payables/probarion.ts", /makeTenantProbarion\(/],
    ["apps/web/src/lib/payables/pipeline.ts", /loadActiveSecretFor\([\s\S]*?mandate\.agent_pk/],
  ],
  "console>database": [
    ["apps/web/src/lib/keys/service.ts", /sealAgentSecret\(/],
    ["apps/web/src/lib/ledger/store.ts", /rpc\("ledger_append"/],
  ],
  "watcher>vault": [["apps/web/src/lib/watcher/watch.ts", /reader\.listSpends\(/]],
  "watcher>database": [["apps/web/src/lib/watcher/watch.ts", /rpc<[^>]*>\("vault_event_insert"/]],
  "watcher>alerts": [
    ["apps/web/src/app/api/cron/watch/route.ts", /runAlerts\(/],
    ["apps/web/src/lib/alerts/telegram.ts", /https:\/\/api\.telegram\.org\/bot/],
    ["apps/web/src/lib/alerts/email.ts", /from "resend"/],
  ],
};

describe("the arrows", () => {
  it("are each backed by code, and no evidence is left for an arrow that is gone", () => {
    expect(ARCHITECTURE.edges.map(key).sort()).toEqual(Object.keys(EVIDENCE).sort());
    const problems: string[] = [];
    for (const [edge, list] of Object.entries(EVIDENCE)) {
      for (const [file, pattern] of list) {
        if (!existsSync(join(ROOT, file))) problems.push(`${edge}: no ${file}`);
        else if (!pattern.test(read(file))) problems.push(`${edge}: ${file} lacks ${pattern}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("show every contract the vault calls: its cross-contract interfaces are USDC and Intents only", () => {
    const ext = read("contracts/vault/src/ext.rs");
    const TRAIT_NODE: Readonly<Record<string, string>> = { ext_ft: "usdc", ext_intents: "intents" };
    const traits = [...ext.matchAll(/#\[ext_contract\((\w+)\)\]/g)].map((m) => m[1] ?? "");
    expect(traits.sort()).toEqual(Object.keys(TRAIT_NODE).sort());
    for (const node of Object.values(TRAIT_NODE)) {
      expect(
        ARCHITECTURE.edges.some((e) => e.from === "vault" && e.to === node),
        node,
      ).toBe(true);
    }
    // Every method the vault can call on another contract is named on the page.
    for (const m of ext.matchAll(/\bfn (\w+)\s*\(/g)) expect(named(m[1] ?? ""), m[1]).toBe(true);
    // No other file of the vault declares a contract interface or calls a contract by name.
    const vaultSrc = join(ROOT, "contracts", "vault", "src");
    for (const f of walkFiles(vaultSrc, ".rs").filter((x) => !x.endsWith("ext.rs"))) {
      const src = readFileSync(f, "utf8");
      expect(/#\[ext_contract|\.function_call\(/.test(src), f).toBe(false);
    }
  });

  it("show a factory that adds no key to the vaults it creates", () => {
    expect(read("contracts/factory/src/lib.rs")).not.toMatch(/add_(?:full_)?access_key/);
  });
});

// --- the page --------------------------------------------------------------------------------------

/** The tables the migrations create and do not drop. */
function liveTables(): string[] {
  const dir = join(WEB, "supabase", "migrations");
  const sql = walkFiles(dir, ".sql")
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const created = [...sql.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map(
    (m) => m[1] ?? "",
  );
  const dropped = new Set(
    [...sql.matchAll(/drop table (?:if exists )?public\.(\w+)/gi)].map((m) => m[1] ?? ""),
  );
  return created.filter((t) => !dropped.has(t));
}

describe("the architecture page", () => {
  it("answers first, then draws the diagram, then one section per group, and ends with what it does not do", () => {
    const h2 = [...SECTIONS.keys()].filter((k) => k !== "");
    const groups = Object.values(ARCH_GROUP_LABELS);
    expect(h2.filter((h) => groups.includes(h))).toEqual(groups);
    expect(h2.at(-1)).toBe("What this does not do");
    const intro = SECTIONS.get("") ?? "";
    expect(intro).toContain("<ArchitectureDiagram />");
    expect(intro.indexOf("<ArchitectureDiagram />")).toBeGreaterThan(0);
  });

  it("names every box, with its source path, in the section of its group", () => {
    const problems: string[] = [];
    for (const n of ARCHITECTURE.nodes) {
      const section = SECTIONS.get(ARCH_GROUP_LABELS[n.group]) ?? "";
      if (!section.includes(`**${n.label}**`)) problems.push(`${n.id}: no **${n.label}**`);
      if (!section.includes(`\`${n.source}\``)) problems.push(`${n.id}: no \`${n.source}\``);
    }
    expect(problems).toEqual([]);
  });

  it("puts every box and every arrow in its Markdown twin", () => {
    for (const n of ARCHITECTURE.nodes) expect(TWIN, n.id).toContain(`**${n.label}**`);
    for (const e of ARCHITECTURE.edges) {
      const from = byId.get(e.from)?.label ?? e.from;
      const to = byId.get(e.to)?.label ?? e.to;
      expect(TWIN, key(e)).toContain(`${from} → ${to}: ${e.label}`);
    }
  });

  it("names every package, app and contract folder of the repository, and only folders that exist", () => {
    const folders = ["apps", "packages", "contracts"].flatMap((top) =>
      readdirSync(join(ROOT, top), { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            ["package.json", "Cargo.toml"].some((m) => existsSync(join(ROOT, top, d.name, m))),
        )
        .map((d) => `${top}/${d.name}`),
    );
    expect(folders.length).toBeGreaterThan(5);
    for (const f of folders) expect(named(f), f).toBe(true);
    for (const m of MDX.matchAll(/`((?:apps|packages|contracts)\/[^`\s]+)`/g)) {
      expect(existsSync(join(ROOT, m[1] ?? "")), m[1]).toBe(true);
    }
  });

  it("names every scheduled job in vercel.json, and no scheduled job that is not there", () => {
    const vercel = JSON.parse(read("apps/web/vercel.json")) as { crons?: { path: string }[] };
    const crons = (vercel.crons ?? []).map((c) => c.path);
    expect(crons.length).toBeGreaterThan(0);
    for (const path of crons) expect(named(path), path).toBe(true);
    const onPage = [...MDX.matchAll(/`(\/api\/cron\/[^`\s]+)`/g)].map((m) => m[1] ?? "");
    expect(onPage.length).toBeGreaterThan(0);
    for (const path of onPage) expect(crons, path).toContain(path);
  });

  it("names every folder of API routes, and only API paths that are folders of routes", () => {
    const api = join(WEB, "src", "app", "api");
    const folders = readdirSync(api, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `/api/${d.name}`);
    expect(folders.length).toBeGreaterThan(0);
    for (const f of folders) expect(named(f), f).toBe(true);
    const onPage = [...MDX.matchAll(/`(\/api\/[^`\s]*)`/g)].map((m) => m[1] ?? "");
    expect(onPage.length).toBeGreaterThan(folders.length - 1);
    const problems: string[] = [];
    for (const path of onPage) {
      const dir = join(api, ...path.replace(/^\/api\//, "").split("/"));
      if (!existsSync(dir) || !statSync(dir).isDirectory()) problems.push(path);
      else if (!walkFiles(dir, ".ts").some((f) => /[\\/]route\.ts$/.test(f))) {
        problems.push(`${path} has no route.ts`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("names every table the migrations leave in the database, and lists no table that is not there", () => {
    const tables = new Set(liveTables());
    expect(tables.size).toBeGreaterThan(0);
    for (const t of tables) expect(named(t), t).toBe(true);
    // The Database bullet's list of tables: its sub-bullets, up to the next top-level bullet.
    const lines = (SECTIONS.get("Hosted app") ?? "").split("\n");
    const start = lines.findIndex((l) => l.startsWith("- **Database**"));
    expect(start, "no Database bullet").toBeGreaterThan(-1);
    const listed: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith("- ")) break;
      if (!line.startsWith("  - ")) continue;
      for (const m of line.matchAll(/`([^`]+)`/g)) listed.push(m[1] ?? "");
    }
    expect(listed.length).toBeGreaterThan(0);
    for (const t of listed) expect(tables.has(t), t).toBe(true);
    expect([...new Set(listed)].sort()).toEqual([...tables].sort());
  });
});

// --- who signs each call that changes a contract ---------------------------------------------------

/** The bodies of a contract file's `#[near] impl X { ... }` blocks: the methods a transaction can call. */
function nearImpls(src: string): string[] {
  return [...src.matchAll(/^#\[near\]\r?\nimpl \w+ \{\r?\n([\s\S]*?)^\}/gm)].map((m) => m[1] ?? "");
}

/**
 * Each method a transaction can call that takes `&mut self` and is neither `#[private]` (a callback) nor
 * `#[init]`, with the caller check its body starts with: "owner", "approver" or "other".
 */
function changingMethods(files: readonly string[]): { name: string; check: string }[] {
  const out: { name: string; check: string }[] = [];
  for (const f of files) {
    const src = nearImpls(readFileSync(f, "utf8")).join("\n");
    for (const m of src.matchAll(
      /((?:#\[[^\]]*\]\s*)*)pub fn (\w+)\(\s*&mut self[^{]*\{\s*([^\n]*)/g,
    )) {
      const attrs = m[1] ?? "";
      if (/#\[(?:private|init)\]/.test(attrs)) continue;
      const first = m[3] ?? "";
      const check = first.startsWith("self.assert_owner()")
        ? "owner"
        : first.startsWith("self.assert_approver()")
          ? "approver"
          : "other";
      out.push({ name: m[2] ?? "", check });
    }
  }
  return out;
}

/** The text of the one `<Callout kind="...">` block of this kind on the page. */
function callout(kind: string): string {
  const found = [
    ...MDX.matchAll(new RegExp(`<Callout kind="${kind}">([\\s\\S]*?)</Callout>`, "g")),
  ];
  expect(found.length, kind).toBe(1);
  return found[0]?.[1] ?? "";
}

/** The top-level bullet of a section that starts with `- **<label>**`. */
function bullet(section: string, label: string): string {
  const text = SECTIONS.get(section) ?? "";
  const line = text.split("\n").find((l) => l.startsWith(`- **${label}**`));
  expect(line, `${section}: ${label}`).toBeDefined();
  return line ?? "";
}

describe("who signs", () => {
  it("names the signer of every vault method that changes state", () => {
    const files = walkFiles(join(ROOT, "contracts", "vault", "src"), ".rs");
    const methods = changingMethods(files);
    expect(methods.length).toBeGreaterThan(10);
    const checks = new Set(methods.map((m) => m.check));
    expect(
      checks.has("owner") && checks.has("approver") && checks.has("other"),
      [...checks].join(),
    ).toBe(true);
    const owner = callout("owner-signs");
    const approver = callout("approver-signs");
    const has = (src: string, name: string) => src.includes(`\`${name}\``);
    const problems: string[] = [];
    for (const { name, check } of methods) {
      if (check === "owner" && !has(owner, name))
        problems.push(`${name}: not in the owner-signs callout`);
      if (check === "approver" && !has(approver, name)) {
        problems.push(`${name}: not in the approver-signs callout`);
      }
      if (check !== "owner" && has(owner, name))
        problems.push(`${name}: in the owner-signs callout`);
      if (check !== "approver" && has(approver, name)) {
        problems.push(`${name}: in the approver-signs callout`);
      }
      if (check === "other" && !named(name)) problems.push(`${name}: not on the page`);
    }
    // And the page's intro names who may call each method with no owner or approver check.
    const intro = SECTIONS.get("") ?? "";
    for (const { name, check } of methods) {
      if (check === "other" && !intro.includes(`\`${name}\``))
        problems.push(`${name}: not in the intro`);
    }
    expect(problems).toEqual([]);
  });

  it("names the factory's owner and every factory method that changes state", () => {
    const methods = changingMethods([join(ROOT, "contracts", "factory", "src", "lib.rs")]);
    expect(methods.some((m) => m.check === "owner")).toBe(true);
    const factory = bullet("On NEAR", "Factory");
    const owner = callout("owner-signs");
    for (const { name, check } of methods) {
      expect(factory, name).toContain(`\`${name}\``);
      // The owner-signs callout is the vault owner's: the factory owner's methods are not in it.
      if (check === "owner") expect(owner, name).not.toContain(`\`${name}\``);
    }
    const record = JSON.parse(read("contracts/deployments/testnet.json")) as {
      factory: { owner: string };
    };
    expect(factory).toContain(`\`${record.factory.owner}\``);
    const last = SECTIONS.get("What this does not do") ?? "";
    expect(last).toContain(`\`${record.factory.owner}\``);
  });
});

// --- the outside services and the keys the hosted app holds ----------------------------------------

/**
 * Every setting of the hosted app (the `Env` interface in apps/web/src/lib/env.ts), with the word
 * the page names it by, or null for a setting that wires no part of its own. A new setting fails
 * this test: if it switches on a new service, the page names that service.
 */
const SETTINGS: Readonly<Record<string, string | null>> = {
  defaultNetwork: null, // which network an address that matches no origin serves
  enabledNetworks: null, // the networks served, which the page states in prose
  networks: "NEAR RPC providers", // each network's origin, RPC lists, factory and vault ids
  NEARAI_API_KEY: "NEARAI_API_KEY",
  NEARAI_MODEL: null, // the model id passed to NEAR AI Cloud; unset means the SDK's default
  ONECLICK_JWT: "ONECLICK_JWT",
  TESTNET_FAUCET_KEY: "TESTNET_FAUCET_KEY",
  SUPABASE_URL: "Supabase",
  SUPABASE_SERVICE_ROLE_KEY: "service role key",
  NEXT_PUBLIC_SUPABASE_URL: "Supabase",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "publishable key",
  KEY_ENCRYPTION_SECRET: "KEY_ENCRYPTION_SECRET",
  SENTRY_DSN: "SENTRY_DSN",
  TELEGRAM_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",
  RESEND_API_KEY: "RESEND_API_KEY",
  BASE_RPC_URL: null, // read and checked at start, and no code reads it yet
  CRON_SECRET: "CRON_SECRET",
  CANARY_MODE: "Canary",
  BETTERSTACK_HEARTBEAT_URL: "BETTERSTACK_HEARTBEAT_URL",
};

/** The app's own source files, without its tests. */
const APP_FILES = [
  ...walkFiles(join(WEB, "src"), ".ts"),
  ...walkFiles(join(WEB, "src"), ".tsx"),
].filter((f) => !/\.test\.tsx?$/.test(f));

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

/** The local names (or `ns.Name`) by which a file imports `name` from a module matching `from`. */
function importedAs(sf: ts.SourceFile, name: string, from: RegExp): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!from.test(st.moduleSpecifier.text)) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements)
        if ((el.propertyName ?? el.name).text === name) out.add(el.name.text);
    }
    if (nb && ts.isNamespaceImport(nb)) out.add(`${nb.name.text}.${name}`);
  }
  return out;
}

/** The source text of a property of an object literal; "(spread)" when a spread could hide it. */
function propText(obj: ts.ObjectLiteralExpression, name: string, sf: ts.SourceFile): string | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === name) return p.initializer.getText(sf);
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return name;
  }
  return obj.properties.some(ts.isSpreadAssignment) ? "(spread)" : null;
}

const SDK = /^@probarion\/sdk(?:\/|$)/;

/**
 * Every server-side signer the app builds, read from the syntax tree, so a string or a comment that looks like
 * code does not count and a renamed import does: each `new NearApiJsSender(...)` with its `accountId`, and each
 * `new Probarion(...)` given an agent or a ledger key with its `vault` (the SDK builds that sender itself).
 */
function serverSigners(): { senders: string[]; probarions: string[] } {
  const senders: string[] = [];
  const probarions: string[] = [];
  for (const f of APP_FILES) {
    if (!/NearApiJsSender|Probarion/.test(readFileSync(f, "utf8"))) continue;
    const sf = parse(f);
    const senderNames = importedAs(sf, "NearApiJsSender", SDK);
    const probarionNames = importedAs(sf, "Probarion", SDK);
    const at = relative(WEB, f);
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) {
        const callee = n.expression.getText(sf);
        const arg = n.arguments?.[0];
        const obj = arg && ts.isObjectLiteralExpression(arg) ? arg : null;
        if (senderNames.has(callee)) {
          senders.push(
            obj ? (propText(obj, "accountId", sf) ?? `${at}: no accountId`) : `${at}: computed`,
          );
        }
        if (probarionNames.has(callee)) {
          if (!obj) probarions.push(`${at}: computed`);
          else {
            const signs = ["agentKey", "ledgerKey"].some((k) => propText(obj, k, sf) !== null);
            if (signs) probarions.push(propText(obj, "vault", sf) ?? `${at}: no vault`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { senders, probarions };
}

describe("the hosted app's settings and keys", () => {
  it("name every outside service a setting switches on, know every setting, and name no setting that is gone", () => {
    const src = read("apps/web/src/lib/env.ts");
    const body = /export interface Env \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    const keys = [...body.matchAll(/^ {2}([A-Za-z_]\w*)\??:/gm)].map((m) => m[1] ?? "");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.sort()).toEqual(Object.keys(SETTINGS).sort());
    for (const [k, word] of Object.entries(SETTINGS)) {
      if (word !== null) expect(MDX, `${k}: ${word}`).toContain(word);
    }
    const onPage = [...MDX.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1] ?? "");
    expect(onPage.length).toBeGreaterThan(0);
    for (const k of onPage) expect(keys, k).toContain(k);
  });

  it("sign on the server only as a vault, with its own sealed keys, or as the testnet faucet", () => {
    const { senders, probarions } = serverSigners();
    expect(senders.length).toBeGreaterThan(0);
    // lib/payables/probarion.ts builds the SDK's own senders for an upload (`o.tenant.vault_id`): the same tenant vault.
    expect([...new Set(senders)].sort()).toEqual([
      "FAUCET_SIGNER",
      "o.tenant.vault_id",
      "tenant.vault_id",
    ]);
    expect(probarions.length).toBeGreaterThan(0);
    for (const v of probarions) expect(["o.tenant.vault_id", "tenant.vault_id"], v).toContain(v);
    const faucet = read("apps/web/src/lib/topup/faucet.ts");
    expect(faucet).toMatch(/export const FAUCET_SIGNER = "probarion\.testnet";/);
    expect(faucet).toMatch(/methodName: "mint"/);
    expect(MDX).toContain("`probarion.testnet`");
  });

  it("import no transaction signer from near-api-js: only key and signature helpers", () => {
    // KeyPair makes and reads the sealed keys (lib/keys/service.ts); it signs no transaction there.
    const ALLOWED: Readonly<Record<string, string | null>> = {
      PublicKey: null,
      KeyPairString: null,
      verifyMessage: null,
      KeyPair: join("lib", "keys", "service.ts"),
    };
    const problems: string[] = [];
    for (const f of APP_FILES) {
      if (!/near-api-js|@near-js\//.test(readFileSync(f, "utf8"))) continue;
      const sf = parse(f);
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        if (!/^(?:near-api-js|@near-js\/)/.test(st.moduleSpecifier.text)) continue;
        const nb = st.importClause?.namedBindings;
        const names =
          nb && ts.isNamedImports(nb)
            ? nb.elements.map((el) => (el.propertyName ?? el.name).text)
            : ["(default or namespace import)"];
        for (const name of names) {
          const only = Object.hasOwn(ALLOWED, name) ? ALLOWED[name] : undefined;
          if (only === undefined || (only !== null && !f.endsWith(only))) {
            problems.push(`${relative(WEB, f)}: ${name}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("give the watcher, its alerts and the scheduled jobs no way to sign", () => {
    const files = [
      ...walkFiles(join(WEB, "src", "lib", "watcher"), ".ts"),
      ...walkFiles(join(WEB, "src", "lib", "alerts"), ".ts"),
      ...walkFiles(join(WEB, "src", "app", "api", "cron"), ".ts"),
    ].filter((f) => !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(3);
    const BAN =
      /NearApiJsSender|makeTenantProbarion|signAndSend|new Probarion\(|loadActiveSecret|near-api-js|@near-js\//;
    for (const f of files) expect(BAN.test(readFileSync(f, "utf8")), f).toBe(false);
  });

  it("says Payables waits for the owner when no attested model confirms the amount", () => {
    // The pipeline adds the owner-confirms rule to every cycle, and the owner's Confirm is a NEP-413 signature.
    expect(read("apps/web/src/lib/payables/pipeline.ts")).toMatch(/pb\.rules\.add\(owner\.rule\)/);
    expect(read("apps/web/src/lib/payables/owner-confirms.ts")).toMatch(
      /OWNER_CONFIRMS_RULE = "custom\.owner_confirms_without_model"/,
    );
    expect(read("apps/web/src/lib/payables/confirm.ts")).toMatch(/NEP-413/);
    const nearai = bullet("Other services", "NEAR AI Cloud");
    expect(nearai).toContain("Payables sends nothing on its own");
    expect(nearai).toContain("NEP-413");
    expect(nearai).toContain("`invoice_confirm_nonces`");
    expect(MDX).not.toMatch(/code rules alone/);
  });
});
