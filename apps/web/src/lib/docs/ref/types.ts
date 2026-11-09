/**
 * The shape of a reference table. Each area of the reference (CLI, contract, events, HTTP API,
 * SDK, policy rules, limits, builds) keeps its rows in `ref/<area>.ts`, and a page shows them with
 * `<RefTable id="..." />`. One component, one Markdown handler and one anchor rule serve them all.
 */

/** A column of a reference table. `key` names the cell in each row. */
export interface RefColumn {
  readonly key: string;
  readonly label: string;
}

/** A row. Cells are Rich text: the parts in backticks render as code. `id` is the row's anchor. */
export interface RefRow {
  readonly id?: string;
  readonly cells: Readonly<Record<string, string>>;
}

/** One table a page renders with `<RefTable id="..." />`. */
export interface RefTable {
  readonly id: string;
  /** The scroll region's accessible name, such as "Vault methods". */
  readonly label: string;
  readonly columns: readonly RefColumn[];
  readonly rows: readonly RefRow[];
}

/** A row id is a URL fragment a link can name: lowercase, digits, `_` and `-`. */
export const ROW_ID = /^[a-z0-9][a-z0-9_-]*$/;
