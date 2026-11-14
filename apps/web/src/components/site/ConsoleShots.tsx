import Image from "next/image";
import Link from "next/link";
import { CONSOLE_SHOTS } from "@/lib/site/facts";
import { KeepRich } from "./bits";
import c from "./console.module.css";
import s from "./site.module.css";

const NBSP = " ";

/**
 * The console's one screenshot on the landing, in the use cases (Integrate.tsx): the invoice's page of the testnet
 * demo vault, in a frame never wider than the file, so it is drawn at its own 856px at most and never larger. `sizes`
 * asks for the 856px file wherever the frame has room for it, not the ~420px variant. Beside it from 1100px, under it
 * below: what it shows, the record it was taken under, the file itself and the console. The section is far down the
 * page, so the image loads lazily, as next/image does by default.
 */
export function ConsoleShot() {
  const L = CONSOLE_SHOTS.landing;
  const shot = CONSOLE_SHOTS.shots.find((x) => x.id === L.shot);
  if (shot === undefined) return null;
  return (
    <figure className={c.figure}>
      <div className={c.frame}>
        <Image
          src={shot.src}
          width={shot.width}
          height={shot.height}
          alt={shot.alt}
          sizes="(min-width: 900px) 856px, 100vw"
        />
      </div>
      <figcaption className={c.cap}>
        <p className={s.eyebrow}>{L.eyebrow}</p>
        <p className={c.title}>{shot.title}</p>
        <p className={c.body}>
          <KeepRich text={shot.body} />
        </p>
        <dl className={c.record}>
          {CONSOLE_SHOTS.record.map((r) => (
            <div key={r.term}>
              <dt>{r.term}</dt>
              <dd>
                <KeepRich text={r.value} />
              </dd>
            </div>
          ))}
        </dl>
        <p className={c.links}>
          <a className={`${s.link} ${c.link}`} href={shot.src}>
            {CONSOLE_SHOTS.fullSize}
            <span className="sr-only">: {shot.title}</span>
          </a>
          <Link className={`${s.link} ${c.link}`} href={CONSOLE_SHOTS.open.href}>
            {CONSOLE_SHOTS.open.label}
            {NBSP}
            <span aria-hidden="true">→</span>
          </Link>
        </p>
      </figcaption>
    </figure>
  );
}
