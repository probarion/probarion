import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, SUPABASE_STUB, seedTenant } from "./harness";
import { at } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// The public usage numbers (migration 0009): metrics_compute writes one day of counts per network into metrics_daily,
// and public_usage_metrics reads them back for the page. The segments are team, external owners and Canary
// participants, and they never share a row.

const H = (c: string) => c.repeat(64);

interface Usage {
  network: string;
  totals: { segment: string; metric: string; value: number }[];
  recent: { segment: string; metric: string; value: number }[];
  canary_participants: number;
  external_owners: number;
  team_vaults: number;
  pilots: { cohort: string; n: number }[];
  pilot_names: string[];
  updated_at: string | null;
}

const usage = (pg: PGlite, network: string, days?: number): Promise<Usage> =>
  pgliteDb(pg, "anon").rpc<Usage>(
    "public_usage_metrics",
    days === undefined ? { network } : { network, days },
  );

const compute = (pg: PGlite, network: string, day?: string) =>
  pgliteDb(pg).rpc<{ day: string; network: string; rows: number }>(
    "metrics_compute",
    day ? { network, day } : { network },
  );

const value = (rows: Usage["totals"], segment: string, metric: string): number =>
  rows
    .filter((r) => r.segment === segment && r.metric === metric)
    .reduce((n, r) => n + Number(r.value), 0);

const utcDay = async (pg: PGlite, offsetDays = 0): Promise<string> => {
  const r = await pg.query<{ d: string }>(
    "select to_char((now() at time zone 'UTC')::date + $1::int, 'YYYY-MM-DD') as d",
    [offsetDays],
  );
  return at(r.rows).d;
};

const testnetTenant = async (
  pg: PGlite,
  vault: string,
  owner: string,
  kind = "external",
): Promise<string> => {
  const r = await pg.query<{ id: string }>(
    "insert into public.tenants (vault_id, network, kind, owner_account) values ($1, 'testnet', $2, $3) returning id",
    [vault, kind, owner],
  );
  return at(r.rows).id;
};

const event = (pg: PGlite, tenant: string, key: string, kind: string, observedAt?: string) =>
  pg.query(
    "insert into public.vault_events (tenant_id, event_key, kind, observed_at) values ($1, $2, $3, coalesce($4::timestamptz, now()))",
    [tenant, key, kind, observedAt ?? null],
  );

const ledger = (
  pg: PGlite,
  tenant: string,
  seq: number,
  kind: "decision" | "payment",
  body: object,
) =>
  pg.query(
    "insert into public.ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id) values ($1, $2, $3, $4, $5, 's', 'p', $5, 'r')",
    [tenant, seq, kind, JSON.stringify(body), String(seq).repeat(64)],
  );

const contract = (status: string, code: string | null, tx: string | null) => ({
  contract: { code, tx_hash: tx, spend_id: null, status },
});

interface Attempt {
  visitor: string;
  ip: string;
  team?: boolean;
  raw?: boolean;
  status?: string;
  contractStatus?: string | null;
  tokens?: [number, number] | null;
  createdAt?: string;
}

let attemptN = 0;
const attempt = (pg: PGlite, a: Attempt) => {
  attemptN += 1;
  return pg.query(
    `insert into public.canary_attempts (visitor_hash, ip_hash, is_team, mode, text_sha256, text_length, code_status, raw,
        contract_status, contract_code, request_id, model_prompt_tokens, model_completion_tokens, created_at)
     values ($1, $2, $3, 'live', $4, 5, $5, $6, $7, $8, 'r', $9, $10, coalesce($11::timestamptz, now()))`,
    [
      a.visitor,
      a.ip,
      a.team ?? false,
      String(attemptN).padStart(64, "0"),
      a.status ?? "refused_by_code",
      a.raw ?? false,
      a.contractStatus ?? null,
      a.contractStatus === "refused_by_contract" ? "NoMandate" : null,
      a.tokens?.[0] ?? null,
      a.tokens?.[1] ?? null,
      a.createdAt ?? null,
    ],
  );
};

