// ============================================================
// SyncMyTabs - scripts/screenshots.js
//
// Screenshots of the new tab page, popup and options page for a quick
// visual check — the same browser setup as the browser tests
// (test/browser/helpers.js: the built package, a fake web), with a
// believable session: two windows, tab groups (one folded), a pinned tab,
// a few auto-archived tabs, a bookmarks bar.
//
//   npm run screenshots -- [outDir]          (default: ./screenshots)
//
// Writes newtab-{light,dark,black}.png, newtab-search.png,
// newtab-narrow.png, popup.png, options-newtab-card.png, plus the Chrome
// Web Store listing's new tab page shots in store/ (see the end of this
// file; store-assets/README.md says which ones are in the listing).
// ============================================================

const fs = require("node:fs");
const path = require("node:path");
const { launch, SKIP, sleep } = require("../test/browser/helpers.js");

const SITES = {
  "https://github.example/ngshya/SyncMyTabs": "ngshya/SyncMyTabs — Sync your open tabs across devices",
  "https://mail.example/inbox": "Inbox (4) — Mail",
  "https://calendar.example/week": "Calendar — Week of 12 October",
  "https://docs.example/spec": "SyncMyTabs v5 spec — Docs",
  "https://design.example/newtab": "New tab mockup — Design",
  "https://notes.example/roadmap": "Roadmap Q4",
  "https://news.example/": "Hacker News",
  "https://video.example/lofi": "lofi hip hop radio — beats to relax/study to",
  "https://wiki.example/WebExtensions": "WebExtensions — Wikipedia",
  "https://shop.example/keyboard": "Mechanical keyboards — Shop",
};

(async () => {
  if (SKIP) {
    console.error(SKIP);
    process.exit(1);
  }
  const outDir = path.resolve(process.argv[2] || "screenshots");
  fs.mkdirSync(outDir, { recursive: true });
  const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(outDir, name), ...opts });

  const b = await launch({ titles: SITES, viewport: { width: 1440, height: 900 } });
  const urls = Object.keys(SITES);
  for (const url of urls.slice(0, 9)) await b.openSite(url);
  await b.closeStrayPages();
  await b.bg(async (second) => {
    const tabs = await chrome.tabs.query({});
    const id = (host) => tabs.find((t) => t.url.includes(host)).id;
    await chrome.tabs.update(id("github.example"), { pinned: true });
    const work = await chrome.tabs.group({ tabIds: [id("mail.example"), id("calendar.example"), id("docs.example")] });
    await chrome.tabGroups.update(work, { title: "Work", color: "blue" });
    const proj = await chrome.tabs.group({ tabIds: [id("design.example"), id("notes.example")] });
    await chrome.tabGroups.update(proj, { title: "Project", color: "green", collapsed: true });
    await chrome.tabs.move(id("news.example"), { index: 4 });
    await chrome.windows.create({ url: second, focused: false });
  }, urls.slice(9));
  await b.addArchivedTab("Best mechanical keyboards of 2026 — Review", "https://review.example/keyboards", 0);
  await b.addArchivedTab("How bookmarks sync works — Blog", "https://blog.example/bookmark-sync", 2);
  await b.addArchivedTab("Flight deals — Travel", "https://travel.example/flights", 2);
  const barId = await b.bookmarksBarId();
  await b.bg(async (barId) => {
    for (const [t, u] of [["GitHub", "https://github.example/"], ["Mail", "https://mail.example/"], ["News", "https://news.example/"]]) {
      await chrome.bookmarks.create({ parentId: barId, title: t, url: u });
    }
    const f = await chrome.bookmarks.create({ parentId: barId, title: "Work" });
    await chrome.bookmarks.create({ parentId: f.id, title: "Docs", url: "https://docs.example/" });
  }, barId);
  await b.setSettings({ bookmarksBar: true });
  await sleep(1000);

  const p = await b.openNewtab();
  await p.waitForSelector("#archivedSection:not([hidden])", { timeout: 8000 }).catch(() => {});
  await sleep(600);
  await p.evaluate(() => document.activeElement.blur());
  for (const theme of ["light", "dark", "black"]) {
    await b.setStorage({ themePreference: theme });
    await sleep(500);
    await shot(p, `newtab-${theme}.png`, { fullPage: true });
  }
  await b.setStorage({ themePreference: "light" });
  await p.focus("#search");
  await p.keyboard.type("y lofi");
  await sleep(300);
  await shot(p, "newtab-search.png");
  await p.keyboard.press("Escape");
  await p.setViewportSize({ width: 820, height: 900 });
  await p.evaluate(() => document.activeElement.blur());
  await sleep(300);
  await shot(p, "newtab-narrow.png", { fullPage: true });

  const pop = await b.openPage("popup.html");
  await pop.setViewportSize({ width: 360, height: 520 });
  await sleep(500);
  await shot(pop, "popup.png");
  const opt = await b.openPage("options.html");
  await sleep(500);
  await opt.locator(".card").last().screenshot({ path: path.join(outDir, "options-newtab-card.png") });
  // Not left open: they'd show up in the store shots' tab list below.
  await pop.close();
  await opt.close();
  await p.close();

  // Chrome Web Store listing shots: exactly 1280×800 and JPEG — the store
  // rejects a PNG with an alpha channel — with the page zoomed out a
  // little so the whole list, archived tabs included, fits in one screen.
  const storeDir = path.join(outDir, "store");
  fs.mkdirSync(storeDir, { recursive: true });
  const storeShot = (page, name) => page.screenshot({ path: path.join(storeDir, name), type: "jpeg", quality: 92 });
  const st = await b.openNewtab();
  await st.setViewportSize({ width: 1280, height: 800 });
  await st.waitForSelector("#archivedSection:not([hidden])", { timeout: 8000 }).catch(() => {});
  await st.evaluate(() => {
    document.body.style.zoom = "0.8";
    document.activeElement.blur();
  });
  for (const theme of ["dark", "light"]) {
    await b.setStorage({ themePreference: theme });
    await sleep(500);
    await storeShot(st, `newtab-${theme}-1280x800.jpg`);
  }
  // With the optional Matrix rain, on the two themes it's drawn on —
  // given a few seconds so the columns have filled the screen.
  await b.setSettings({ matrixRain: true });
  for (const theme of ["dark", "black"]) {
    await b.setStorage({ themePreference: theme });
    await sleep(4000);
    await storeShot(st, `newtab-matrix-${theme}-1280x800.jpg`);
  }
  await b.setSettings({ matrixRain: false });
  await b.setStorage({ themePreference: "system" });

  await b.close();
  if (b.errors.length) console.error("page errors:\n" + b.errors.join("\n"));
  console.log(`screenshots in ${outDir}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
