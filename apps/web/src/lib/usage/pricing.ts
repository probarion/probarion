/**
 * The NEAR AI Cloud price behind the Usage page's "USD per decision". The OWNER sets it from NEAR AI Cloud's own price
 * list, for the model the app actually uses, and writes the date it was read in `source` (for example "price list read
 * 2026-11-06"). While it is null the page shows the measured tokens per decision and says that the price is not set yet.
 * Nothing is estimated: docs/ops/metrics.md says how to set it.
 */
export interface NearAiPrice {
  model: string;
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens. */
  outputPerMTok: number;
  source: string;
}

export const NEARAI_PRICE: NearAiPrice | null = null;
