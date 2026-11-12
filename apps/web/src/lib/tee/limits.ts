// The live TEE check's caps (lib/tee/check.ts), in a module of their own with no imports, so the docs' limits table can
// read them without loading the check.

/** The whole check answers within this, so the route stays well inside its 30 s. */
export const TEE_CHECK_BUDGET_MS = 24_000;
/** One report fetch. NEAR AI answered in 2 to 8 s when this was written (2026-11-12). */
export const REPORT_TIMEOUT_MS = 12_000;
/** The report is about 290 KB; past this it is not read. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
/** The model attestations checked from one report (each costs an Intel and an NVIDIA call). */
export const MAX_ATTESTATIONS = 4;
