// The new tab page's main flow in a real browser: tab-strip order, groups
// and their fold state, numbers, search, two columns, other devices,
// closing from the list, settings applied live, switching to a tab.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, SKIP, sleep } = require("./helpers.js");

const SITES = {
  "https://github.com/ngshya/SyncMyTabs": "SyncMyTabs repo",
  "https://mail.example/inbox": "Inbox (3) — Mail",
  "https://calendar.example/week": "Calendar — Week of Oct 13",
  "https://docs.example/design": "Design doc: sync v5",
  "https://news.example/today": "Morning news digest",
  "https://recipes.example/pasta": "Weeknight pasta recipes",
};

describe("new tab page", { skip: SKIP }, () => {
  let b;
  let groups;

  before(async () => {
    b = await launch({ titles: SITES });
    for (const url of Object.keys(SITES)) await b.openSite(url);
    await b.closeStrayPages();
    groups = await b.bg(async () => {
      const tabs = await chrome.tabs.query({});
      const id = (host) => tabs.find((t) => t.url.includes(host)).id;
      const work = await chrome.tabs.group({ tabIds: [id("mail.example"), id("calendar.example")] });
      await chrome.tabGroups.update(work, { title: "Work", color: "blue" });
      // Research is the LAST tab, so docs + news sit between the two groups.
      const research = await chrome.tabs.group({ tabIds: [id("recipes.example")] });
      await chrome.tabGroups.update(research, { title: "Research", color: "green", collapsed: true });
      await chrome.tabs.update(id("github.com"), { pinned: true });
      return { work, research };
    });
    await b.addRemoteTab("Phone", "Train timetable", "https://trains.example/", 1);
    await b.addRemoteTab("Phone", "Morning news digest", "https://news.example/today", 2);
  });
  after(() => b && b.close());

  // The local list as text, in DOM order: "1 title", "[Group]" (+ "folded").
  const localList = (p) =>
    p.evaluate(() =>
      Array.from(document.querySelectorAll("#local .item, #local .group")).filter((n) => n.offsetParent !== null).map((n) =>
        n.classList.contains("group")
          ? `[${n.querySelector(".group-header span:nth-child(2)").textContent}${n.classList.contains("collapsed") ? " folded" : ""}]`
          : `${n.dataset.num} ${n.querySelector(".title").textContent}`
      )
    );

  test("tabs come in tab-strip order, groups where they sit, folded as in the browser", async () => {
    const p = await b.openNewtab();
    assert.deepEqual(await localList(p), [
      "1 SyncMyTabs repo",
      "[Work]",
      "2 Inbox (3) — Mail",
      "3 Calendar — Week of Oct 13",
      "4 Design doc: sync v5",
      "5 Morning news digest",
      "[Research folded]",
    ]);
    assert.equal(await p.evaluate(() => document.activeElement.id), "search", "search box focused");
    await p.close();
  });

  test("a click folds a group on the page until the browser's own state changes", async () => {
    const p = await b.openNewtab();
    const folded = () => p.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll(".group")).map((g) => [g.querySelector(".group-header span:nth-child(2)").textContent, g.classList.contains("collapsed")])));
    await p.click(`.group-header[data-key="g:${groups.work}"]`);
    await p.click(`.group-header[data-key="g:${groups.research}"]`);
    assert.deepEqual(await folded(), { Work: true, Research: false });
    await b.bg((id) => chrome.tabGroups.update(id, { collapsed: false }), groups.research);
    await sleep(500);
    await b.bg((id) => chrome.tabGroups.update(id, { collapsed: true }), groups.research);
    await sleep(500);
    assert.deepEqual(await folded(), { Work: true, Research: true }, "browser change wins for Research");
    await p.close();
  });

  test("numbers and text search select what Enter would open", async () => {
    const p = await b.openNewtab();
    const shown = () => p.evaluate(() => Array.from(document.querySelectorAll("main .item")).filter((n) => n.offsetParent && !n.classList.contains("web")).map((n) => `${n.dataset.num}${n.classList.contains("selected") ? "*" : ""}`));
    await p.keyboard.type("5");
    assert.deepEqual(await shown(), ["5*", "5"], "local tab 5 + the remote copy reusing its number");
    await p.keyboard.press("Escape");
    await p.keyboard.type("6");
    assert.deepEqual(await shown(), ["6*"], "a tab inside a folded group is still found");
    await p.keyboard.press("Escape");
    await p.keyboard.type("cal");
    assert.deepEqual(await shown(), ["3*"]);
    await p.close();
  });

  test("other devices: remote-only tabs get their own numbers, local copies say 'open here'", async () => {
    const p = await b.openNewtab();
    await p.waitForSelector("#remoteSection:not([hidden])", { timeout: 8000 });
    const remote = await p.evaluate(() => Array.from(document.querySelectorAll("#remote .item")).map((n) => `${n.dataset.num} ${n.querySelector(".title").textContent} | ${n.querySelector(".meta").textContent}`));
    assert.deepEqual(remote, ["7 Train timetable | trains.example", "5 Morning news digest | open here"]);
    await p.close();
  });

  test("two columns in reading order on a wide window, one on a narrow one", async () => {
    const p = await b.openNewtab();
    const cols = () => p.evaluate(() => getComputedStyle(document.querySelector(".tab-grid")).gridTemplateColumns.split(" ").length);
    assert.equal(await cols(), 2);
    const [a, c] = await p.evaluate(() => ["4", "5"].map((n) => document.querySelector(`.item[data-num="${n}"]`).getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top })));
    assert.ok(a.left < c.left && Math.abs(a.top - c.top) < 2, "4 left, 5 right on the same row");
    await p.setViewportSize({ width: 800, height: 860 });
    assert.equal(await cols(), 1);
    await p.close();
  });

  test("sections can be hidden from the settings, live; the black theme is black", async () => {
    const p = await b.openNewtab();
    await b.setSettings({ otherDevices: false, thisWindow: false });
    await sleep(500);
    assert.equal(await p.evaluate(() => document.getElementById("remoteSection").hidden), true);
    assert.equal(await p.locator("#local .item").count(), 0);
    await b.setSettings({ otherDevices: true, thisWindow: true });
    await b.setStorage({ themePreference: "black" });
    await sleep(500);
    assert.equal(await p.locator("#local .item").count() > 0, true);
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)");
    await b.setStorage({ themePreference: "system" });
    await p.close();
  });

  test("✕ only on hover and only on this device's tabs; ✕ and Delete close the tab", async () => {
    const p = await b.openNewtab();
    await p.waitForSelector("#remoteSection:not([hidden])", { timeout: 8000 });
    const row = (title) => p.locator(".row", { has: p.locator(".title", { hasText: title }) }).first();
    const closeDisplay = (title) => row(title).locator(".close").evaluate((n) => getComputedStyle(n).display);
    assert.equal(await closeDisplay("Design doc"), "none");
    await row("Design doc").hover();
    assert.equal(await closeDisplay("Design doc"), "flex");
    assert.equal(await p.locator("#remote .close").count(), 0);
    await row("Design doc").locator(".close").click();
    await row("Morning news").locator(".item").focus();
    await p.keyboard.press("Delete");
    await sleep(600);
    const titles = await b.bg(async () => (await chrome.tabs.query({})).map((t) => t.title));
    assert.ok(!titles.includes("Design doc: sync v5") && !titles.includes("Morning news digest"));
    await p.close();
  });

  test("Enter on a tab switches to it and closes the new tab page", async () => {
    const p = await b.openNewtab();
    await p.keyboard.type("pasta"); // by title: closing tabs above renumbered it
    const closed = p.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
    await p.keyboard.press("Enter");
    assert.equal(await closed, true);
    const active = await b.bg(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].title);
    assert.equal(active, "Weeknight pasta recipes");
    assert.deepEqual(b.errors, []);
  });
});
