import { ScrollRegion } from "@/components/site/ScrollRegion";
import { ARCH_TEXT, ARCHITECTURE, type Architecture, edgeLine } from "@/lib/docs/architecture";
import d from "./docs.module.css";

/**
 * The architecture as an inline SVG: boxes by group, arrows from border to border, a label on
 * each arrow. It scales with its frame down to a width its text can still be read at, then scrolls sideways; the .md
 * twin lists the same boxes and arrows as text.
 */
export function ArchitectureView({ arch }: { arch: Architecture }) {
  return (
    <figure className={d.arch}>
      <ScrollRegion label={`${arch.title}, a diagram`} className={d.archScroll}>
        <svg
          viewBox={`0 0 ${arch.width} ${arch.height}`}
          role="img"
          aria-labelledby="arch-title arch-desc"
        >
          <title id="arch-title">{arch.title}</title>
          <desc id="arch-desc">{arch.summary}</desc>
          <defs>
            <marker
              id="arch-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className={d.archHead} />
            </marker>
          </defs>
          {arch.edges.map((e) => {
            const l = edgeLine(arch, e);
            return (
              <line
                key={`${e.from}-${e.to}`}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                className={d.archEdge}
                markerEnd="url(#arch-arrow)"
              />
            );
          })}
          {arch.nodes.map((n) => (
            <g key={n.id} className={d.archNode} data-group={n.group}>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10} />
              <text
                x={n.x + ARCH_TEXT.pad}
                y={n.y + ARCH_TEXT.label.baseline}
                className={d.archLabel}
                fontSize={ARCH_TEXT.label.size}
              >
                {n.label}
              </text>
              <text
                x={n.x + ARCH_TEXT.pad}
                y={n.y + ARCH_TEXT.detail.baseline}
                className={d.archDetail}
                fontSize={ARCH_TEXT.detail.size}
              >
                {n.detail}
              </text>
            </g>
          ))}
          {arch.edges.map((e) => {
            const l = edgeLine(arch, e);
            return (
              <text
                key={`${e.from}-${e.to}-label`}
                x={l.mx}
                y={l.my - 6}
                textAnchor="middle"
                className={d.archEdgeLabel}
                fontSize={ARCH_TEXT.detail.size}
              >
                {e.label}
              </text>
            );
          })}
        </svg>
      </ScrollRegion>
    </figure>
  );
}

/** `<ArchitectureDiagram />` on operate/architecture. */
export function ArchitectureDiagram() {
  return <ArchitectureView arch={ARCHITECTURE} />;
}
