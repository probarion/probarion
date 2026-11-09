/**
 * The architecture diagram on operate/architecture: boxes and arrows as data, so the inline SVG,
 * the .md twin and the tests read one source. Coordinates are in the SVG's viewBox units.
 */

export type ArchGroup = "people" | "chain" | "app" | "outside";

export const ARCH_GROUP_LABELS: Readonly<Record<ArchGroup, string>> = {
  people: "People and agents",
  chain: "On NEAR",
  app: "Hosted app",
  outside: "Other services",
};

export interface ArchNode {
  readonly id: string;
  readonly label: string;
  /** One short line under the label. */
  readonly detail: string;
  readonly group: ArchGroup;
  /** A repository path that shows this part exists. */
  readonly source: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ArchEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface Architecture {
  readonly title: string;
  readonly summary: string;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly ArchNode[];
  readonly edges: readonly ArchEdge[];
}

export const ARCHITECTURE: Architecture = {
  title: "Probarion architecture",
  summary:
    "The owner signs every call that changes a vault. The vault contract on NEAR holds the funds.",
  width: 720,
  height: 200,
  nodes: [
    {
      id: "owner",
      label: "Owner",
      detail: "signs in a wallet",
      group: "people",
      source: "apps/web/src/app/console",
      x: 40,
      y: 70,
      w: 200,
      h: 60,
    },
    {
      id: "vault",
      label: "Vault contract",
      detail: "one per owner",
      group: "chain",
      source: "contracts/vault/src/lib.rs",
      x: 480,
      y: 70,
      w: 200,
      h: 60,
    },
  ],
  edges: [{ from: "owner", to: "vault", label: "owner calls" }],
};

/** Text sizes the SVG uses, and a safe width per character for each. */
export const ARCH_TEXT = {
  pad: 12,
  label: { size: 14, perChar: 8.2, baseline: 24 },
  detail: { size: 12, perChar: 6.9, baseline: 44 },
} as const;

interface Point {
  x: number;
  y: number;
}

function centre(n: ArchNode): Point {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

/** The point where a line from the box's centre toward `toward` crosses the box's border. */
export function borderPoint(n: ArchNode, toward: Point): Point {
  const c = centre(n);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : n.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : n.h / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** An arrow from border to border, and the midpoint its label sits on. */
export function edgeLine(arch: Architecture, edge: ArchEdge) {
  const from = arch.nodes.find((n) => n.id === edge.from);
  const to = arch.nodes.find((n) => n.id === edge.to);
  if (!from || !to)
    throw new Error(`Architecture: the arrow ${edge.from} → ${edge.to} names no box`);
  const a = borderPoint(from, centre(to));
  const b = borderPoint(to, centre(from));
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

function overlaps(a: ArchNode, b: ArchNode): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * What is wrong with a layout: a repeated id, an arrow that names no box, a box outside the
 * viewBox, two boxes that overlap, or a line of text wider than its box. Empty when it draws well.
 */
export function layoutProblems(arch: Architecture): string[] {
  const out: string[] = [];
  const ids = arch.nodes.map((n) => n.id);
  for (const [at, id] of ids.entries()) {
    if (ids.indexOf(id) !== at) out.push(`repeated box id "${id}"`);
  }
  for (const e of arch.edges) {
    if (!ids.includes(e.from) || !ids.includes(e.to)) {
      out.push(`the arrow ${e.from} → ${e.to} names no box`);
    }
  }
  for (const n of arch.nodes) {
    if (n.x < 0 || n.y < 0 || n.x + n.w > arch.width || n.y + n.h > arch.height) {
      out.push(`"${n.id}" is outside the ${arch.width}×${arch.height} viewBox`);
    }
    if (n.h < ARCH_TEXT.detail.baseline + ARCH_TEXT.pad)
      out.push(`"${n.id}" is too short for two lines`);
    const room = n.w - 2 * ARCH_TEXT.pad;
    if (n.label.length * ARCH_TEXT.label.perChar > room)
      out.push(`"${n.id}" label is wider than its box`);
    if (n.detail.length * ARCH_TEXT.detail.perChar > room)
      out.push(`"${n.id}" detail is wider than its box`);
  }
  for (const [i, a] of arch.nodes.entries()) {
    for (const b of arch.nodes.slice(i + 1)) {
      if (overlaps(a, b)) out.push(`"${a.id}" and "${b.id}" overlap`);
    }
  }
  return out;
}
