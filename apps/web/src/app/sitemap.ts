import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/config";
import { publicRoutes } from "@/lib/site/facts";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes().map((route) => ({ url: `${appOrigin()}${route}` }));
}
