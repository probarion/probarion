import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPage } from "@/lib/docs/content";
import { findPage, pathFromSlug, slugParams } from "@/lib/docs/registry";

export function generateStaticParams() {
  return slugParams();
}

export async function generateMetadata({
  params,
}: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const page = findPage(pathFromSlug((await params).slug));
  if (!page) return { title: "Page not found", robots: { index: false } };
  return { title: { absolute: `${page.title} · Probarion Docs` }, description: page.description };
}

export default async function DocsPage({ params }: PageProps<"/docs/[[...slug]]">) {
  const page = findPage(pathFromSlug((await params).slug));
  if (!page) notFound();
  const Content = await loadPage(page.path);
  return (
    <article>
      <h1>{page.title}</h1>
      <Content />
    </article>
  );
}
