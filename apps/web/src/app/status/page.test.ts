import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  network: { value: "testnet" as "mainnet" | "testnet" },
}));
vi.mock("@/lib/network", () => ({
  softRequestNetwork: async () => mocks.network.value,
  canonicalUrl: async (path: string) => `https://${mocks.network.value}.probarion.test${path}`,
}));
vi.mock("@/lib/health-server", () => ({ healthReport: mocks.report }));

import { PLANNED_ROUTES } from "@/lib/routes";
import StatusPage, { dynamic, generateMetadata } from "./page";

const logs = quietLogs();

const REPORT = {
  network: "testnet",
  settings: true,
  rpc: [
    {
      provider: 0,
      probe: {
        name: "rpc.testnet.fastnear.com",
        ok: true,
        latency_ms: 120,
        detail: "block 5, 1 s behind",
      },
    },
  ],
  nearai: {
    probe: { name: "NEAR AI Cloud", ok: false, latency_ms: 5000, detail: "timeout after 5000 ms" },
    configured: true,
  },
  other: { network: "mainnet", origin: "https://probarion.xyz" },
  checkedAt: "2026-11-07T12:00:00.000Z",
};

const render = async () => renderToStaticMarkup(createElement("div", null, await StatusPage()));

beforeEach(() => {
  mocks.report.mockReset();
  mocks.report.mockResolvedValue(REPORT);
  mocks.network.value = "testnet";
});

describe("/status", () => {
  it("is rendered per request and is built", async () => {
    expect(dynamic).toBe("force-dynamic");
    expect((await generateMetadata()).title).toBe("Status");
    expect(PLANNED_ROUTES).not.toContain("/status");
  });

  it("names itself at the address of the request's own network", async () => {
    for (const network of ["testnet", "mainnet"] as const) {
      mocks.network.value = network;
      expect((await generateMetadata()).alternates?.canonical).toBe(
        `https://${network}.probarion.test/status`,
      );
    }
  });

  it("shows the probes of the address's network only", async () => {
    const html = await render();
    expect(mocks.report).toHaveBeenCalledWith("testnet");
    expect(html).toContain("This address serves NEAR testnet.");
    expect(html).toContain("rpc.testnet.fastnear.com: passing");
    expect(html).toContain("NEAR AI Cloud: failing");
    expect(html).toContain("timeout after 5000 ms");
    expect(html).toContain("Page made at 2026-11-07 12:00:00 UTC.");
    expect(html).toContain("Funds stay in your own vault.");
  });

  it("links what works today and the other network's status, and no host that does not exist", async () => {
    const html = await render();
    expect(html).toContain('href="/#status"');
    expect(html).toContain('href="https://probarion.xyz/status"');
    expect(html).not.toContain("status.probarion.xyz");
  });

  it("says when the settings cannot be read, and hides the key note then", async () => {
    mocks.report.mockResolvedValue({
      ...REPORT,
      settings: false,
      rpc: [],
      nearai: { ...REPORT.nearai, configured: false },
      other: { network: "mainnet", origin: null },
    });
    const html = await render();
    expect(html).toContain("could not be read");
    expect(html).not.toContain("model key is not set");
    expect(html).not.toContain("https://probarion.xyz/status");
  });

  it("still renders when the report fails, and logs it", async () => {
    mocks.report.mockRejectedValue(new Error("boom"));
    const html = await render();
    expect(html).toContain("The checks could not run.");
    expect(html).toContain("Funds stay in your own vault.");
    expect(logs.lines.join("\n")).toContain("status.report_failed");
  });
});
