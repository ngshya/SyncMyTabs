// Pure helpers from groups-core.js: pattern matching and the
// group-rule bookmark-url encoding. No env/engine needed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  globToRegExp,
  matchesPattern,
  defaultMatchForUrl,
  findRuleForTabUrl,
  resolvePatternForTab,
  buildGroupRuleUrl,
  parseGroupRuleUrl,
  GROUP_RULE_URL_BASE,
} = require("../groups-core.js");

test("globToRegExp turns * into a wildcard and anchors the whole string", () => {
  const re = globToRegExp("*://example.com/docs/*");
  assert.equal(re.test("https://example.com/docs/intro"), true);
  assert.equal(re.test("https://example.com/other"), false);
});

test("matchesPattern supports glob and regex: patterns", () => {
  assert.equal(matchesPattern("https://example.com/a", "*://example.com/*"), true);
  assert.equal(matchesPattern("https://example.com/a", "*://other.com/*"), false);
  assert.equal(matchesPattern("https://example.com/a", "regex:^https://example\\.com/.*$"), true);
  assert.equal(matchesPattern("https://example.com/a", ""), false);
  assert.equal(matchesPattern("https://example.com/a", null), false);
});

test("matchesPattern never throws on a malformed regex: pattern", () => {
  assert.equal(matchesPattern("https://example.com/a", "regex:("), false);
});

test("defaultMatchForUrl keeps the full path, drops query and fragment", () => {
  assert.equal(
    defaultMatchForUrl("https://example.com/docs/intro?x=1#section"),
    "*://example.com/docs/intro*"
  );
  assert.equal(defaultMatchForUrl("not a url"), "*");
});

test("findRuleForTabUrl picks the most specific (longest match) rule", () => {
  const settings = {
    rules: [
      { match: "*://example.com/*", pattern: "a" },
      { match: "*://example.com/docs/*", pattern: "b" },
    ],
  };
  const rule = findRuleForTabUrl(settings, "https://example.com/docs/intro");
  assert.equal(rule.pattern, "b");
});

test("findRuleForTabUrl returns null when nothing matches, or settings are empty", () => {
  assert.equal(findRuleForTabUrl({ rules: [] }, "https://example.com/"), null);
  assert.equal(findRuleForTabUrl(null, "https://example.com/"), null);
  assert.equal(
    findRuleForTabUrl({ rules: [{ match: "*://other.com/*", pattern: "a" }] }, "https://example.com/"),
    null
  );
});

test("resolvePatternForTab returns null for an openUrl-only rule (no pattern = unleashed)", () => {
  const settings = { rules: [{ match: "*://example.com/*", openUrl: "https://example.com/" }] };
  assert.equal(resolvePatternForTab(settings, "https://example.com/"), null);
});

test("resolvePatternForTab returns the matching rule's pattern", () => {
  const settings = { rules: [{ match: "*://example.com/*", pattern: "*://example.com/*" }] };
  assert.equal(resolvePatternForTab(settings, "https://example.com/"), "*://example.com/*");
});

test("buildGroupRuleUrl + parseGroupRuleUrl round-trip", () => {
  const rule = { match: "*://example.com/*", pattern: "*://example.com/*", openUrl: "https://example.com/" };
  const url = buildGroupRuleUrl(rule);
  assert.ok(url.startsWith(GROUP_RULE_URL_BASE));
  assert.deepEqual(parseGroupRuleUrl(url), rule);
});

test("buildGroupRuleUrl omits empty fields; parseGroupRuleUrl fills them back in as empty strings", () => {
  const url = buildGroupRuleUrl({ match: "*://example.com/*" });
  assert.deepEqual(parseGroupRuleUrl(url), {
    match: "*://example.com/*",
    pattern: "",
    openUrl: "",
  });
});

test("parseGroupRuleUrl rejects non-rule URLs and an all-empty rule", () => {
  assert.equal(parseGroupRuleUrl("https://example.com/"), null);
  assert.equal(parseGroupRuleUrl(""), null);
  assert.equal(parseGroupRuleUrl(null), null);
  assert.equal(parseGroupRuleUrl(`${GROUP_RULE_URL_BASE}?`), null);
});
