import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { DocsBar } from "@/components/docs/DocsBar";
import d from "@/components/docs/docs.module.css";
import { Feedback } from "@/components/docs/Feedback";
import { HubHero } from "@/components/docs/hub";
import { PageHead } from "@/components/docs/PageHead";
import { Pager } from "@/components/docs/Pager";
import { Sidebar } from "@/components/docs/Sidebar";
import { SourceBox } from "@/components/docs/SourceBox";
import { Toc } from "@/components/docs/Toc";
import { TocDrop } from "@/components/docs/TocDrop";
import { appOrigin } from "@/lib/config";
import { buildCommit } from "@/lib/docs/build-info";
import { loadPage } from "@/lib/docs/content";
import { tocOf } from "@/lib/docs/headings";
import { docsJsonLd, docsMetadata } from "@/lib/docs/meta";
import { findPage, neighbours, pathFromSlug, slugParams, tabOf } from "@/lib/docs/registry";
import { readSource } from "@/lib/docs/source";
import { pageMarkdown, readingMinutes } from "@/lib/docs/twins";

// Known pages are built at build time. An unknown path renders on demand and calls notFound(),
// which shows app/docs/not-found.tsx with status 404 (dynamicParams stays at its default for that
// reason).
export function generateStaticParams() {
  return slugParams();
}

export async function generateMetadata({
  params,
}: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const page = findPage(pathFromSlug((await params).slug));
  return page ? docsMetadata(page) : { title: "Page not found", robots: { index: false } };
}

export default async function DocsPage({ params }: PageProps<"/docs/[[...slug]]">) {
  const page = findPage(pathFromSlug((await params).slug));
  if (!page) notFound();
  const origin = appOrigin();
  const [Content, source, markdown] = await Promise.all([
    loadPage(page.path),
    readSource(page.path),
    pageMarkdown(page, origin),
  ]);
  const jsonLd = (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD; docsJsonLd escapes every "<"
      dangerouslySetInnerHTML={{ __html: docsJsonLd(page, origin) }}
    />
  );
  if (page.path === "") {
    return (
      <>
        {jsonLd}
        <DocsBar current={null} path="" />
        <div className={d.home}>
          <HubHero page={page} />
          <div className={`${d.prose} ${d.hub}`}>
            <Content />
          </div>
        </div>
      </>
    );
  }
  const toc = tocOf(source);
  const { prev, next } = neighbours(page.path);
  return (
    <>
      {jsonLd}
      <DocsBar current={tabOf(page)} path={page.path} />
      <div className={d.shell}>
        <div className={d.side}>
          <Sidebar current={page.path} where="side" />
        </div>
        <article className={d.article}>
          <Breadcrumbs page={page} />
          {toc.length > 0 && <TocDrop items={toc} />}
          <PageHead page={page} minutes={readingMinutes(markdown)} markdown={markdown} />
          <div className={d.prose}>
            <Content />
          </div>
          <SourceBox page={page} commit={buildCommit()} />
          <Feedback page={page} origin={origin} />
          <Pager prev={prev} next={next} />
        </article>
        {toc.length > 0 && (
          <aside className={d.toc} aria-label="On this page">
            <p className={d.tocTitle}>On this page</p>
            <Toc items={toc} />
          </aside>
        )}
      </div>
    </>
  );
}
