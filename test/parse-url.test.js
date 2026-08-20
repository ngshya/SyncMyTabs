const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDeviceStatusUrl,
  parseDeviceStatusUrl,
  isRelevantBookmarkChange,
  isHttpUrl,
  URL_MARKER_TITLE,
} = require("../sync-core.js");

test("buildDeviceStatusUrl + parseDeviceStatusUrl round-trip", () => {
  const url = buildDeviceStatusUrl({ state: "open", t: 123, h: 456 });
  assert.deepEqual(parseDeviceStatusUrl(url), { state: "open", t: 123, h: 456 });
});

test("parseDeviceStatusUrl rejects non-status URLs", () => {
  assert.equal(parseDeviceStatusUrl("https://example.com/"), null);
  assert.equal(parseDeviceStatusUrl("https://syncmytabs.local/other"), null);
  assert.equal(parseDeviceStatusUrl(""), null);
  assert.equal(parseDeviceStatusUrl(null), null);
});

test("parseDeviceStatusUrl rejects an invalid state", () => {
  assert.equal(
    parseDeviceStatusUrl("https://syncmytabs.local/status?s=maybe&t=1&h=1"),
    null
  );
});

test("parseDeviceStatusUrl defaults h to t when h is absent", () => {
  const url = "https://syncmytabs.local/status?s=open&t=42";
  assert.deepEqual(parseDeviceStatusUrl(url), { state: "open", t: 42, h: 42 });
});

test("isRelevantBookmarkChange recognizes the _url marker and status bookmarks, ignores everything else", () => {
  assert.equal(isRelevantBookmarkChange(URL_MARKER_TITLE, "https://example.com/"), true);
  assert.equal(
    isRelevantBookmarkChange(
      "laptop-A",
      buildDeviceStatusUrl({ state: "open", t: 1, h: 1 })
    ),
    true
  );
  assert.equal(isRelevantBookmarkChange("My bookmark", "https://example.com/"), false);
  assert.equal(isRelevantBookmarkChange(undefined, undefined), false);
});

test("isHttpUrl", () => {
  assert.equal(isHttpUrl("https://example.com/"), true);
  assert.equal(isHttpUrl("http://example.com/"), true);
  assert.equal(isHttpUrl("ftp://example.com/"), false);
  assert.equal(isHttpUrl("chrome://extensions"), false);
  assert.equal(isHttpUrl(""), false);
  assert.equal(isHttpUrl(undefined), false);
});
