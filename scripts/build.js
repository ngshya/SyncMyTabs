// ============================================================
// SyncMyTabs - scripts/build.js
//
// Builds the two store packages' folders from the repository — the ONE
// place that knows which files ship. Used by the release workflow (which
// then zips them), by test/release-files.test.js (which checks this list
// against everything the manifest and the pages load), and by the
// browser tests (test/browser/), which load the built Chrome folder —
// so they test exactly what ships, not the repo folder (which always has
// every file, and so hides a missing one).
//
//   node scripts/build.js [outDir]      → outDir/chrome, outDir/firefox
//                                          (default outDir: build/)
//
// The repo's manifest is "dual" (loads on both browsers for development);
// each package gets a tailored one so neither store warns:
//   Chrome:  background.service_worker only, no gecko settings.
//   Firefox: background.scripts only.
// ============================================================

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Every file or folder that ships, besides manifest.json. A new top-level
// .js/.html/.css file must be added here — test/release-files.test.js
// fails until it is.
const FILES = [
  "background.js",
  "sync-core.js",
  "groups-core.js",
  "archive-core.js",
  "order-core.js",
  "newtab-core.js",
  "link-leash-content.js",
  "browser-polyfill.min.js",
  "popup.html",
  "popup.js",
  "options.html",
  "options.js",
  "theme.css",
  "theme.js",
  "lazy.html",
  "lazy.js",
  "newtab.html",
  "newtab.js",
  "newtab-dom.js",
  "newtab-clock.js",
  "newtab-options.js",
  "newtab-bookmarks.js",
  "newtab-search.js",
  "newtab-settings.js",
  "newtab-matrix.js",
  "icons",
];

function manifestFor(browser) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  if (browser === "chrome") {
    delete m.background.scripts;
    delete m.browser_specific_settings;
  } else {
    delete m.background.service_worker;
  }
  return m;
}

function build(outDir = path.join(ROOT, "build")) {
  const dirs = {};
  for (const browser of ["chrome", "firefox"]) {
    const dir = path.join(outDir, browser);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifestFor(browser), null, 2));
    dirs[browser] = dir;
  }
  return dirs;
}

if (require.main === module) {
  const dirs = build(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`built ${dirs.chrome}\nbuilt ${dirs.firefox}`);
}

module.exports = { FILES, build, manifestFor };
