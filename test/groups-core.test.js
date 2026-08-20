// Pure helpers from groups-core.js: pattern matching and the
// group-rule bookmark-url encoding. No env/engine needed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  globToRegExp,
  matchesPattern,
  defaultPatternForUrl,
  findRuleForTabUrl,
  resolvePatternForTab,
  tabSatisfiesRule,
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

test("defaultPatternForUrl keeps the full path, drops query and fragment", () => {
  assert.equal(
    defaultPatternForUrl("https://example.com/docs/intro?x=1#section"),
    "*://example.com/docs/intro*"
  );
  assert.equal(defaultPatternForUrl("not a url"), "*");
});

test("findRuleForTabUrl picks the most specific (longest pattern) rule", () => {
  const settings = {
    rules: [
      { pattern: "*://example.com/*" },
      { pattern: "*://example.com/docs/*" },
    ],
  };
  const rule = findRuleForTabUrl(settings, "https://example.com/docs/intro");
  assert.equal(rule.pattern, "*://example.com/docs/*");
});

test("findRuleForTabUrl returns null when nothing matches, or settings are empty", () => {
  assert.equal(findRuleForTabUrl({ rules: [] }, "https://example.com/"), null);
  assert.equal(findRuleForTabUrl(null, "https://example.com/"), null);
  assert.equal(
    findRuleForTabUrl({ rules: [{ pattern: "*://other.com/*" }] }, "https://example.com/"),
    null
  );
});

test("findRuleForTabUrl never picks an openUrl-only rule (no pattern to match against)", () => {
  const settings = { rules: [{ openUrl: "https://example.com/" }] };
  assert.equal(findRuleForTabUrl(settings, "https://example.com/"), null);
});

test("resolvePatternForTab returns null when no rule covers the page", () => {
  assert.equal(resolvePatternForTab({ rules: [] }, "https://example.com/"), null);
});

test("resolvePatternForTab returns the matching rule's pattern", () => {
  const settings = { rules: [{ pattern: "*://example.com/*" }] };
  assert.equal(resolvePatternForTab(settings, "https://example.com/"), "*://example.com/*");
});

test("tabSatisfiesRule uses pattern when present, falls back to an exact openUrl match", () => {
  assert.equal(tabSatisfiesRule("https://example.com/a", { pattern: "*://example.com/*" }), true);
  assert.equal(tabSatisfiesRule("https://other.com/a", { pattern: "*://example.com/*" }), false);
  assert.equal(
    tabSatisfiesRule("https://example.com/exact", { openUrl: "https://example.com/exact" }),
    true
  );
  assert.equal(
    tabSatisfiesRule("https://example.com/other", { openUrl: "https://example.com/exact" }),
    false
  );
  assert.equal(tabSatisfiesRule("", { pattern: "*" }), false);
  assert.equal(tabSatisfiesRule("https://example.com/", null), false);
});

test("buildGroupRuleUrl + parseGroupRuleUrl round-trip", () => {
  const rule = { pattern: "*://example.com/*", openUrl: "https://example.com/" };
  const url = buildGroupRuleUrl(rule);
  assert.ok(url.startsWith(GROUP_RULE_URL_BASE));
  assert.deepEqual(parseGroupRuleUrl(url), rule);
});

test("buildGroupRuleUrl omits empty fields; parseGroupRuleUrl fills them back in as empty strings", () => {
  const url = buildGroupRuleUrl({ pattern: "*://example.com/*" });
  assert.deepEqual(parseGroupRuleUrl(url), {
    pattern: "*://example.com/*",
    openUrl: "",
  });
});

test("parseGroupRuleUrl rejects non-rule URLs and an all-empty rule", () => {
  assert.equal(parseGroupRuleUrl("https://example.com/"), null);
  assert.equal(parseGroupRuleUrl(""), null);
  assert.equal(parseGroupRuleUrl(null), null);
  assert.equal(parseGroupRuleUrl(`${GROUP_RULE_URL_BASE}?`), null);
});
