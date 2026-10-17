// New tab page extras in a real browser: search-box focus redirect, clock
// (bold, seconds), Matrix rain (dark only, off with reduced motion), and
// the options card that sets them.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, SKIP, sleep } = require("./helpers.js");

describe("new tab page extras", { skip: SKIP }, () => {
  let b;

  before(async () => {
    b = await launch();
    await b.openSite("https://one.example/");
    await b.closeStrayPages();
  });
  after(() => b && b.close());

  test("focusSearch: the page reopens itself as a new tab (same place) with ?focus and closes the original; off → stays put", async () => {
    await b.setSettings({ focusSearch: true });
    const tabsBefore = await b.bg(async () => (await chrome.tabs.query({})).length);
    const reborn = b.ctx.waitForEvent("page", { predicate: (pg) => /newtab\.html\?focus$/.test(pg.url()), timeout: 5000 });
    const p = await b.openNewtab({ waitFor: null });
    const indexBefore = await b.bg(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].index);
    const q = await reborn;
    await q.waitForSelector(".item");
    await sleep(300);
    assert.equal(p.isClosed(), true, "the original new tab is closed");
    assert.equal(await q.evaluate(() => document.activeElement.id), "search");
    const after = await b.bg(async () => {
      const all = await chrome.tabs.query({});
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return { count: all.length, index: active.index, url: active.url };
    });
    assert.equal(after.count, tabsBefore + 1, "one new tab page, not two");
    assert.equal(after.index, indexBefore, "same place in the tab strip");
    assert.match(after.url, /newtab\.html\?focus$/);
    assert.ok(!(await q.locator(".item .title", { hasText: /newtab|New Tab/ }).count()), "the page doesn't list itself");
    await q.close();

    await b.setSettings({ focusSearch: false });
    const r = await b.openNewtab();
    await sleep(500);
    assert.equal(r.isClosed(), false);
    assert.doesNotMatch(r.url(), /\?focus/, "no redirect");
    await r.close();
  });

  test("options card: two groups, eight settings, defaults as documented", async () => {
    const opt = await b.openPage("options.html");
    await sleep(500);
    const mark = (input) => (input.type === "number" ? `=${input.value}:` : input.checked ? "x" : "-");
    const card = await opt.locator(".card").last().evaluate((c, markSrc) => {
      const mark = eval(markSrc);
      return Array.from(c.querySelectorAll(".section-title, label")).map((n) => (n.querySelector("input") ? mark(n.querySelector("input")) : "#") + n.textContent.trim().split(" ")[0]);
    }, mark.toString());
    assert.deepEqual(card, ["#Show", "xTabs", "xTabs", "xTabs", "=7:Auto-archived", "-Bookmarks", "#Look", "xSeconds", "x24-hour", "-Put", "-Matrix"]);
    await opt.close();
  });

  test("clock: bold, 24-hour with seconds by default; both settings apply live", async () => {
    const p = await b.openNewtab();
    const time = () => p.evaluate(() => document.getElementById("time").textContent);
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById("time")).fontWeight), "600");
    assert.match(await time(), /^\d{2}:\d{2}:\d{2}$/, "HH:MM:SS, even in an English (AM/PM) browser");
    await b.setSettings({ clockSeconds: false });
    await sleep(500);
    assert.match(await time(), /^\d{2}:\d{2}$/);
    await b.setSettings({ clock24h: false });
    await sleep(500);
    assert.match(await time(), /^\d{1,2}:\d{2}\s?(AM|PM)$/, "the browser language's own format (English here)");
    await p.close();
  });

  test("Matrix rain: never on a light page, drawn on dark and black, gone when off", async () => {
    await b.setSettings({ matrixRain: true });
    await b.setStorage({ themePreference: "light" });
    const p = await b.openNewtab();
    const rain = () =>
      p.evaluate(() => {
        const c = document.getElementById("matrix");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
        return { hidden: c.hidden, painted };
      });
    await sleep(500);
    assert.equal((await rain()).hidden, true);
    await b.setStorage({ themePreference: "dark" });
    await sleep(1200);
    let r = await rain();
    assert.equal(r.hidden, false);
    assert.ok(r.painted > 1000, "something is drawn");
    await b.setStorage({ themePreference: "black" });
    await sleep(500);
    assert.equal((await rain()).hidden, false);
    await b.setSettings({ matrixRain: false });
    await sleep(500);
    assert.equal((await rain()).hidden, true);
    await p.close();
  });

  test("Matrix rain stays off for reduced motion", async () => {
    await b.setSettings({ matrixRain: true });
    const p = await b.ctx.newPage();
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.goto("chrome://newtab/");
    await p.waitForSelector(".item");
    await sleep(800);
    assert.equal(await p.evaluate(() => document.getElementById("matrix").hidden), true);
    await p.close();
    assert.deepEqual(b.errors, []);
  });
});
