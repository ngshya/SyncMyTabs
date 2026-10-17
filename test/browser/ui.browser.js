// The popup and the options page in a real browser: they still read every
// module's real preferences, messages to the background still round-trip,
// and the black theme reaches both pages.

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, SKIP, sleep } = require("./helpers.js");

describe("popup and options page", { skip: SKIP }, () => {
  let b;

  before(async () => {
    b = await launch({ storage: { tabOrderEnabled: true, archiveEnabled: false } });
  });
  after(() => b && b.close());

  for (const page of ["popup.html", "options.html"]) {
    test(`${page} shows each module's stored on/off state`, async () => {
      const p = await b.openPage(page);
      await sleep(800);
      const state = await p.evaluate(() => {
        const c = (...ids) => {
          for (const id of ids) {
            const e = document.getElementById(id);
            if (e) return e.checked;
          }
          return "missing";
        };
        return {
          groups: c("groupsToggle", "groupsLeashEnabled"),
          archive: c("archiveToggle", "archiveEnabled"),
          order: c("orderToggle", "orderEnabled"),
        };
      });
      assert.deepEqual(state, { groups: true, archive: false, order: true });
      await p.close();
    });
  }

  test("background messages: a module's own message answers, an unknown one gets no reply", async () => {
    const p = await b.openPage("options.html");
    assert.deepEqual(await p.evaluate(() => chrome.runtime.sendMessage({ type: "ORDER_REORDER_NOW" })), { ok: true });
    const unknown = await p.evaluate(() => chrome.runtime.sendMessage({ type: "NOT_A_REAL_MESSAGE" }).then((r) => r ?? "no reply", (e) => "error: " + e.message));
    assert.equal(unknown, "no reply");
    await p.close();
  });

  test("the Black theme, picked on the options page, makes both pages black", async () => {
    const opt = await b.openPage("options.html");
    await opt.selectOption("#themePreference", "black");
    await sleep(400);
    assert.equal(await opt.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)");
    const pop = await b.openPage("popup.html");
    await sleep(400);
    assert.equal(await pop.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)");
    assert.deepEqual(b.errors, []);
  });
});
