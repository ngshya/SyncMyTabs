// The new tab page's settings (newtab-settings.js): one key, one list of
// defaults, shared by every page that reads or writes them.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NewtabSettings } = require("../newtab-settings.js");

test("defaults: tab sections (archived: 7 days), seconds and search focus on; bookmarks bar and matrix rain off", () => {
  assert.deepEqual(NewtabSettings.DEFAULTS, {
    thisWindow: true,
    otherWindows: true,
    archived: true,
    archivedDays: 7,
    bookmarksBar: false,
    clockSeconds: true,
    clock24h: true,
    focusSearch: true,
    matrixRain: false,
  });
});

test("saved values win over defaults; missing or junk values fall back to them", () => {
  assert.equal(NewtabSettings.merge({ clockSeconds: false }).clockSeconds, false);
  assert.equal(NewtabSettings.merge({ clockSeconds: false }).thisWindow, true);
  assert.deepEqual(NewtabSettings.merge(undefined), NewtabSettings.DEFAULTS);
  assert.deepEqual(NewtabSettings.merge("junk"), NewtabSettings.DEFAULTS);
});

test("every option has a label and a group, and keys are unique", () => {
  const keys = NewtabSettings.OPTIONS.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length);
  for (const [key, value, label, group] of NewtabSettings.OPTIONS) {
    assert.ok(typeof value === "boolean" || (Number.isInteger(value) && value >= 1), key);
    assert.ok(label && group, key);
  }
});
