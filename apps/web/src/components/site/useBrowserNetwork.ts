"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Network } from "@/lib/config";
import {
  type NetworkSwitchModel,
  networkForHost,
  networkSwitch,
  publicRouting,
} from "@/lib/site/network";

// The static pages (the landing page, the footer, the header) are built once and cannot know which address they are
// served at, so the network comes from the browser: the address bar's host, read after mount, against the public map that
// next.config.ts builds from the same settings the server reads. Before mount there is no network (the server render says
// nothing that is network specific), and nothing here ever guesses one.

/** The address bar's host, or null before mount (and on the server). */
function useMountedHost(): string | null {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => {
    setHost(window.location.host);
  }, []);
  return host;
}

/** The network of the address this page is open at: null before mount. */
export function useBrowserNetwork(): Network | null {
  const host = useMountedHost();
  return host === null ? null : networkForHost(host, publicRouting());
}

/**
 * The header's network switch: the current network and a link to the other one's address, or null before mount and when
 * the other network is not served. The link keeps the page's path (a vault page goes to the list).
 */
export function useNetworkSwitch(): NetworkSwitchModel | null {
  const host = useMountedHost();
  const pathname = usePathname();
  return host === null ? null : networkSwitch(host, pathname ?? "/", publicRouting());
}
