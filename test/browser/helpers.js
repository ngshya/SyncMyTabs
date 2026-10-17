// ============================================================
// Shared setup for the browser tests (test/browser/*.browser.js) — the
// real extension in a real headless Chromium, via Playwright:
//
//   npm run test:browser
//
// What it does, so each test file doesn't redo it:
//   - builds the Chrome package with scripts/build.js (once per run), so
//     the tests load exactly what ships — not the repo folder, which
//     always has every file and so hides one missing from the package;
//   - launches Chromium with only that extension loaded (`channel:
//     "chromium"` — the default headless shell can't load extensions);
//   - fakes the whole web with Playwright request interception: every
//     http(s) page is a tiny local page whose <title> comes from `titles`
//     (or is the host), with a small PNG favicon — no network, no
//     certificates. (A tab the extension itself opens with tabs.create can
//     slip past interception for its first load: open test sites with
//     `openSite`, not chrome.tabs.create.)
//   - collects page errors/console errors from every page it opens.
//
// Playwright isn't a dependency of this repo (there's no build step and
// no runtime dependency at all): it's found via NODE_PATH or a global
// install. Without it, every browser test is skipped with a hint.
// ============================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("../../scripts/build.js");

function loadPlaywright() {
  const candidates = ["playwright", "/opt/node-tools/node_modules/playwright"];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {}
  }
  return null;
}
const playwright = loadPlaywright();
const SKIP = playwright
  ? false
  : "Playwright not found — install it (npm i -g playwright) or set NODE_PATH to where it is";

let builtDir = null;
function extensionDir() {
  if (!builtDir) builtDir = build(fs.mkdtempSync(path.join(os.tmpdir(), "syncmytabs-build-"))).chrome;
  return builtDir;
}

// A real 16×16 solid-colour PNG, encoded here — enough for "this tab has
// a favicon".
const FAVICON = (function solidPng(size, [r, g, b]) {
  const zlib = require("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})(16, [37, 99, 235]);
const FAVICON_DATA_URL = `data:image/png;base64,${FAVICON.toString("base64")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// options: { viewport, titles: { "https://host/path": "Title" }, storage,
//            args: extra Chromium args, env }
async function launch(options = {}) {
  const extDir = extensionDir();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "syncmytabs-profile-"));
  const ctx = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: options.viewport || { width: 1280, height: 860 },
    env: options.env ? { ...process.env, ...options.env } : undefined,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-proxy-server", ...(options.args || [])],
  });
  const titles = options.titles || {};
  await ctx.route(/^https?:\/\//, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/favicon.ico") return route.fulfill({ contentType: "image/png", body: FAVICON });
    const key = Object.keys(titles).find((k) => k.split("#")[0] === u.href);
    const title = (key && titles[key]) || u.host;
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      // A data: icon: the browser fetches a page's favicon itself, outside
      // request interception — /favicon.ico above is only a fallback.
      body: `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${FAVICON_DATA_URL}"><h1>${title}</h1>`,
    });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const errors = [];
  const watch = (page, label = "") => {
    page.on("pageerror", (e) => errors.push(`${label}${e}`));
    page.on("console", (m) => {
      // Fake sites' own failed subresources aren't the extension's errors.
      if (m.type() === "error" && page.url().startsWith("chrome-extension://")) errors.push(`${label}${m.text()}`);
    });
    return page;
  };

  // Tests run with the search-box focus redirect off unless they ask for
  // it: it reloads the page right after it opens, which would race every
  // other test's first look at the page.
  await sw.evaluate(
    (storage) => chrome.storage.local.set(storage),
    { deviceName: "Laptop", newtabSections: { focusSearch: false }, ...(options.storage || {}) }
  );

  const b = {
    ctx,
    sw,
    extId,
    errors,
    url: (file) => `chrome-extension://${extId}/${file}`,
    // Runs `fn` in the background service worker (chrome.* available).
    bg: (fn, arg) => sw.evaluate(fn, arg),
    setStorage: (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj),
    async setSettings(changes) {
      await sw.evaluate(async (c) => {
        const { newtabSections: s } = await chrome.storage.local.get("newtabSections");
        await chrome.storage.local.set({ newtabSections: { ...(s || {}), ...c } });
      }, changes);
    },
    async openSite(url) {
      const p = await ctx.newPage();
      await p.goto(url);
      return p;
    },
    // Closes the blank/first-run tabs the browser and extension open on
    // launch, so a test's tab list is only what it opened.
    async closeStrayPages() {
      for (const p of ctx.pages()) if (!/^https?:/.test(p.url())) await p.close().catch(() => {});
    },
    async openNewtab({ waitFor = ".item" } = {}) {
      const p = watch(await ctx.newPage(), "newtab: ");
      await p.goto("chrome://newtab/");
      if (waitFor) await p.waitForSelector(waitFor);
      await sleep(300);
      return p;
    },
    async openPage(file) {
      const p = watch(await ctx.newPage(), `${file}: `);
      await p.goto(`chrome-extension://${extId}/${file}`);
      return p;
    },
    // Waits until the extension has created SyncMyTabs/default (sync's
    // first reconcile) and returns that profile folder's id.
    async profileFolderId() {
      return sw.evaluate(async () => {
        for (let i = 0; i < 50; i++) {
          const [root] = await chrome.bookmarks.search({ title: "SyncMyTabs" });
          const profile = root && (await chrome.bookmarks.getChildren(root.id)).find((k) => k.title === "default" && !k.url);
          if (profile) return profile.id;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error("profile folder never appeared");
      });
    },
    // Writes a fake OTHER device's open tab into the synced tree, exactly
    // the way sync-core.js writes one: <profile>/<url folder>/{_url, <device>}.
    // Retried: sync's own reconcile may be reorganizing that same folder
    // at that moment (a folder vanishing under us reads as "Can't find
    // bookmark for id").
    async addRemoteTab(device, title, url, ageMinutes = 0) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await b._addRemoteTab(device, title, url, ageMinutes);
        } catch (e) {
          if (attempt >= 5) throw e;
          await sleep(300);
        }
      }
    },
    async _addRemoteTab(device, title, url, ageMinutes) {
      const profileId = await b.profileFolderId();
      await sw.evaluate(
        async ({ profileId, device, title, url, ageMinutes }) => {
          let folder = null;
          for (const k of await chrome.bookmarks.getChildren(profileId)) {
            if (k.url) continue;
            const inner = await chrome.bookmarks.getChildren(k.id);
            if (inner.some((x) => x.title === "_url" && x.url === url)) folder = k;
          }
          if (!folder) {
            folder = await chrome.bookmarks.create({ parentId: profileId, title });
            await chrome.bookmarks.create({ parentId: folder.id, title: "_url", url });
          }
          const t = Date.now() - ageMinutes * 60000;
          await chrome.bookmarks.create({ parentId: folder.id, title: device, url: `https://syncmytabs.local/status?s=open&t=${t}&h=${t}` });
        },
        { profileId, device, title, url, ageMinutes }
      );
    },
    async bookmarksBarId() {
      return sw.evaluate(async () => {
        const [root] = await chrome.bookmarks.getTree();
        const bar = root.children.find((c) => c.folderType === "bookmarks-bar") || root.children.find((c) => c.id === "1");
        return bar.id;
      });
    },
    close: () => ctx.close(),
  };
  return b;
}

module.exports = { launch, SKIP, sleep, playwright };
