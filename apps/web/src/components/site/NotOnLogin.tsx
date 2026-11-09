"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** True on the sign-in page, where a link to the console leads to /console and straight back to /login. */
export function onLoginPage(pathname: string | null): boolean {
  return pathname === "/login" || pathname === "/login/";
}

/** Its children on every page but the sign-in page. Before the path is known it shows them. */
export function NotOnLogin({ children }: { children: ReactNode }) {
  return onLoginPage(usePathname()) ? null : children;
}
