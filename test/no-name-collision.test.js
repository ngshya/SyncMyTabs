// Regression test for a real, browser-only bug the simulator can't
// catch: background.js, sync-core.js, and groups-core.js are loaded
// into ONE shared script realm in the actual extension — via
// importScripts on Chrome, via sequential <script> tags on Firefox —
// and both mechanisms share a single top-level `let`/`const`/`class`
// lexical scope across the loaded files (unlike `require()`, which is
// what test/sim-env.js uses and which gives each file its own isolated
// module scope). A top-level `const`/`let` in one of these files with
// the SAME NAME as one in another throws "Identifier '<name>' has
// already been declared" the moment the browser parses it — which
// silently prevents the ENTIRE script from running: no listeners ever
// get registered, so nothing works (this exact bug shipped once,
// breaking first-run setup and profile switching, and no test in this
// suite noticed because everything else here runs sync-core.js via
// require()).
//
// This test can't run the real browser's parser, so it does the next
// best thing: statically extract each file's top-level (unindented)
// const/let/class/function declarations and assert no two files' sets
// overlap. Crude, but it directly targets the actual failure mode and
// would have caught the real bug.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function topLevelDeclarations(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const names = new Set();
  const re = /^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

// background.js, sync-core.js, groups-core.js, AND archive-core.js are
// all loaded into that same one shared scope (see manifest.json's
// background.scripts / content_scripts order) — check every pair.
const FILES = [
  "background.js",
  "sync-core.js",
  "groups-core.js",
  "archive-core.js",
  "order-core.js",
];

test("background.js, sync-core.js, groups-core.js, archive-core.js, and order-core.js declare no colliding top-level names", () => {
  const declsByFile = new Map(
    FILES.map((f) => [f, topLevelDeclarations(path.join(__dirname, "..", f))])
  );

  const collisions = [];
  for (let i = 0; i < FILES.length; i++) {
    for (let j = i + 1; j < FILES.length; j++) {
      const [fa, fb] = [FILES[i], FILES[j]];
      for (const name of declsByFile.get(fa)) {
        if (declsByFile.get(fb).has(name)) collisions.push(`${name} (${fa} vs ${fb})`);
      }
    }
  }

  assert.deepEqual(
    collisions,
    [],
    "these files must not re-declare the same top-level const/let/function/" +
      "class name as one another — they share one lexical scope in the real " +
      "browser (importScripts / sequential <script> tags), even though " +
      "require() isolates them in this test suite. Read the value off " +
      "`engine.*`/`groupsEngine.*` (or rename) instead."
  );
});
