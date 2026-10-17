// The store zips are built from release.yml's own COMMON file list, not
// from the repository folder — a file missing from that list ships a
// broken extension that "Load unpacked" on the repo never shows (see
// CLAUDE.md: a missing archive-core.js once took the whole background
// worker down). This checks the list against what actually gets loaded:
// every file the manifest names and every script/stylesheet an HTML page
// in the list loads, plus that every packaged .js is syntax-checked.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const workflow = read(".github/workflows/release.yml");
const COMMON = /COMMON="([^"]+)"/.exec(workflow)[1].split(/\s+/);
const CHECKED = new Set([...workflow.matchAll(/node --check (\S+)/g)].map((m) => m[1]));
const manifest = JSON.parse(read("manifest.json"));

// "icons/icon16.png" is covered by "icons" in the list.
const packaged = (f) => COMMON.some((c) => f === c || f.startsWith(`${c}/`));

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
  for (const page of COMMON.filter((f) => f.endsWith(".html"))) {
    for (const m of read(page).matchAll(/<(?:script[^>]*\bsrc|link[^>]*\bhref)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:|data:|#)/.test(ref)) continue;
      if (!packaged(ref)) missing.push(`${page} → ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every packaged .js file exists and is syntax-checked by the workflow", () => {
  for (const f of COMMON) assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`);
  const unchecked = COMMON.filter((f) => f.endsWith(".js") && !f.endsWith(".min.js") && !CHECKED.has(f));
  assert.deepEqual(unchecked, []);
});
