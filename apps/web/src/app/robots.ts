import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/console", "/api"] },
    sitemap: `${appOrigin()}/sitemap.xml`,
  };
}
