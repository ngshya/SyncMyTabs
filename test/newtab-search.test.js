// New tab page web search helpers (newtab-search.js): one-letter service
// prefixes, service URLs, and telling an address apart from a search.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SEARCH_ENGINES, engineForKey, parsePrefix, engineUrl, urlFromInput } = require("../newtab-search.js");

test("every service has its own single letter and a %s placeholder", () => {
  const keys = SEARCH_ENGINES.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const e of SEARCH_ENGINES) {
    assert.match(e.key, /^[a-z]$/);
    assert.ok(e.url.includes("%s"), e.name);
    assert.ok(e.url.startsWith("https://"), e.name);
  }
});

test("a known letter + space picks a service; anything else stays text", () => {
  assert.equal(parsePrefix("y lofi beats").engine.name, "YouTube");
  assert.equal(parsePrefix("y lofi beats").rest, "lofi beats");
  assert.equal(parsePrefix("Y ").engine.name, "YouTube", "upper case too, and the bare prefix");
  assert.equal(parsePrefix("y ").rest, "");
  assert.equal(parsePrefix("yoga"), null);
  assert.equal(parsePrefix("y2k"), null);
  assert.equal(parsePrefix("z something"), null, "unknown letter");
  assert.equal(parsePrefix("12"), null);
  assert.equal(engineForKey("M").name, "Maps");
});

test("service URLs encode the query and fill in the language", () => {
  assert.equal(engineUrl(engineForKey("g"), "a & b?"), "https://www.google.com/search?q=a%20%26%20b%3F");
  assert.equal(
    engineUrl(engineForKey("w"), "Roma", "it-IT"),
    "https://www.wikipedia.org/search-redirect.php?family=wikipedia&language=it&search=Roma"
  );
  assert.equal(engineUrl(engineForKey("c"), "ciao"), "https://claude.ai/new?q=ciao");
});

test("addresses are recognised, searches are not", () => {
  assert.equal(urlFromInput("github.com"), "https://github.com");
  assert.equal(urlFromInput("github.com/ngshya/SyncMyTabs"), "https://github.com/ngshya/SyncMyTabs");
  assert.equal(urlFromInput("https://example.org/x?y=1"), "https://example.org/x?y=1");
  assert.equal(urlFromInput("localhost:3000"), "http://localhost:3000");
  assert.equal(urlFromInput("192.168.1.1"), "http://192.168.1.1");
  assert.equal(urlFromInput("ricetta carbonara"), null);
  assert.equal(urlFromInput("carbonara"), null);
  assert.equal(urlFromInput("v1.2"), null, "a version number isn't a domain");
  assert.equal(urlFromInput(""), null);
});