describe("metrics_compute and public_usage_metrics", () => {
  let pg: PGlite;
  let ext: string;
  let today: string;
  let yesterday: string;

  beforeAll(async () => {
    pg = await freshDb();
    const team = await seedTenant(pg, {
      vault: "demo.vaults.probarion.near",
      owner: "probarion.near",
      kind: "team",
    });
    ext = await seedTenant(pg, { vault: "acme.vaults.probarion.near", owner: "acme.near" });
    await seedTenant(pg, { vault: "acme-two.vaults.probarion.near", owner: "acme.near" });
    await seedTenant(pg, { vault: "beta.vaults.probarion.near", owner: "beta.near" });
    const can = await seedTenant(pg, {
      vault: "canary.vaults.probarion.near",
      owner: "probarion.near",
      kind: "canary",
    });
    // The same kinds of activity on testnet, which must not show in the mainnet numbers.
    const tnet = await testnetTenant(pg, "t.vaults.probarion.testnet", "tester.near");
    await testnetTenant(pg, "t-team.vaults.probarion.testnet", "probarion.testnet", "team");

    for (const [t, key, kind] of [
      [team, "spend:1:paid", "spend_paid"],
      [ext, "spend:1:paid", "spend_paid"],
      [ext, "spend:2:burned", "spend_burned"],
      [ext, "mandate:1", "mandate_created"],
      [ext, "spend:3:failed", "spend_failed"], // not a payment
      [ext, "spend:4:pending", "spend_pending"], // not a payment yet
      [ext, "refusal:1", "refused_by_contract"], // the ledger is the source of refusals, not this event
      [can, "spend:1:held", "spend_held"],
      [tnet, "spend:1:paid", "spend_paid"],
      [tnet, "spend:2:paid", "spend_paid"],
      [tnet, "mandate:1", "mandate_created"],
    ] as const) {
      await event(pg, t, key, kind);
    }

    // The vault ledgers. Only a `payment` entry whose contract refused, with a transaction, is refused on chain.
    await ledger(pg, ext, 0, "decision", {
      verdict: "refuse",
      evidence: { model: "m" },
      contract: null,
    });
    await ledger(pg, ext, 1, "decision", { verdict: "allow", evidence: null, contract: null });
    await ledger(pg, ext, 2, "payment", {
      verdict: null,
      evidence: null,
      ...contract("refused", "OverPerPayment", "REFUSEDTX"),
    });
    await ledger(pg, ext, 3, "payment", {
      verdict: null,
      evidence: null,
      ...contract("unknown", "deadline", "UNKNOWNTX"),
    });
    await ledger(pg, ext, 4, "payment", {
      verdict: null,
      evidence: null,
      ...contract("failed", "Other", "FAILEDTX"),
    });
    await ledger(pg, ext, 5, "payment", {
      verdict: null,
      evidence: null,
      ...contract("refused", "NoMandate", null),
    }); // a dry run: no tx
    await ledger(pg, ext, 6, "decision", {
      verdict: "allow",
      evidence: null,
      ...contract("refused", "X", "DECISIONTX"),
    }); // not a payment
    await ledger(pg, ext, 7, "decision", {
      verdict: "hold",
      evidence: { model: "m" },
      contract: null,
    });
    await ledger(pg, team, 0, "decision", { verdict: "refuse", evidence: null, contract: null });
    // The Canary's ledger is left out: its attempts are counted instead.
    await ledger(pg, can, 0, "decision", {
      verdict: "refuse",
      evidence: { model: "m" },
      contract: null,
    });
    await ledger(pg, can, 1, "payment", {
      verdict: null,
      evidence: null,
      ...contract("refused", "NoMandate", "CANARYTX"),
    });
    await ledger(pg, tnet, 0, "decision", {
      verdict: "refuse",
      evidence: { model: "m" },
      contract: null,
    });
    await ledger(pg, tnet, 1, "payment", {
      verdict: null,
      evidence: null,
      ...contract("refused", "NoMandate", "TNETTX"),
    });

    // Canary attempts. Outside visitors: a1, a2, a3, the old running row and the paid one (four browsers, five addresses).
    await attempt(pg, {
      visitor: H("1"),
      ip: H("a"),
      raw: true,
      contractStatus: "refused_by_contract",
      tokens: [800, 100],
    });
    await attempt(pg, { visitor: H("1"), ip: H("b") }); // the model gave no answer: no tokens
    await attempt(pg, { visitor: H("2"), ip: H("c"), tokens: [800, 100] });
    await attempt(pg, {
      visitor: H("3"),
      ip: H("d"),
      team: true,
      raw: true,
      contractStatus: "refused_by_contract",
      tokens: [800, 100],
    });
    // Still running and younger than 90 s: not counted anywhere.
    await attempt(pg, {
      visitor: H("4"),
      ip: H("e"),
      status: "running",
      raw: true,
      tokens: [800, 100],
    });
    // Running for five minutes: it was killed. It is one attempt and nothing else, whatever else its row says.
    await attempt(pg, {
      visitor: H("5"),
      ip: H("f"),
      status: "running",
      raw: true,
      contractStatus: "refused_by_contract",
      tokens: [800, 100],
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    await attempt(pg, { visitor: H("6"), ip: H("7"), status: "paid" });

    // Invoices: only a decided one counts, and not the Canary's, nor another network's.
    const invoice = (
      t: string,
      ref: string,
      status: string,
      tokens: [number, number],
      decided: boolean,
    ) =>
      pg.query(
        `insert into public.invoices (tenant_id, invoice_hash, ref, media_type, retained, status, request_id, created_by,
            model_prompt_tokens, model_completion_tokens, decided_at)
         values ($1, $2, $3, 'text/plain', false, $4, 'r', 'x', $5, $6, case when $7 then now() end)`,
        [t, H(ref.length.toString(16)), ref, status, tokens[0], tokens[1], decided],
      );
    await invoice(ext, "inv-a", "decided", [900, 120], true);
    await invoice(ext, "inv-bb", "processing", [50, 50], false);
    await invoice(can, "inv-ccc", "decided", [7, 7], true);
    await invoice(tnet, "inv-dddd", "decided", [5000, 5000], true);

    await pg.query(
      `insert into public.pilots (vault_account_id, owner_account_id, cohort, consent_name, consent_at, display_name) values
         ('acme.vaults.probarion.near', 'acme.near', 'external', true, now() - interval '1 day', 'Acme Design'),
         ('beta.vaults.probarion.near', 'beta.near', 'external', true, now(), 'Beta Co'),
         (null, 'quiet.near', 'external', false, null, 'Quiet Studio'),
         ('demo.vaults.probarion.near', 'probarion.near', 'team', false, null, null),
         (null, 'nameless.near', 'external', true, now(), null)`,
    );

    today = await utcDay(pg);
    yesterday = await utcDay(pg, -1);
    // What the cron does, so that a run that crosses midnight cannot split the test's own numbers.
    for (const network of ["mainnet", "testnet"]) {
      await compute(pg, network, yesterday);
      await compute(pg, network, today);
    }
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });

  it("keeps team, external owners and Canary participants in separate segments", async () => {
    const m = await usage(pg, "mainnet", 7);
    const v = (segment: string, metric: string) => value(m.totals, segment, metric);
    expect(v("team", "vaults")).toBe(1);
    expect(v("external", "vaults")).toBe(3);
    expect(v("canary", "vaults")).toBe(1);
    expect(v("external", "mandates")).toBe(1);
    expect(v("team", "spends_paid")).toBe(1);
    expect(v("external", "spends_paid")).toBe(2); // one paid, one burned
    expect(v("external", "cross_chain_payouts")).toBe(1);
    expect(v("canary", "held")).toBe(1);
    expect(v("external", "held")).toBe(0);
    expect(v("external", "refused_by_code")).toBe(1);
    expect(v("external", "refused_by_contract")).toBe(1);
    expect(v("external", "model_decisions")).toBe(2);
    expect(v("external", "nearai_tokens_in")).toBe(900);
    expect(v("external", "nearai_tokens_out")).toBe(120);
    // The team's own ledger refusal and its one Canary attempt (refused by code too) are both the team's.
    expect(v("team", "refused_by_code")).toBe(2);
    expect(v("team", "canary_attempts")).toBe(1);
    expect(v("team", "canary_raw_attempts")).toBe(1);
    expect(v("team", "refused_by_contract")).toBe(1);
    expect(v("team", "model_decisions")).toBe(1);
    expect(v("team", "nearai_tokens_in")).toBe(800);
    expect(v("team", "nearai_tokens_out")).toBe(100);
    expect(m.team_vaults).toBe(1);
    expect(m.external_owners).toBe(2);
    expect(m.pilots).toEqual([
      { cohort: "external", n: 4 },
      { cohort: "team", n: 1 },
    ]);
    // Names only with written consent (spec §14.5), oldest consent first, and only where there is a name.
    expect(m.pilot_names).toEqual(["Acme Design", "Beta Co"]);
  });

  it("counts the Canary from its attempts only: the running ones, the team's and its own ledger are handled apart", async () => {
    const m = await usage(pg, "mainnet");
    const v = (metric: string) => value(m.totals, "canary", metric);
    // Outside attempts: a1, a2, a3, the killed one and the paid one. The young running row is left out.
    expect(v("canary_attempts")).toBe(5);
    expect(v("canary_raw_attempts")).toBe(1); // not the killed one
    expect(v("refused_by_code")).toBe(3); // a1, a2, a3: not the paid one, not the killed one
    expect(v("refused_by_contract")).toBe(1); // not the killed one, whose row says it
    expect(v("model_decisions")).toBe(2); // a1 and a3: a2 had no answer, the killed one counts as nothing else
    expect(v("nearai_tokens_in")).toBe(1600);
    expect(v("nearai_tokens_out")).toBe(200);
    // Canary participants: the smaller of 4 browsers (1, 2, 5, 6) and 5 addresses (a, b, c, f, 7).
    expect(m.canary_participants).toBe(4);
  });

  it("counts a refusal on chain only for a payment the contract refused, with its transaction", async () => {
    const m = await usage(pg, "mainnet");
    // The refused one with a tx counts. The unknown and the failed ones carry a code and a tx and do not. The dry run
    // has no tx. A decision entry never counts, and neither does the vault event of the same name.
    expect(value(m.totals, "external", "refused_by_contract")).toBe(1);
    expect(value(m.totals, "canary", "refused_by_contract")).toBe(1); // from the attempts, not the Canary's ledger
  });

  it("leaves another network out of every number", async () => {
    const m = await usage(pg, "mainnet");
    expect(m.network).toBe("mainnet");
    expect(value(m.totals, "external", "spends_paid")).toBe(2); // testnet has two more
    expect(value(m.totals, "external", "mandates")).toBe(1); // testnet has one more
    expect(value(m.totals, "external", "nearai_tokens_in")).toBe(900); // testnet has 5000 more
    expect(m.external_owners).toBe(2); // tester.near is on testnet
    expect(m.team_vaults).toBe(1);
  });

  it("gives testnet its own numbers, and no Canary rows while testnet has no Canary vault", async () => {
    const m = await usage(pg, "testnet");
    const v = (segment: string, metric: string) => value(m.totals, segment, metric);
    expect(m.network).toBe("testnet");
    expect(v("external", "vaults")).toBe(1);
    expect(v("team", "vaults")).toBe(1);
    expect(v("external", "spends_paid")).toBe(2);
    expect(v("external", "mandates")).toBe(1);
    expect(v("external", "refused_by_code")).toBe(1);
    expect(v("external", "refused_by_contract")).toBe(1);
    expect(v("external", "nearai_tokens_in")).toBe(5000);
    expect(m.external_owners).toBe(1);
    expect(m.team_vaults).toBe(1);
    // The attempts carry no network, so they are counted for the network that has the Canary vault, and for no other.
    expect(m.totals.filter((r) => r.segment === "canary")).toEqual([]);
    expect(v("team", "canary_attempts")).toBe(0);
    expect(m.canary_participants).toBe(0);
  });

  it("writes nothing for a network with no activity, and reads as empty with no update time", async () => {
    const fresh = await freshDb();
    try {
      const m = await usage(fresh, "mainnet");
      expect(m).toMatchObject({
        network: "mainnet",
        totals: [],
        recent: [],
        canary_participants: 0,
        external_owners: 0,
        team_vaults: 0,
        pilots: [],
        pilot_names: [],
        updated_at: null,
      });
      expect(await compute(fresh, "mainnet")).toMatchObject({ network: "mainnet", rows: 0 });
    } finally {
      await fresh.close();
    }
  }, 30_000);

  it("returns numbers, not strings, and stamps every row of a run with the time it ran", async () => {
    const m = await usage(pg, "mainnet");
    expect(m.totals.length).toBeGreaterThan(10);
    expect(m.totals.every((r) => typeof r.value === "number")).toBe(true);
    const r = await pg.query<{ n: number; stamps: number; fresh: number }>(
      `select count(*)::int as n, count(distinct computed_at)::int as stamps,
              count(*) filter (where computed_at > now() - interval '5 minutes')::int as fresh
         from public.metrics_daily where network = 'mainnet' and day = $1::date`,
      [today],
    );
    expect(at(r.rows).stamps).toBe(1);
    expect(at(r.rows).fresh).toBe(at(r.rows).n);
    const stamp = await pg.query<{ same: boolean }>(
      "select $1::timestamptz = (select max(computed_at) from public.metrics_daily where network = 'mainnet') as same",
      [m.updated_at],
    );
    expect(at(stamp.rows).same).toBe(true);
  });

  it("returns the day, the network and how many rows it wrote", async () => {
    const r = await compute(pg, "mainnet", today);
    const n = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.metrics_daily where network = 'mainnet' and day = $1::date",
      [today],
    );
    expect(r).toEqual({ day: today, network: "mainnet", rows: at(n.rows).n });
    expect(r.rows).toBeGreaterThan(0);
  });

  it("is idempotent for a day, and a rerun replaces what the earlier one wrote", async () => {
    const snapshot = async () =>
      (
        await pg.query<{ k: string }>(
          `select day::text || '/' || network || '/' || segment || '/' || metric || '=' || value::text as k
             from public.metrics_daily order by 1`,
        )
      ).rows.map((r) => r.k);
    const before = await snapshot();
    await compute(pg, "mainnet", today);
    await compute(pg, "mainnet", yesterday);
    expect(await snapshot()).toEqual(before);
    const r = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.metrics_daily where segment = 'external' and metric = 'vaults' and network = 'mainnet'",
    );
    expect(at(r.rows).n).toBe(1);

    // An event that goes away, and one that comes, change the next run and nothing else.
    await pg.query(
      "delete from public.vault_events where tenant_id = $1 and event_key = 'mandate:1'",
      [ext],
    );
    await compute(pg, "mainnet", today);
    await compute(pg, "mainnet", yesterday);
    expect(value((await usage(pg, "mainnet")).totals, "external", "mandates")).toBe(0);
    await event(pg, ext, "mandate:1", "mandate_created");
    await compute(pg, "mainnet", today);
    await compute(pg, "mainnet", yesterday);
    expect(value((await usage(pg, "mainnet")).totals, "external", "mandates")).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it("takes an advisory lock for the network and the day, so two runs cannot interleave", async () => {
    const fn = await pg.query<{ src: string }>(
      "select prosrc as src from pg_proc where oid = 'public.metrics_compute(jsonb)'::regprocedure",
    );
    expect(at(fn.rows).src).toContain("pg_advisory_xact_lock");
    expect(at(fn.rows).src).toContain("metrics_compute:");
    // And the lock really is held when the run is over, until its transaction ends: the key is the hash of the
    // network and the day.
    const held = await pg.transaction(async (tx) => {
      await tx.query("select public.metrics_compute($1::jsonb)", [
        JSON.stringify({ network: "mainnet", day: "2026-01-02" }),
      ]);
      return (
        await tx.query<{
          classid: number;
          objid: number;
          wanted_classid: number;
          wanted_objid: number;
        }>(
          `select l.classid::bigint as classid, l.objid::bigint as objid,
                  ((k.k >> 32) & 4294967295) as wanted_classid, (k.k & 4294967295) as wanted_objid
             from pg_locks l,
                  (select hashtext('metrics_compute:mainnet:2026-01-02')::bigint as k) k
            where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted`,
        )
      ).rows;
    });
    expect(held).toHaveLength(1);
    expect(Number(at(held).classid)).toBe(Number(at(held).wanted_classid));
    expect(Number(at(held).objid)).toBe(Number(at(held).wanted_objid));
    const after = await pg.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
    );
    expect(at(after.rows).n).toBe(0);
  });

  it("lets concurrent runs for the same day finish without an error, and leaves the same rows", async () => {
    // PGlite has one connection and runs statements one at a time, so this does not interleave two real sessions:
    // the lock itself is shown by the test above. What it does show is that the calls queue up and end in one answer.
    const before = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.metrics_daily",
    );
    const runs = await Promise.all([0, 1, 2, 3].map(() => compute(pg, "mainnet", today)));
    expect(new Set(runs.map((r) => r.rows)).size).toBe(1);
    const after = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.metrics_daily",
    );
    expect(at(after.rows).n).toBe(at(before.rows).n);
  });

  describe("who may call what", () => {
    it("lets only the service role compute, and runs it as its caller", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        await expect(
          pgliteDb(pg, role, "x.near").rpc("metrics_compute", { network: "mainnet" }),
        ).rejects.toMatchObject({
          code: "permission_denied",
        });
      }
      await expect(compute(pg, "mainnet", today)).resolves.toMatchObject({ network: "mainnet" });
      const f = await pg.query<{ definer: boolean; config: string[] | null }>(
        "select prosecdef as definer, proconfig as config from pg_proc where oid = 'public.metrics_compute(jsonb)'::regprocedure",
      );
      expect(at(f.rows).definer).toBe(false);
      expect(at(f.rows).config).toContain("search_path=public, pg_temp");
    });

    it("lets anyone read the public numbers, as a security definer with a pinned search path", async () => {
      for (const role of ["anon", "authenticated", "service_role"] as const) {
        const m = await pgliteDb(pg, role, "x.near").rpc<Usage>("public_usage_metrics", {
          network: "mainnet",
        });
        expect(m.network).toBe("mainnet");
      }
      const f = await pg.query<{ definer: boolean; config: string[] | null }>(
        "select prosecdef as definer, proconfig as config from pg_proc where oid = 'public.public_usage_metrics(jsonb)'::regprocedure",
      );
      expect(at(f.rows).definer).toBe(true);
      expect(at(f.rows).config).toContain("search_path=public, pg_temp");
    });

    it("holds no EXECUTE for PUBLIC on either function, and gives anon no way to read the table itself", async () => {
      const r = await pg.query<{ fn: string; n: number }>(
        `select p.oid::regprocedure::text as fn,
                (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as n
           from pg_proc p where p.oid in ('public.metrics_compute(jsonb)'::regprocedure, 'public.public_usage_metrics(jsonb)'::regprocedure)`,
      );
      expect(r.rows.map((x) => x.n)).toEqual([0, 0]);
      await expect(
        asRole(pg, "anon", null, (tx) => tx.query("select * from public.metrics_daily")),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("what it refuses", () => {
    it("needs a network, and only mainnet or testnet", async () => {
      for (const p of [
        {},
        { network: null },
        { network: "" },
        { network: "devnet" },
        { network: 1 },
        { network: "Mainnet" },
      ]) {
        await expect(pgliteDb(pg).rpc("metrics_compute", p)).rejects.toMatchObject({
          code: "invalid_input",
        });
        await expect(pgliteDb(pg, "anon").rpc("public_usage_metrics", p)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    });

    it("needs a day that is a date", async () => {
      for (const day of [
        "garbage",
        "2026-13-45",
        "yesterday",
        "infinity",
        "20261105",
        "2026-11-5",
        20261105,
        "",
      ]) {
        await expect(
          pgliteDb(pg).rpc("metrics_compute", { network: "mainnet", day }),
        ).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    });
  });
});

describe("the days of the numbers", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    // A tenant with a ledger could not be deleted, and none of these has one: the ledger is append-only.
    await pg.exec(
      "delete from public.tenants; truncate public.canary_attempts, public.metrics_daily, public.pilots",
    );
  });

  it("counts a UTC day from its first instant to just before the next one", async () => {
    const a = await seedTenant(pg, { vault: "a.vaults.probarion.near", owner: "a.near" });
    const b = await seedTenant(pg, { vault: "b.vaults.probarion.near", owner: "b.near" });
    await seedTenant(pg, { vault: "c.vaults.probarion.near", owner: "p.near", kind: "canary" });
    await pg.query("update public.tenants set created_at = '2026-11-01T23:59:59Z' where id = $1", [
      a,
    ]);
    await pg.query("update public.tenants set created_at = '2026-11-02T00:00:00Z' where id = $1", [
      b,
    ]);
    await event(pg, a, "spend:0:paid", "spend_paid", "2026-10-31T23:59:59.999Z");
    await event(pg, a, "spend:1:paid", "spend_paid", "2026-11-01T00:00:00Z");
    await event(pg, a, "spend:2:paid", "spend_paid", "2026-11-01T23:59:59.999Z");
    await event(pg, a, "spend:3:paid", "spend_paid", "2026-11-02T00:00:00Z");
    await attempt(pg, { visitor: H("1"), ip: H("a"), createdAt: "2026-11-01T12:00:00Z" });
    await attempt(pg, { visitor: H("2"), ip: H("b"), createdAt: "2026-11-02T00:00:00Z" });

    await compute(pg, "mainnet", "2026-11-01");
    await compute(pg, "mainnet", "2026-11-02");
    const rows = async (day: string) =>
      (
        await pg.query<{ segment: string; metric: string; value: string }>(
          "select segment, metric, value::text from public.metrics_daily where day = $1::date and network = 'mainnet' order by segment, metric",
          [day],
        )
      ).rows.map((r) => `${r.segment}/${r.metric}=${r.value}`);
    expect(await rows("2026-11-01")).toEqual([
      "canary/canary_attempts=1",
      "canary/refused_by_code=1",
      "external/spends_paid=2",
      "external/vaults=1",
    ]);
    expect(await rows("2026-11-02")).toEqual([
      "canary/canary_attempts=1",
      "canary/refused_by_code=1",
      "external/spends_paid=1",
      "external/vaults=1",
    ]);
  });

  it("totals every computed day, and shows the last 7 days (at most 90) beside them", async () => {
    const t = await seedTenant(pg, { vault: "a.vaults.probarion.near", owner: "a.near" });
    await pg.query(
      "update public.tenants set created_at = now() - interval '200 days' where id = $1",
      [t],
    );
    const ago = (d: number) => `now() - interval '${d} days'`;
    for (const [d, key] of [
      [0, "now"],
      [6, "six"],
      [7, "seven"],
      [8, "eight"],
      [60, "sixty"],
      [95, "ninety-five"],
    ] as const) {
      await pg.query(
        `insert into public.vault_events (tenant_id, event_key, kind, observed_at) values ($1, $2, 'spend_paid', ${ago(d)})`,
        [t, key],
      );
      const day = await pg.query<{ d: string }>(
        `select to_char((${ago(d)}) at time zone 'UTC', 'YYYY-MM-DD') as d`,
      );
      await compute(pg, "mainnet", at(day.rows).d);
    }
    const paid = (rows: Usage["totals"]) => value(rows, "external", "spends_paid");
    const week = await usage(pg, "mainnet", 7);
    expect(paid(week.totals)).toBe(6);
    expect(paid(week.recent)).toBe(2); // today and six days ago: the 7 days that end today
    expect(paid((await usage(pg, "mainnet")).recent)).toBe(2); // 7 is the default
    expect(paid((await usage(pg, "mainnet", 8)).recent)).toBe(3);
    expect(paid((await usage(pg, "mainnet", 1)).recent)).toBe(1);
    expect(paid((await usage(pg, "mainnet", 90)).recent)).toBe(5);
    expect(paid((await usage(pg, "mainnet", 1000)).recent)).toBe(5); // capped at 90 days
    for (const days of [0, -3]) expect(paid((await usage(pg, "mainnet", days)).recent)).toBe(1); // at least a day
    const odd = await pgliteDb(pg, "anon").rpc<Usage>("public_usage_metrics", {
      network: "mainnet",
      days: "soon",
    });
    expect(paid(odd.recent)).toBe(2); // anything that is not a number of days is 7
  });

  it("counts people as the smaller of the distinct browsers and the distinct addresses", async () => {
    await seedTenant(pg, { vault: "c.vaults.probarion.near", owner: "p.near", kind: "canary" });
    // Three browsers behind one address.
    for (const v of ["1", "2", "3"]) await attempt(pg, { visitor: H(v), ip: H("a") });
    expect((await usage(pg, "mainnet")).canary_participants).toBe(1);
    // One browser behind three addresses, on top of those.
    await pg.exec("truncate public.canary_attempts");
    for (const ip of ["a", "b", "c"]) await attempt(pg, { visitor: H("1"), ip: H(ip) });
    expect((await usage(pg, "mainnet")).canary_participants).toBe(1);
    // The team's browsers do not count as participants.
    await attempt(pg, { visitor: H("9"), ip: H("9"), team: true });
    await attempt(pg, { visitor: H("2"), ip: H("d") });
    expect((await usage(pg, "mainnet")).canary_participants).toBe(2);
  });

  it("counts the Canary's attempts only on the network that has the Canary vault", async () => {
    await testnetTenant(pg, "c.vaults.probarion.testnet", "p.testnet", "canary");
    await attempt(pg, { visitor: H("1"), ip: H("a") });
    const today = await utcDay(pg);
    await compute(pg, "mainnet", today);
    await compute(pg, "testnet", today);
    expect(
      (await usage(pg, "mainnet")).totals.filter((r) => r.metric === "canary_attempts"),
    ).toEqual([]);
    expect(value((await usage(pg, "testnet")).totals, "canary", "canary_attempts")).toBe(1);
    expect((await usage(pg, "mainnet")).canary_participants).toBe(0);
    expect((await usage(pg, "testnet")).canary_participants).toBe(1);
  });

  it("counts a distinct owner once, however many external vaults they have", async () => {
    await seedTenant(pg, { vault: "a1.vaults.probarion.near", owner: "same.near" });
    await seedTenant(pg, { vault: "a2.vaults.probarion.near", owner: "same.near" });
    await seedTenant(pg, { vault: "t1.vaults.probarion.near", owner: "team.near", kind: "team" });
    expect((await usage(pg, "mainnet")).external_owners).toBe(1);
  });
});

describe("the migration on a database that already has rows", () => {
  it("keeps the rows it finds, as testnet rows, and moves the key to the network", async () => {
    const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const last = files.findIndex((f) => f.endsWith("_metrics.sql"));
    expect(last).toBeGreaterThan(0);
    const pg = new PGlite();
    try {
      await pg.exec(SUPABASE_STUB);
      for (const f of files.slice(0, last)) await pg.exec(readFileSync(`${dir}/${f}`, "utf8"));
      await pg.exec(
        `insert into public.metrics_daily (day, segment, metric, value) values
           ('2026-11-01', 'team', 'vaults', 2), ('2026-11-01', 'external', 'spends_paid', 5)`,
      );
      await pg.exec(readFileSync(`${dir}/${files[last]}`, "utf8"));
      const rows = await pg.query<{
        day: string;
        network: string;
        segment: string;
        metric: string;
        value: string;
      }>(
        "select day::text, network, segment, metric, value::text from public.metrics_daily order by segment",
      );
      expect(rows.rows).toEqual([
        {
          day: "2026-11-01",
          network: "testnet",
          segment: "external",
          metric: "spends_paid",
          value: "5",
        },
        { day: "2026-11-01", network: "testnet", segment: "team", metric: "vaults", value: "2" },
      ]);
      // The key now has the network, so the same day, segment and metric can exist once for each.
      await pg.exec(
        "insert into public.metrics_daily (day, network, segment, metric, value) values ('2026-11-01', 'mainnet', 'team', 'vaults', 1)",
      );
      await expect(
        pg.exec(
          "insert into public.metrics_daily (day, network, segment, metric, value) values ('2026-11-01', 'mainnet', 'team', 'vaults', 1)",
        ),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        pg.exec(
          "insert into public.metrics_daily (day, network, segment, metric, value) values ('2026-11-01', 'devnet', 'team', 'vaults', 1)",
        ),
      ).rejects.toThrow(/check/);
      const key = await pg.query<{ cols: string }>(
        `select string_agg(a.attname, ',' order by array_position(i.indkey::int2[], a.attnum)) as cols
           from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
          where i.indrelid = 'public.metrics_daily'::regclass and i.indisprimary`,
      );
      expect(at(key.rows).cols).toBe("day,network,segment,metric");
    } finally {
      await pg.close();
    }
  }, 60_000);
});
