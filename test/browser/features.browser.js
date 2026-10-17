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

  test("focusSearch: the page reopens as newtab.html?focus with the search box focused; off → stays put", async () => {
    await b.setSettings({ focusSearch: true });
    const p = await b.openNewtab({ waitFor: null });
    await p.waitForURL(/newtab\.html\?focus$/, { timeout: 5000 });
    await p.waitForSelector(".item");
    await sleep(200);
    assert.equal(await p.evaluate(() => document.activeElement.id), "search");
    assert.ok(!(await p.locator(".item .title", { hasText: /newtab|New Tab/ }).count()), "the page doesn't list itself");
    await p.close();

    await b.setSettings({ focusSearch: false });
    const q = await b.openNewtab();
    await sleep(500);
    assert.doesNotMatch(q.url(), /\?focus/, "no redirect");
    await q.close();
  });

  test("options card: two groups, seven settings, defaults as documented", async () => {
    const opt = await b.openPage("options.html");
    await sleep(500);
    const card = await opt.locator(".card").last().evaluate((c) => Array.from(c.querySelectorAll(".section-title, label")).map((n) => (n.querySelector("input") ? (n.querySelector("input").checked ? "x" : "-") : "#") + n.textContent.trim().split(" ")[0]));
    assert.deepEqual(card, ["#Show", "xTabs", "xTabs", "xTabs", "-Bookmarks", "#Look", "xSeconds", "x24-hour", "-Put", "-Matrix"]);
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
