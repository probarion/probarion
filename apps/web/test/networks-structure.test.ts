// W-NET-R2, R4, R6: the rules about where a network may come from, held to the source. One deployment serves both networks,
// so a call site that reaches for "the" network (a setting, a build constant, a literal) would mix them. These checks read
// the files, as test/deploy.test.ts does.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PER_NETWORK_ENV_NAMES } from "@/lib/env";
import { isSourceFile, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");
const text = (...p: string[]) => readFileSync(join(...p), "utf8");
const posix = (f: string) => relative(WEB, f).replaceAll("\\", "/");

/** The app's own source: no test, no fixture. */
const sources = walk(SRC).filter(
  (f) => isSourceFile(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"),
);
const withText = sources.map((f) => ({ file: posix(f), src: readFileSync(f, "utf8") }));

describe("no source reads one network for the whole deployment", () => {
  it("never reads a single NEAR_NETWORK, a build-time network or a single-network setting", () => {
    const allowed = new Set([
      "src/lib/env.ts", // the default network, and the settings per network
      "src/lib/site/network.ts", // the same rule for next.config.ts and the browser
    ]);
    const banned = [
      /\bBUILD_NETWORK\b/,
      /\bNEXT_PUBLIC_NEAR_NETWORK\b/,
      /\.NEAR_NETWORK\b/,
      /\benv\.(NEAR_RPC_URLS|NEAR_ARCHIVAL_RPC_URLS|PROBARION_FACTORY_ID|PROBARION_VAULT_ID|CANARY_VAULT_ID|TEAM_VAULT_IDS)\b/,
    ];
    const found = withText
      .filter(({ file }) => !allowed.has(file))
      .flatMap(({ file, src }) =>
        banned.filter((re) => re.test(src)).map((re) => `${file}: ${re}`),
      );
    expect(found).toEqual([]);
  });

  it("never names a network by a literal when it builds a chain client or reads a vault", () => {
    const found = withText.flatMap(({ file, src }) =>
      [
        ...src.matchAll(
          /\b(getRpc|getReader|chainConsts|makeTenantProbarion|proofDeps|watcherDeps)\(\s*["'](mainnet|testnet)["']/g,
        ),
      ].map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it("only the request, a vault or a tenant names the network of a chain client", () => {
    // Every call passes a variable: the request's network, `member.network`, `tenant.network` or an argument.
    const found = withText
      .filter(({ file }) => file !== "src/lib/near/server.ts")
      .flatMap(({ file, src }) =>
        // (`req.body.getReader()` is the Web Streams one, hence the look-behind.)
        [...src.matchAll(/(?<![.\w])(getRpc|getReader|chainConsts)\(\s*\)/g)].map(
          (m) => `${file}: ${m[0]}`,
        ),
      );
    expect(found).toEqual([]);
  });
});

describe("the pages of a vault", () => {
  const pages = walk(join(SRC, "app", "console", "[vault]")).filter((f) =>
    /[\\/]page\.tsx$/.test(f),
  );

  it("find every page of a vault", () => {
    expect(pages.map(posix).sort()).toEqual([
      "src/app/console/[vault]/alerts/page.tsx",
      "src/app/console/[vault]/keys/page.tsx",
      "src/app/console/[vault]/mandates/page.tsx",
      "src/app/console/[vault]/page.tsx",
      "src/app/console/[vault]/payables/[id]/page.tsx",
      "src/app/console/[vault]/payables/page.tsx",
      "src/app/console/[vault]/topup/page.tsx",
    ]);
  });

  it.each(pages.map((f) => [posix(f), readFileSync(f, "utf8")]))(
    "%s shows the other-network card in place of itself, right after the guard",
    (_file, src) => {
      expect(src).toMatch(/const \{[^}]*\belsewhere\b[^}]*\} = await requireMember\(/);
      expect(src).toContain("if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;");
      // Nothing is read before the guard has answered: in the page itself, the card comes before the first read of
      // the chain or the database (a helper above the default export may read, but only the page calls it).
      const body = src.slice(src.indexOf("export default async function"));
      const card = body.indexOf("if (elsewhere)");
      expect(card).toBeGreaterThan(-1);
      for (const read of [
        "getReader(",
        "getRpc(",
        "serviceDb()",
        "loadOverview(",
        "chainConsts(",
      ]) {
        const first = body.indexOf(read);
        expect(first === -1 || card < first, `${read} in ${_file}`).toBe(true);
      }
    },
  );
});

/**
 * The exported functions of a file, each with its body in which every call of a function of the same file is replaced by
 * that function's body (to three levels), so an action that hands its work to a helper is read as one piece, in the order
 * it runs. A body runs from its declaration to the next top-level declaration, so a helper written after an export is not
 * taken for part of it.
 */
function exportedFunctions(src: string): { name: string; body: string }[] {
  const top = /^(?:export|function|async function|const|let|type|interface|class)\b/gm;
  const marks = [...src.matchAll(top)].map((m) => m.index ?? 0);
  const all = [...src.matchAll(/^(export )?(?:async )?function (\w+)/gm)].map((m) => {
    const from = m.index ?? 0;
    const to = marks.find((i) => i > from) ?? src.length;
    return { name: m[2] ?? "", exported: m[1] !== undefined, body: src.slice(from, to) };
  });
  const bodies = new Map(all.map((f) => [f.name, f.body]));
  const inline = (body: string, depth: number): string =>
    depth === 0
      ? body
      : body.replace(/(?<!function )\b(\w+)\(/g, (call, name: string) => {
          const helper = bodies.get(name);
          return helper === undefined ? call : `${call}${inline(helper, depth - 1)}`;
        });
  return all.filter((f) => f.exported).map((f) => ({ name: f.name, body: inline(f.body, 3) }));
}

describe("the routes and the actions of a vault", () => {
  const files = [
    ...walk(join(SRC, "app", "console", "[vault]")).filter((f) => /actions\.ts$/.test(f)),
    ...walk(join(SRC, "app", "api", "topup")).filter((f) => /route\.ts$/.test(f)),
    join(SRC, "app", "api", "console", "[vault]", "invoices", "route.ts"),
  ];
  const entries = files.flatMap((f) =>
    exportedFunctions(readFileSync(f, "utf8")).map((fn) => ({ file: posix(f), ...fn })),
  );

  it("finds every action and every handler (a new one must be added here, and is then held to the guard)", () => {
    expect(entries.map((e) => `${e.file}: ${e.name}`).sort()).toEqual([
      "src/app/api/console/[vault]/invoices/route.ts: POST",
      "src/app/api/topup/quote/route.ts: POST",
      "src/app/api/topup/status/route.ts: GET",
      "src/app/api/topup/submit/route.ts: POST",
      "src/app/console/[vault]/actions.ts: refreshMembersAction",
      "src/app/console/[vault]/actions.ts: updateSettingsAction",
      "src/app/console/[vault]/alerts/actions.ts: addEmailAction",
      "src/app/console/[vault]/alerts/actions.ts: connectTelegramAction",
      "src/app/console/[vault]/alerts/actions.ts: removeSubscriptionAction",
      "src/app/console/[vault]/keys/actions.ts: discardKeyAction",
      "src/app/console/[vault]/keys/actions.ts: generateKeyAction",
      "src/app/console/[vault]/keys/actions.ts: keepKeyAction",
      "src/app/console/[vault]/keys/actions.ts: syncKeysAction",
      "src/app/console/[vault]/mandates/actions.ts: checkPayeeAction",
      "src/app/console/[vault]/mandates/actions.ts: prepareMandateAction",
      "src/app/console/[vault]/payables/actions.ts: confirmInvoiceAction",
      "src/app/console/[vault]/payables/actions.ts: prepareConfirmAction",
      "src/app/console/[vault]/payables/actions.ts: rejectInvoiceAction",
      "src/app/console/[vault]/payables/actions.ts: setZeroRetentionAction",
      "src/app/console/[vault]/topup/actions.ts: prepareFundAction",
    ]);
  });

  it.each(entries.map((e) => [`${e.file}: ${e.name}`, e.body]))(
    "%s finds the member through the guard that checks the network, before anything is read or written",
    (name, body) => {
      const guard = body.search(/\bmemberFor(Action|Api)\(/);
      expect(guard, name).toBeGreaterThan(-1);
      // Never the session alone: that would let a vault of the other network through.
      expect(body, name).not.toMatch(/\bgetSession\(\)/);
      // Nothing is read from a chain or the database, and no outside call is made, before the guard has answered.
      for (const read of [
        "getReader(",
        "getRpc(",
        "serviceDb(",
        "chainConsts(",
        "fetch(",
        ".rpc(",
      ]) {
        const first = body.indexOf(read);
        expect(first === -1 || guard < first, `${read} before the guard in ${name}`).toBe(true);
      }
    },
  );
});

describe("the root layout", () => {
  const layout = text(SRC, "app", "layout.tsx");

  it("does not read the request, so the static pages stay static: the network comes from the browser", () => {
    expect(layout).not.toMatch(
      /next\/headers|\bheaders\(|\bcookies\(|requestNetwork|softRequestNetwork/,
    );
  });
});

describe("the documented settings", () => {
  const example = readFileSync(join(WEB, "..", "..", ".env.example"), "utf8");
  const runbook = readFileSync(join(WEB, "..", "..", "docs", "runbooks", "web-deploy.md"), "utf8");

  it("lists the mainnet and the testnet form of every per-network setting in .env.example and the runbook", () => {
    for (const name of PER_NETWORK_ENV_NAMES) {
      for (const suffix of ["MAINNET", "TESTNET"]) {
        expect(example, `${name}_${suffix}`).toMatch(new RegExp(`^${name}_${suffix}=`, "m"));
        expect(runbook, `${name}_${suffix}`).toContain(`${name}_${suffix}`);
      }
    }
    for (const name of ["APP_ORIGIN_MAINNET", "APP_ORIGIN_TESTNET"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
      expect(runbook, name).toContain(name);
    }
  });

  it("marks the owner's steps for both networks in the runbook", () => {
    const section = runbook.slice(runbook.indexOf("### 3.5 Both networks in one project"));
    expect(section.length).toBeGreaterThan(0);
    expect(
      section.slice(0, section.indexOf("## 4.")).match(/\*\*OWNER:\*\*/g)?.length,
    ).toBeGreaterThanOrEqual(5);
  });
});
