import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsForm } from "./SettingsForm";

const save = async () => null;
const render = (kind: "team" | "external" | "canary", proofPublic = false) =>
  renderToStaticMarkup(
    createElement(SettingsForm, {
      vault: "v.vaults.probarion.near",
      kind,
      zeroRetention: false,
      proofPublic,
      save,
      refresh: save,
    }),
  ).replaceAll("&#x27;", "'");

describe("SettingsForm", () => {
  it("offers the public proof page to the owner of an ordinary vault", () => {
    for (const kind of ["team", "external"] as const) {
      const out = render(kind, true);
      expect(out, kind).toContain('name="proof_public"');
      expect(out, kind).toContain("Public proof");
      expect(out, kind).not.toContain("ledger is private");
    }
  });

  it("offers nothing of the sort for the Canary: one line says why", () => {
    const out = render("canary");
    expect(out).not.toContain('name="proof_public"');
    expect(out).not.toContain("Public proof");
    expect(out).toContain("The Canary's ledger is private: visitors' words never become public.");
    // the other setting and the approvers' re-sync are the owner's still
    expect(out).toContain('name="zero_retention"');
    expect(out).toContain("Re-sync approvers from the chain");
  });

  it("does not offer it for the Canary even if its row says public (the database forbids that state)", () => {
    expect(render("canary", true)).not.toContain('name="proof_public"');
  });
});
