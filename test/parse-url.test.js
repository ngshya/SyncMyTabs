const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseTabEntryUrl, buildTabEntryUrl, isHttpUrl } = require("../sync-core.js");

test("buildTabEntryUrl + parseTabEntryUrl round-trip", () => {
  const url = buildTabEntryUrl({
    real: "https://example.com/some path?q=1&r=2",
    device: "laptop A",
    state: "open",
    t: 123,
    h: 456,
  });
  const parsed = parseTabEntryUrl(url);
  assert.deepEqual(parsed, {
    real: "https://example.com/some path?q=1&r=2",
    device: "laptop A",
    state: "open",
    t: 123,
    h: 456,
  });
});

test("parseTabEntryUrl rejects non-tab-entry URLs", () => {
  assert.equal(parseTabEntryUrl("https://example.com/"), null);
  assert.equal(parseTabEntryUrl("https://syncmytabs.local/other"), null);
  assert.equal(parseTabEntryUrl(""), null);
  assert.equal(parseTabEntryUrl(null), null);
});

test("parseTabEntryUrl rejects a malformed/incomplete tab entry", () => {
  // missing device
  assert.equal(
    parseTabEntryUrl("https://syncmytabs.local/tab?u=https%3A%2F%2Fx&s=open&t=1"),
    null
  );
  // invalid state
  assert.equal(
    parseTabEntryUrl(
      "https://syncmytabs.local/tab?u=https%3A%2F%2Fx&d=A&s=maybe&t=1"
    ),
    null
  );
});

test("parseTabEntryUrl defaults h to t when h is absent", () => {
  const url =
    "https://syncmytabs.local/tab?u=https%3A%2F%2Fx&d=A&s=open&t=42";
  assert.deepEqual(parseTabEntryUrl(url), {
    real: "https://x",
    device: "A",
    state: "open",
    t: 42,
    h: 42,
  });
});

test("isHttpUrl", () => {
  assert.equal(isHttpUrl("https://example.com/"), true);
  assert.equal(isHttpUrl("http://example.com/"), true);
  assert.equal(isHttpUrl("ftp://example.com/"), false);
  assert.equal(isHttpUrl("chrome://extensions"), false);
  assert.equal(isHttpUrl(""), false);
  assert.equal(isHttpUrl(undefined), false);
});
