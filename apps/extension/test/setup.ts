import { offeredFor, PROD_ORIGINS } from "../scripts/manifest.mjs";

// esbuild writes the origins into the bundle (scripts/build.mjs); the tests trust the production list.
(globalThis as { __ORIGINS__?: readonly string[] }).__ORIGINS__ = PROD_ORIGINS;
(globalThis as { __OFFERED__?: readonly string[] }).__OFFERED__ = offeredFor(false);

// No test reaches the network: each one passes its own fake fetch.
globalThis.fetch = () => Promise.reject(new Error("the tests never reach the network"));
