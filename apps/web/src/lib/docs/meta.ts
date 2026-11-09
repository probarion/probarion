import type { Metadata } from "next";
import { OG_IMAGE } from "@/lib/site/facts";
import { docsHref } from "./registry";
import type { DocPage } from "./types";

export function docsTitle(page: DocPage): string {
  return page.path === "" ? "Probarion Docs" : `${page.title} · Probarion Docs`;
}

/**
 * Title, description, canonical address (on metadataBase, the app origin), Open Graph and the
 * Twitter card, both with the site image. Next merges metadata one key deep, so a page that left
 * out `twitter` would keep the root layout's title and description in its card.
 */
export function docsMetadata(page: DocPage): Metadata {
  const url = docsHref(page.path);
  return {
    title: { absolute: docsTitle(page) },
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      siteName: "Probarion",
      title: docsTitle(page),
      description: page.description,
      url,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: docsTitle(page),
      description: page.description,
      images: [OG_IMAGE],
    },
  };
}

/**
 * TechArticle and BreadcrumbList. Every "<" is escaped, so page text can never close the script
 * tag.
 */
export function docsJsonLd(page: DocPage, origin: string): string {
  const url = `${origin}${docsHref(page.path)}`;
  const crumbs =
    page.path === ""
      ? [{ name: "Docs", url }]
      : [
          { name: "Docs", url: `${origin}/docs` },
          { name: page.title, url },
        ];
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: page.title,
      description: page.description,
      url,
      inLanguage: "en",
      dateModified: page.reviewed,
      isPartOf: { "@type": "WebSite", name: "Probarion", url: origin },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, at) => ({
        "@type": "ListItem",
        position: at + 1,
        name: c.name,
        item: c.url,
      })),
    },
  ];
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
