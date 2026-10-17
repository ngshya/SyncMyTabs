// The store zips are built by scripts/build.js from its own FILES list,
// not from the repository folder — a file missing from that list ships a
// broken extension that "Load unpacked" on the repo never shows (a
// missing archive-core.js once took the whole background worker down).
// This checks the list against what actually gets loaded, and against
// the repo itself, so a new file can't be forgotten.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FILES } = require("../scripts/build.js");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const manifest = JSON.parse(read("manifest.json"));

// "icons/icon16.png" is covered by "icons" in the list.
const packaged = (f) => FILES.some((c) => f === c || f.startsWith(`${c}/`));

test("every listed file exists", () => {
  assert.deepEqual(FILES.filter((f) => !fs.existsSync(path.join(root, f))), []);
});

test("every top-level .js/.html/.css file in the repo is packaged", () => {
  const sources = fs.readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f));
  assert.deepEqual(sources.filter((f) => !packaged(f)), []);
});

test("every file the manifest references is packaged", () => {
  const refs = [
    manifest.background.service_worker,
    ...(manifest.background.scripts || []),
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    manifest.action && manifest.action.default_popup,
    ...Object.values(manifest.chrome_url_overrides || {}),
    ...Object.values(manifest.icons || {}),
    ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ].filter(Boolean);
  assert.deepEqual(refs.filter((f) => !packaged(f)), []);
});

test("every script and stylesheet a packaged HTML page loads is packaged", () => {
  const missing = [];
  for (const page of FILES.filter((f) => f.endsWith(".html"))) {
    for (const m of read(page).matchAll(/<(?:script[^>]*\bsrc|link[^>]*\bhref)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:|data:|#)/.test(ref)) continue;
      if (!packaged(ref)) missing.push(`${page} → ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("background.js's importScripts only names packaged files", () => {
  const m = /importScripts\(([\s\S]*?)\)/.exec(read("background.js"));
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(names.filter((f) => !packaged(f)), []);
});
