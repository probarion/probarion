import { TABLES as BUILDS } from "./builds";
import { TABLES as CLI } from "./cli";
import { TABLES as CONTRACT } from "./contract";
import { TABLES as EVENTS } from "./events";
import { TABLES as HTTP_API } from "./http-api";
import { TABLES as LIMITS } from "./limits";
import { TABLES as POLICY } from "./policy";
import { TABLES as SDK } from "./sdk";
import type { RefTable } from "./types";

/** Every reference table, from every area. Server only: an area may read a file at build time. */
export const REF_TABLES: readonly RefTable[] = [
  ...SDK,
  ...POLICY,
  ...CLI,
  ...CONTRACT,
  ...EVENTS,
  ...HTTP_API,
  ...LIMITS,
  ...BUILDS,
];

/** The table a page names. An unknown id throws, so the page, its twin and the build fail. */
export function refTable(id: string): RefTable {
  const table = REF_TABLES.find((t) => t.id === id);
  if (!table) throw new Error(`RefTable: unknown id "${id}"`);
  return table;
}

/** The anchors a table puts on its page: its row ids, in order. */
export function refAnchors(id: string): string[] {
  return refTable(id).rows.flatMap((r) => (r.id === undefined ? [] : [r.id]));
}
