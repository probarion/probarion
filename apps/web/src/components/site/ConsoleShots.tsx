import Image from "next/image";
import Link from "next/link";
import { ExternalLink } from "@/components/ui";
import { CONSOLE_SHOTS, type ConsoleShot } from "@/lib/site/facts";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/** Real testnet screenshots of the console, after the ink band (audit P1-23). On a phone they scroll sideways. */
export function ConsoleShots() {
  return (
    <LandingSection
      id="console"
      head={{
        eyebrow: CONSOLE_SHOTS.eyebrow,
        title: CONSOLE_SHOTS.title,
        lede: CONSOLE_SHOTS.intro,
      }}
    >
      <ScrollRegion className={s.shotRow} label="Console screenshots">
        {CONSOLE_SHOTS.shots.map((shot: ConsoleShot) => (
          <figure key={shot.id} className={s.shot}>
            <a className={s.shotImage} href={shot.src}>
              <Image
                src={shot.src}
                width={shot.width}
                height={shot.height}
                alt={shot.alt}
                sizes="(max-width: 760px) 86vw, 420px"
              />
            </a>
            <figcaption>
              <h3>{shot.title}</h3>
              <p>
                <Rich text={shot.body} />
              </p>
              <p className={s.shotMeta}>
                {shot.meta}
                {shot.link ? (
                  <>
                    {" · "}
                    <ExternalLink className={s.link} href={shot.link.url}>
                      {shot.link.label}
                    </ExternalLink>
                  </>
                ) : null}
              </p>
            </figcaption>
          </figure>
        ))}
      </ScrollRegion>
      <p className={s.shotProof}>
        {CONSOLE_SHOTS.proof.text}{" "}
        <Link className={s.link} href={CONSOLE_SHOTS.proof.href}>
          {CONSOLE_SHOTS.proof.label}
        </Link>
      </p>
      <div className={s.cta}>
        <Link className={`${s.btn} ${s.solid}`} href={CONSOLE_SHOTS.open.href}>
          {CONSOLE_SHOTS.open.label}
        </Link>
      </div>
    </LandingSection>
  );
}
