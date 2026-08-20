// Regression test for a real, browser-only bug the simulator can't
// catch: sync-core.js and background.js are loaded into ONE shared
// script realm in the actual extension — via importScripts on Chrome,
// via sequential <script> tags on Firefox — and both mechanisms share
// a single top-level `let`/`const`/`class` lexical scope across the
// loaded files (unlike `require()`, which is what test/sim-env.js uses
// and which gives sync-core.js its own isolated module scope). A
// top-level `const`/`let` in background.js with the SAME NAME as one
// in sync-core.js throws "Identifier '<name>' has already been
// declared" the moment the browser parses background.js — which
// silently prevents the ENTIRE script from running: no listeners ever
// get registered, so nothing works (this exact bug shipped once,
// breaking first-run setup and profile switching, and no test in this
// suite noticed because everything else here runs sync-core.js via
// require()).
//
// This test can't run the real browser's parser, so it does the next
// best thing: statically extract each file's top-level (unindented)
// const/let/class/function declarations and assert the two sets don't
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

test("background.js and sync-core.js declare no colliding top-level names", () => {
  const bg = topLevelDeclarations(path.join(__dirname, "..", "background.js"));
  const core = topLevelDeclarations(path.join(__dirname, "..", "sync-core.js"));

  const collisions = [...bg].filter((name) => core.has(name));
  assert.deepEqual(
    collisions,
    [],
    "background.js must not re-declare a top-level const/let/function/class " +
      "that sync-core.js already declares at its top level — they share one " +
      "lexical scope in the real browser (importScripts / sequential <script> " +
      "tags), even though require() isolates them in this test suite. Read " +
      "the value off `engine.*` (or rename) instead."
  );
});
