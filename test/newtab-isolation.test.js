// The custom new tab page is meant to be fully self-contained: nothing
// in the modules that existed before it (sync, tab groups, auto-archive,
// tab order — and their UI) knows it exists, and background.js wires it
// with its own onMessage listener rather than a branch inside the one
// every other module shares. Removing the feature should come down to
// deleting newtab-core.js/newtab.html/newtab.js/newtab-options.js and
// their few wiring lines — this test keeps it that way, so a later
// change that re-entangles them fails here rather than in review.
//
// Static checks, same style as no-name-collision.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// `newTab` (camelCase — groups-core.js's "open in a new tab" click
// modifier) is unrelated and deliberately not matched.
const NEWTAB_REFERENCE = /newtab|NEWTAB|isNewTabPage|NewtabEngine/;

const UNAWARE_FILES = [
  "sync-core.js",
  "groups-core.js",
  "archive-core.js",
  "order-core.js",
  "link-leash-content.js",
  "popup.js",
  "options.js",
  "popup.html",
];

test("pre-existing modules and their UI never reference the new tab page", () => {
  const offenders = UNAWARE_FILES.filter((f) => NEWTAB_REFERENCE.test(read(f)));
  assert.deepEqual(
    offenders,
    [],
    "keep new-tab-page knowledge inside newtab-core.js/newtab.js — these files must work without it"
  );
});

// The options page hosts the new tab page's own settings card, but only by
// loading newtab-options.js, which builds that card itself — options.html
// carries that one script tag and nothing else about the feature.
test("options.html only loads newtab-options.js, nothing else about the new tab page", () => {
  const TAG = '<script src="newtab-options.js"></script>';
  const src = read("options.html");
  assert.equal(src.split(TAG).length - 1, 1, "exactly one tag loading newtab-options.js");
  assert.ok(!NEWTAB_REFERENCE.test(src.replace(TAG, "")), "no other reference to the new tab page");
  assert.ok(src.indexOf(TAG) > src.indexOf('<script src="options.js"></script>'), "loaded after options.js");
});

test("background.js calls the new tab engine only from its own, last onMessage listener", () => {
  const src = read("background.js");
  const calls = src.match(/newtabEngine\./g) || [];
  assert.equal(calls.length, 1, "exactly one call site: newtabEngine.handleMessage");

  const lastListener = src.lastIndexOf("browser.runtime.onMessage.addListener");
  const firstListener = src.indexOf("browser.runtime.onMessage.addListener");
  assert.notEqual(firstListener, lastListener, "it has a listener of its own");
  assert.ok(src.indexOf("newtabEngine.handleMessage") > lastListener);

  // Up to the comment block introducing the new tab page's own listener
  // (which does, rightly, mention NEWTAB_*).
  const ownBlock = src.lastIndexOf("// Custom new tab page (newtab-core.js)", lastListener);
  assert.ok(ownBlock > firstListener);
  const sharedListener = src.slice(firstListener, ownBlock);
  assert.ok(!/NEWTAB_/.test(sharedListener), "the shared listener knows nothing about NEWTAB_* messages");
});
