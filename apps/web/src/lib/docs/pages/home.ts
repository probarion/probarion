import type { DocPage } from "../types";

export const HOME: DocPage = {
  path: "",
  title: "Probarion docs",
  description:
    "Guides, concepts and reference for Probarion, the mandate layer for AI agents on NEAR: set limits, let an agent pay inside them, verify every payment.",
  lede: "Set the limits an AI agent pays inside, see how the NEAR contract checks every payment, and verify the signed ledger yourself.",
  type: "hub",
  audiences: ["beginner", "user", "developer", "partner", "evaluator", "agent"],
  sources: ["apps/web/src/lib/site/facts.ts"],
  reviewed: "2026-11-07",
  phase: 1,
  locale: "en",
};
