import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/config";
import { docsHref, PAGES } from "@/lib/docs/registry";
import { publicRoutes } from "@/lib/site/facts";

/** The public pages, then every docs page with the date it was last checked against the code. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = appOrigin();
  return [
    ...publicRoutes()
      .filter((route) => route !== "/docs")
      .map((route) => ({ url: `${origin}${route}` })),
    ...PAGES.map((p) => ({ url: `${origin}${docsHref(p.path)}`, lastModified: p.reviewed })),
  ];
}
