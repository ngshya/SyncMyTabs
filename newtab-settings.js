// ============================================================
// SyncMyTabs - newtab-settings.js
//
// The new tab page's settings, in ONE place: the storage key, every
// setting's default, and the labels the options page's "New tab page"
// card shows for them. Loaded as a plain script by both newtab.html (for
// newtab.js, newtab-bookmarks.js, newtab-matrix.js) and options.html (for
// newtab-options.js), so none of them keeps its own copy — adding a
// setting means adding one line to OPTIONS below, then reading it where
// it's used. Exposes a single global, `NewtabSettings`; module.exports at
// the bottom is a Node-only no-op in the pages (test/newtab-settings.test.js).
// ============================================================

const NewtabSettings = (function () {
  // Historical name: it started out holding only which tab sections show.
  const KEY = "newtabSections";

  // [key, default, label, group] — the order is the options card's order.
  const OPTIONS = [
    ["thisWindow", true, "Tabs in the current window", "Show"],
    ["otherWindows", true, "Tabs in your other windows", "Show"],
    ["otherDevices", true, "Tabs on your other devices", "Show"],
    ["bookmarksBar", false, "Bookmarks bar at the top (a copy of the browser's, so you can keep its own hidden)", "Show"],
    ["clockSeconds", true, "Seconds on the clock", "Look & feel"],
    ["clock24h", true, "24-hour clock (off: the browser language's own format, e.g. AM/PM)", "Look & feel"],
    ["focusSearch", true, "Put the cursor in the search box, not the address bar (the address bar then shows the page's own address)", "Look & feel"],
    ["matrixRain", false, "Matrix rain in the background (dark and black themes only)", "Look & feel"],
  ];

  const DEFAULTS = Object.fromEntries(OPTIONS.map(([key, value]) => [key, value]));

  function merge(saved) {
    return { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  }

  async function load() {
    try {
      const { [KEY]: saved } = await browser.storage.local.get(KEY);
      return merge(saved);
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  async function save(values) {
    await browser.storage.local.set({ [KEY]: merge(values) });
  }

  // Calls `callback(settings)` whenever the settings change — from the
  // options page, or another open new tab page.
  function onChange(callback) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY]) callback(merge(changes[KEY].newValue));
    });
  }

  return { KEY, OPTIONS, DEFAULTS, merge, load, save, onChange };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NewtabSettings };
}
