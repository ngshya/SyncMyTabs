// The new tab page's optional bookmarks bar (newtab-bookmarks.js) in a
// real browser: off by default, on from the options card, overflow,
// menus and submenus, keyboard, clicks, stickiness, look.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, SKIP, sleep } = require("./helpers.js");

describe("bookmarks bar", { skip: SKIP }, () => {
  let b;
  let p;

  before(async () => {
    b = await launch();
    for (const u of ["https://github.example/", "https://mail.example/"]) await b.openSite(u);
    await b.closeStrayPages();
    const barId = await b.bookmarksBarId();
    await b.bg(async (barId) => {
      const add = (parentId, title, url) => chrome.bookmarks.create({ parentId, title, url });
      await add(barId, "GitHub", "https://github.example/");
      await add(barId, "Mail", "https://mail.example/");
      const work = await add(barId, "Work");
      await add(work.id, "Calendar", "https://calendar.example/");
      const arch = await add(work.id, "Archive");
      await add(arch.id, "Notes", "https://notes.example/");
      await add(barId, "Bookmarklet", "javascript:alert(1)");
      for (let i = 1; i <= 14; i++) await add(barId, `A rather long bookmark title number ${i}`, `https://long.example/${i}`);
    }, barId);
    await sleep(300);
    p = await b.openNewtab();
  });
  after(() => b && b.close());

  test("hidden by default; turned on from the options card, live", async () => {
    assert.equal(await p.evaluate(() => document.getElementById("bookmarksBar").hidden), true);
    const opt = await b.openPage("options.html");
    await opt.getByLabel(/Bookmarks bar at the top/).check();
    await opt.close();
    await p.bringToFront();
    await p.waitForSelector("#bookmarksBar:not([hidden])", { timeout: 3000 });
  });

  test("bar content: order kept, bookmarklet dropped, icons from open tabs, the rest under »", async () => {
    await sleep(300);
    const bar = await p.evaluate(() => ({
      visible: Array.from(document.querySelectorAll(".bm-items > *")).filter((n) => !n.hidden && !n.classList.contains("bm-more")).map((n) => n.textContent.replace(/^[A-Z](?=[A-Z])/, "")),
      more: !document.querySelector(".bm-more").hidden,
      icons: document.querySelectorAll(".bm-items img.icon").length,
    }));
    assert.deepEqual(bar.visible.slice(0, 3), ["GitHub", "Mail", "Work"]);
    assert.ok(!bar.visible.includes("Bookmarklet"));
    assert.equal(bar.more, true);
    assert.equal(bar.icons, 2, "GitHub and Mail are open, so they have icons");
  });

  test("centred, translucent until hovered", async () => {
    const geo = await p.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".bm-items > *")).filter((n) => !n.hidden);
      const l = items[0].getBoundingClientRect(), r = items[items.length - 1].getBoundingClientRect();
      return { left: l.left, right: innerWidth - r.right, opacity: getComputedStyle(document.querySelector(".bm-items")).opacity };
    });
    assert.ok(Math.abs(geo.left - geo.right) < 40, `centred (${geo.left} vs ${geo.right})`);
    assert.equal(geo.opacity, "0.45");
    await p.hover(".bm-items > a");
    await sleep(300);
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".bm-items")).opacity), "1");
  });

  test("folder menus, nested submenus on hover, closed by a click elsewhere", async () => {
    await p.click(".bm-items .bm-folder:has-text('Work')");
    await p.hover(".bm-menu .bm-folder:has-text('Archive')");
    await sleep(400);
    const menus = await p.evaluate(() => Array.from(document.querySelectorAll(".bm-menu")).map((m) => Array.from(m.querySelectorAll(".bm-title")).map((t) => t.textContent)));
    assert.deepEqual(menus, [["Calendar", "Archive"], ["Notes"]]);
    await p.mouse.click(640, 700);
    assert.equal(await p.locator(".bm-menu").count(), 0);
  });

  test("keyboard: ←/→ along the bar, ↓ into a folder, → into a subfolder, Esc back out", async () => {
    const focused = () => p.evaluate(() => (document.activeElement.querySelector(".bm-title") || document.activeElement).textContent);
    await p.focus(".bm-items > a");
    await p.keyboard.press("ArrowRight");
    await p.keyboard.press("ArrowRight");
    assert.equal(await focused(), "Work");
    await p.keyboard.press("ArrowDown");
    assert.equal(await focused(), "Calendar");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowRight");
    assert.equal(await focused(), "Notes");
    await p.keyboard.press("Escape");
    assert.equal(await focused(), "Archive");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    assert.equal(await p.evaluate(() => document.activeElement.id), "search", "Esc on an idle bar goes back to search");
  });

  test("sticky above the search bar when scrolled", async () => {
    await b.bg(async () => {
      for (let i = 0; i < 40; i++) await chrome.tabs.create({ url: `https://filler.example/${i}`, active: false });
    });
    await sleep(1200);
    await p.evaluate(() => scrollTo(0, 900));
    await sleep(200);
    const pos = await p.evaluate(() => ({ bar: document.getElementById("bookmarksBar").getBoundingClientRect().top, search: Math.round(document.getElementById("searchBar").getBoundingClientRect().top), h: document.getElementById("bookmarksBar").offsetHeight }));
    assert.equal(pos.bar, 0);
    assert.equal(pos.search, pos.h);
    await p.evaluate(() => scrollTo(0, 0));
  });

  test("Ctrl-click opens a background tab; a plain click opens here", async () => {
    const before = await b.bg(async () => (await chrome.tabs.query({})).length);
    await p.click(".bm-items a[title^='Mail']", { modifiers: ["Control"] });
    await sleep(600);
    const after = await b.bg(async () => (await chrome.tabs.query({})).length);
    assert.equal(after - before, 1);
    const navigated = p.waitForURL(/github\.example/, { timeout: 4000 }).then(() => true, () => false);
    await p.click(".bm-items a[title^='GitHub']");
    assert.equal(await navigated, true);
    assert.deepEqual(b.errors, []);
  });
});
