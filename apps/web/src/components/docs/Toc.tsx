"use client";

import { useEffect, useState } from "react";
import { pickActive, type TocItem } from "@/lib/docs/toc-spy";
import d from "./docs.module.css";

/**
 * "On this page" with the current heading marked. Without JavaScript it is a plain list of links.
 */
export function Toc({ items }: { items: readonly TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const tops = items.map((i) => ({
        id: i.id,
        top: document.getElementById(i.id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      }));
      setActive(pickActive(tops, 100));
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [items]);
  return (
    <ol className={d.tocList}>
      {items.map((i) => (
        <li key={i.id} className={i.depth === 3 ? d.tocSub : undefined}>
          <a
            href={`#${i.id}`}
            className={d.tocLink}
            aria-current={i.id === active ? "location" : undefined}
          >
            {i.text}
          </a>
        </li>
      ))}
    </ol>
  );
}
