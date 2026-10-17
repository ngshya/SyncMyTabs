// The Chrome Web Store's length limits for the copy-paste texts kept in
// this repo: every answer in PERMISSIONS.md (single purpose, each
// permission justification, …) under 1,000 characters, and the
// STORE_LISTING.md summary at most 132. Counted as the text gets pasted:
// the quoted block's lines joined into one paragraph.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// { heading: text } for every "> …" quoted answer under a heading.
function quotedAnswers(markdown) {
  const out = {};
  let heading = null;
  for (const line of markdown.split("\n")) {
    const h = /^#+\s+(.*)$/.exec(line);
    if (h) heading = h[1];
    else if (heading && line.startsWith(">")) {
      const text = line.replace(/^>\s?/, "").trim();
      out[heading] = out[heading] ? `${out[heading]} ${text}`.trim() : text;
    }
  }
  return out;
}

test("PERMISSIONS.md: every answer is under 1,000 characters", () => {
  const answers = quotedAnswers(read("PERMISSIONS.md"));
  assert.ok(answers["Single purpose"], "the single purpose answer is there");
  const tooLong = Object.entries(answers)
    .filter(([, text]) => text.length >= 1000)
    .map(([heading, text]) => `${heading}: ${text.length}`);
  assert.deepEqual(tooLong, []);
});

test("STORE_LISTING.md: the summary is at most 132 characters", () => {
  const summary = quotedAnswers(read("STORE_LISTING.md"))["Summary (132 characters max)"];
  assert.ok(summary);
  assert.ok(summary.length <= 132, `${summary.length} characters`);
});

// Version 4.18.0 was rejected ("Spam and Placement in the Store": excessive
// keywords) for listing the web-search services by name in the
// description. Describe features generically; no runs of product names.
test("STORE_LISTING.md: the description names no search services (keyword-spam rejection)", () => {
  const md = read("STORE_LISTING.md");
  const start = md.indexOf("## Description");
  const block = md.slice(md.indexOf("```", start) + 3, md.indexOf("```", md.indexOf("```", start) + 3));
  const { SEARCH_ENGINES } = require("../newtab-search.js");
  const named = SEARCH_ENGINES.map((e) => e.name).filter((name) => new RegExp(`\\b${name}\\b`).test(block));
  assert.deepEqual(named, []);
  assert.ok(!/\bYouTube\b/.test(block));
});
