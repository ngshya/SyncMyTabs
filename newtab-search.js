// ============================================================
// SyncMyTabs - newtab-search.js
//
// Pure helpers for the new tab page's web search (newtab.js does the DOM
// and the actual navigation): the list of search services, the
// one-letter prefixes that pick one ("y lofi" → YouTube), building a
// service's search URL, and telling an address ("github.com") apart from
// a search. No browser API in here, so test/newtab-search.test.js runs it
// in Node; loaded by newtab.html as a plain script (the module.exports at
// the bottom is a Node-only no-op in the page).
//
// Nothing is sent anywhere until the user actually asks (Enter or a
// click): no search suggestions, which would mean shipping every
// keystroke to a search company.
// ============================================================

// `%s` is the query; `%l` the browser's language ("it", "en", …), for the
// services whose results depend on it. One letter each, all different.
const SEARCH_ENGINES = [
  { key: "g", name: "Google", url: "https://www.google.com/search?q=%s" },
  { key: "m", name: "Maps", url: "https://www.google.com/maps/search/?api=1&query=%s" },
  { key: "y", name: "YouTube", url: "https://www.youtube.com/results?search_query=%s" },
  { key: "c", name: "Claude", url: "https://claude.ai/new?q=%s" },
  { key: "p", name: "Perplexity", url: "https://www.perplexity.ai/search?q=%s" },
  { key: "w", name: "Wikipedia", url: "https://www.wikipedia.org/search-redirect.php?family=wikipedia&language=%l&search=%s" },
  { key: "d", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
];

function engineForKey(key) {
  const k = String(key || "").toLowerCase();
  return SEARCH_ENGINES.find((e) => e.key === k) || null;
}

// "y lofi beats" → { engine: YouTube, rest: "lofi beats" }; also "y " on
// its own (rest ""), which is the moment the page turns the letter into
// a chip. Only a known letter followed by a space counts — "yoga" or
// "y2k" stay ordinary text.
function parsePrefix(value) {
  const m = /^([a-z]) (.*)$/is.exec(String(value || ""));
  if (!m) return null;
  const engine = engineForKey(m[1]);
  return engine ? { engine, rest: m[2] } : null;
}

function engineUrl(engine, text, lang) {
  const language = (String(lang || "en").split("-")[0] || "en").toLowerCase();
  return engine.url.replace("%l", encodeURIComponent(language)).replace("%s", encodeURIComponent(text));
}

// The address to open when what was typed looks like one rather than a
// search: a full http(s) URL, localhost or an IPv4 address (with an
// optional port/path), or a bare domain ("github.com/ngshya") — then
// https:// is assumed. null otherwise. A heuristic, like any address bar's:
// "node.js" looks like a domain too, which is why the page always says
// "Open node.js" before doing it, and Tab still offers the search
// services for it.
function urlFromInput(text) {
  const t = String(text || "").trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\/[^/\s]+/i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(t)) return `http://${t}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)) return `https://${t}`;
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SEARCH_ENGINES, engineForKey, parsePrefix, engineUrl, urlFromInput };
}
