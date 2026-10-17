// Web search from the new tab page's box (newtab-search.js + newtab.js)
// in a real browser: the browser's default engine, one-letter prefixes,
// Tab cycling, addresses, and that tab search/numbers still come first.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, SKIP, sleep } = require("./helpers.js");

describe("web search", { skip: SKIP }, () => {
  let b;

  before(async () => {
    b = await launch({ titles: { "https://news.example/": "Hacker News" } });
    await b.openSite("https://news.example/");
    await b.closeStrayPages();
  });
  after(() => b && b.close());

  const state = (p) =>
    p.evaluate(() => ({
      value: document.getElementById("search").value,
      chip: document.getElementById("searchChip").hidden ? null : document.getElementById("searchChip").textContent,
      web: (document.querySelector("#webActions .item.web .title") || {}).textContent || null,
      selected: (document.querySelector("main .item.selected .title") || {}).textContent || null,
      tabRows: document.querySelectorAll("#local .item").length,
    }));

  // Types `text`, presses `key`, returns where the new tab page went.
  async function goes(text, key = "Enter") {
    const p = await b.openNewtab();
    await p.keyboard.type(text);
    await p.keyboard.press(key);
    await p.waitForURL(/^https?:/, { timeout: 4000 }).catch(() => {});
    const url = p.url();
    await p.close();
    return url;
  }

  test("a matching tab stays selected; the web row is offered for Shift+Enter", async () => {
    const p = await b.openNewtab();
    await p.keyboard.type("hacker");
    const s = await state(p);
    assert.equal(s.selected, "Hacker News");
    assert.equal(s.web, "Search the web for “hacker”");
    await p.close();
  });

  test("Tab / Shift+Tab cycle the services and back to tab search", async () => {
    const p = await b.openNewtab();
    await p.keyboard.type("hacker");
    await p.keyboard.press("Tab");
    assert.equal((await state(p)).chip, "Google");
    await p.keyboard.press("Tab");
    assert.equal((await state(p)).chip, "Maps");
    await p.keyboard.press("Shift+Tab");
    await p.keyboard.press("Shift+Tab");
    const s = await state(p);
    assert.equal(s.chip, null);
    assert.equal(s.selected, "Hacker News");
    await p.close();
  });

  test("a letter + space becomes a service chip; Backspace gives the letter back for good", async () => {
    const p = await b.openNewtab();
    await p.keyboard.type("y lofi");
    let s = await state(p);
    assert.deepEqual([s.chip, s.value, s.tabRows], ["YouTube", "lofi", 0]);
    await p.keyboard.press("Escape");
    await p.keyboard.type("c ");
    await p.keyboard.press("Backspace");
    await p.keyboard.type(" programming");
    s = await state(p);
    assert.deepEqual([s.chip, s.value], [null, "c programming"]);
    await p.close();
  });

  test("addresses and numbers", async () => {
    const p = await b.openNewtab();
    await p.keyboard.type("example.org/path");
    assert.equal((await state(p)).web, "Open example.org/path");
    await p.keyboard.press("Escape");
    await p.keyboard.type("1");
    assert.equal((await state(p)).selected, "Hacker News");
    await p.close();
  });

  test("where Enter goes", async () => {
    assert.match(await goes("ricetta carbonara"), /^https:\/\/www\.google\.com\/search\?q=ricetta\+carbonara/, "no tab match → browser's default engine");
    assert.match(await goes("hacker", "Shift+Enter"), /google\.com\/search\?q=hacker/, "Shift+Enter → web even with a tab match");
    assert.equal(await goes("m colosseo"), "https://www.google.com/maps/search/?api=1&query=colosseo");
    assert.equal(await goes("y lofi beats"), "https://www.youtube.com/results?search_query=lofi%20beats");
    assert.equal(await goes("example.org/path"), "https://example.org/path");
  });

  test("clicking a service", async () => {
    const p = await b.openNewtab();
    await p.keyboard.type("roma");
    await p.click(".engine:has-text('Wikipedia')");
    await p.waitForURL(/wikipedia/, { timeout: 4000 });
    assert.match(p.url(), /search-redirect\.php\?family=wikipedia&language=[a-z]+&search=roma/);
    await sleep(100);
    assert.deepEqual(b.errors, []);
  });
});
