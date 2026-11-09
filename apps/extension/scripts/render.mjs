import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, ROOT } from "./build.mjs";

// Renders the icons and the Chrome Web Store images with a local headless Chrome, through the DevTools protocol
// (Node's own WebSocket). Run it where Chrome is installed, look at what it wrote, and commit it. CI never runs it.
//   static/icons/{16,32,48,128}.png         apps/web/src/app/icon.svg, transparent around it (render/icon.html)
//   store/screenshots/{popup,menu,connect}.jpg  1280 x 800 (store/preview/*.html)
//   store/screenshots/tile.jpg              440 x 280
// The store images are JPEG: the store refuses a PNG with an alpha channel.

const CHROMES = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

async function launch() {
  const chrome = CHROMES.find((p) => p && existsSync(p));
  if (!chrome) throw new Error("No Chrome found. Set CHROME_PATH to chrome.exe.");
  const profile = mkdtempSync(join(tmpdir(), "probarion-render-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const url = await new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start within 20 s")), 20_000);
    child.stderr.on("data", (chunk) => {
      seen += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`Chrome exited (${code})`)));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id === undefined) {
      for (const listener of [...events]) listener(msg);
      return;
    }
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w?.reject(new Error(`${msg.error.message}`));
    else w?.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      next += 1;
      waiting.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params, sessionId }));
    });
  const once = (method, sessionId) =>
    new Promise((resolve) => {
      const listener = (m) => {
        if (m.method !== method || m.sessionId !== sessionId) return;
        events.splice(events.indexOf(listener), 1);
        resolve(m.params);
      };
      events.push(listener);
    });
  const close = async () => {
    await send("Browser.close").catch(() => {});
    ws.close();
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    child.kill();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      // Chrome's helper processes can hold the profile for a moment on Windows. It is a temp folder.
    }
  };
  return { send, once, close };
}

/** Opens `url` at width x height and writes what it shows to `out`, as PNG (transparent) or JPEG. */
async function shoot(b, url, out, width, height, format) {
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  await b.send("Page.enable", {}, sessionId);
  await b.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  if (format === "png") {
    await b.send(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
      sessionId,
    );
  }
  const loaded = b.once("Page.loadEventFired", sessionId);
  await b.send("Page.navigate", { url }, sessionId);
  await loaded;
  await new Promise((r) => setTimeout(r, 500)); // the popup renders once its (fake) storage has answered
  const { data } = await b.send(
    "Page.captureScreenshot",
    {
      format,
      quality: format === "jpeg" ? 92 : undefined,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    },
    sessionId,
  );
  writeFileSync(out, Buffer.from(data, "base64"));
  await b.send("Target.closeTarget", { targetId });
  console.log(`wrote ${out}`);
}

const page = (path) => pathToFileURL(join(ROOT, path)).href;
const b = await launch();
try {
  mkdirSync(join(ROOT, "static/icons"), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await shoot(
      b,
      `${page("render/icon.html")}?size=${size}`,
      join(ROOT, `static/icons/${size}.png`),
      size,
      size,
      "png",
    );
  }
  await build({ dev: false });
  mkdirSync(join(ROOT, "store/screenshots"), { recursive: true });
  for (const name of ["popup", "menu", "connect"]) {
    await shoot(
      b,
      page(`store/preview/${name}.html`),
      join(ROOT, `store/screenshots/${name}.jpg`),
      1280,
      800,
      "jpeg",
    );
  }
  await shoot(
    b,
    page("store/preview/tile.html"),
    join(ROOT, "store/screenshots/tile.jpg"),
    440,
    280,
    "jpeg",
  );
} finally {
  await b.close();
}
