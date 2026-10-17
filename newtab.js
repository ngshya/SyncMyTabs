// ============================================================
// SyncMyTabs - newtab.js
//
// Main DOM layer of the custom new tab page (newtab.html, wired via
// manifest.json's chrome_url_overrides.newtab): a clock, a search box,
// this device's open tabs by window in the browser's own tab-strip order
// (tab groups where they sit, folded when they're folded in the
// browser), the tabs open on the user's other devices, and the tabs
// auto-archived over the last few days (archivedDays). All the data
// assembly lives in newtab-core.js (served by background.js's
// NEWTAB_LOCAL/NEWTAB_REMOTE/NEWTAB_ARCHIVED messages, see its header
// comment for why it isn't done here); this file only renders it and
// reacts to clicks/keys.
//
// Every node is built with createElement/textContent, never innerHTML:
// tab titles and URLs are arbitrary text controlled by whatever page is
// open in that tab.
//
// Clicking a tab switches to it (focusing its window too), then closes
// this new tab page behind it — having just jumped to an existing tab,
// the blank one you came from would otherwise just pile up. A tab
// that's only open on another device opens right here, in this same
// tab, instead.
//
// Keyboard-only use: every listed tab has a number (see numberTabs);
// typing digits narrows the list to that number and Enter opens it.
// Any other text searches titles/URLs, Enter opens the first match.
// A tab of this device can be closed from the list too: a ✕ at the end
// of its row on hover, or Delete on the focused row (see closeTab).
//
// The same box searches the web (see the "web search" section below):
// Shift+Enter — or plain Enter when no tab matches — runs the browser's
// own default search; a one-letter prefix ("y lofi") or Tab after typing
// picks another service (newtab-search.js) instead.
//
// Siblings (each loaded by newtab.html, each independent): the settings
// (newtab-settings.js), shared DOM helpers (newtab-dom.js), the clock
// (newtab-clock.js), web-search helpers (newtab-search.js), the bookmarks
// bar (newtab-bookmarks.js) and the background rain (newtab-matrix.js).
// ============================================================

(function () {
  // Chrome/Brave's own tab-group palette, as tabGroups reports it.
  const GROUP_COLORS = {
    grey: "#5f6368",
    blue: "#1a73e8",
    red: "#d93025",
    yellow: "#f9ab00",
    green: "#1e8e3e",
    pink: "#d01884",
    purple: "#9334e6",
    cyan: "#007b83",
    orange: "#fa903e",
  };

  const searchBarEl = document.getElementById("searchBar");
  const searchEl = document.getElementById("search");
  const chipEl = document.getElementById("searchChip");
  const webActionsEl = document.getElementById("webActions");
  const localEl = document.getElementById("local");
  const remoteEl = document.getElementById("remote");
  const remoteSectionEl = document.getElementById("remoteSection");
  const archivedEl = document.getElementById("archived");
  const archivedSectionEl = document.getElementById("archivedSection");
  const archivedTitleEl = document.getElementById("archivedTitle");
  const emptyEl = document.getElementById("empty");

  let selfTab = null;
  let localData = { windows: [] };
  let remoteData = { paused: false, devices: [] };
  let archivedData = { paused: false, days: [] };
  // Which sections show (and the page's other settings) — see
  // newtab-settings.js; set from the options page's "New tab page" card.
  let sections = { ...NewtabSettings.DEFAULTS };

  // Web search state: the service picked for this query (null = no
  // service chip: the box searches tabs, and the web row offers the
  // browser's default search), whether it came from a typed prefix, and
  // a prefix letter just dismissed with Backspace (so "c" + space doesn't
  // instantly turn back into a chip for someone typing "c programming").
  let engine = null;
  let engineFromPrefix = false;
  let dismissedPrefix = null;

  // A group's fold state on this page is the browser's own (`collapsed`
  // from tabGroups) — clicking its header here overrides that, in memory
  // only and only until the browser's state changes: groupId →
  // { collapsed, browserCollapsed } where `browserCollapsed` is what the
  // browser said when the header was clicked. Folding/unfolding the group
  // in the browser afterwards wins again (see isFolded).
  const foldOverrides = new Map();

  const { el, hostOf, iconFor } = NewtabDom;
  const locale = NewtabDom.uiLocale(); // for services whose results depend on it (Wikipedia)

  function entryTabs(entry) {
    return entry.kind === "tab" ? [entry.tab] : entry.group.tabs;
  }

  // One listed tab: a row holding the tab's own button and — for a tab
  // of THIS device (`closeTabId`) — a close button, shown on hover or
  // keyboard focus (newtab.html). Two sibling buttons rather than one
  // nested in the other, which HTML doesn't allow. Tabs on other devices
  // get no close button: closing one there would mean writing to the
  // bookmark tree from this page, which only the background engine does.
  function itemRow(entry, key, num, meta, onActivate, isCurrent, closeTabId) {
    const row = el("div", "row");
    const btn = el("button", "item" + (isCurrent ? " current" : ""));
    btn.type = "button";
    btn.dataset.key = key;
    btn.dataset.num = String(num);
    btn.title = entry.url;
    btn.append(
      el("span", "num", String(num)),
      iconFor(entry),
      el("span", "title", entry.title || entry.url),
      el("span", "meta", meta)
    );
    btn.addEventListener("click", onActivate);
    row.append(btn);
    if (closeTabId !== null && closeTabId !== undefined) {
      row.classList.add("closable");
      btn.dataset.tabId = String(closeTabId);
      const close = el("button", "close", "✕");
      close.type = "button";
      close.tabIndex = -1; // reachable with Delete on the row instead (see the keydown handler)
      close.title = "Close tab";
      close.setAttribute("aria-label", "Close tab");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(closeTabId, btn);
      });
      row.append(close);
    }
    return row;
  }

  // ---- numbering + matching ----

  // Every listed tab gets a number, in display order over the WHOLE,
  // unfiltered list of the sections being shown — this window, then the
  // other windows, then the other devices — so a tab keeps its number
  // while you type, and a tab inside a folded group has one too. A remote
  // tab that's also listed here reuses the local tab's number (it's the
  // same tab a click would switch to); only the others get numbers of
  // their own, after the local ones; recently archived tabs come last.
  // Numbers follow positions, so they shift when tabs open/close/move.
  function numberTabs(windows) {
    const local = new Map(); // local tab id → number
    let n = 0;
    for (const win of windows) {
      for (const entry of win.entries) for (const t of entryTabs(entry)) local.set(t.id, ++n);
    }
    const remote = new Map(); // `${device}|${url}` → number
    if (sections.otherDevices) {
      for (const device of remoteData.devices) {
        for (const t of device.tabs) {
          const mine = t.localTabId !== null && t.localTabId !== undefined && local.get(t.localTabId);
          remote.set(`${device.name}|${t.url}`, mine || ++n);
        }
      }
    }
    const archived = new Map(); // archive bookmark id → number
    if (sections.archived) {
      for (const day of archivedData.days) for (const t of day.tabs) archived.set(t.id, ++n);
    }
    return { local, remote, archived, max: n };
  }

  // A query of digits only is a tab number: it matches every tab whose
  // number STARTS with those digits (typing "1" on the way to "12" keeps
  // 12 in view), and the exact one gets selected (see markSelected).
  // Falls back to plain text search when no tab has such a number, so a
  // "2026" still finds titles containing it on a short list.
  function buildQuery(numbers) {
    const raw = searchEl.value.trim();
    const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    let digits = null;
    if (/^\d+$/.test(raw)) {
      const all = [...numbers.local.values(), ...numbers.remote.values(), ...numbers.archived.values()];
      if (all.some((num) => String(num).startsWith(raw))) digits = raw;
    }
    return {
      active: terms.length > 0,
      digits,
      hit(num, ...fields) {
        if (digits !== null) return String(num).startsWith(digits);
        if (terms.length === 0) return true;
        const haystack = fields.join(" ").toLowerCase();
        return terms.every((t) => haystack.includes(t));
      },
    };
  }

  // ---- actions ----

  async function switchTo(tabId, windowId) {
    try {
      await browser.windows.update(windowId, { focused: true });
      await browser.tabs.update(tabId, { active: true });
    } catch (e) {
      return; // closed in the meantime — the next refresh drops it from the list
    }
    if (selfTab && selfTab.id !== tabId) {
      try {
        await browser.tabs.remove(selfTab.id);
      } catch (e) {}
    }
  }

  async function openHere(url) {
    if (selfTab) {
      await browser.tabs.update(selfTab.id, { url });
    } else {
      location.href = url;
    }
  }

  // Closes one of this device's tabs from the list. Keyboard focus moves
  // on to the next entry first, so closing several in a row with Delete
  // keeps working; the tab-removed event then re-renders the list (and
  // renumbers it). A close here is a normal close as far as sync is
  // concerned — the same as closing the tab in the strip.
  async function closeTab(tabId, button) {
    if (document.activeElement === button) {
      const nav = navigables();
      const next = nav[nav.indexOf(button) + 1] || nav[nav.indexOf(button) - 1];
      if (next) next.focus();
      else searchEl.focus();
    }
    button.closest(".row").remove();
    try {
      await browser.tabs.remove(tabId);
    } catch (e) {}
    scheduleLocal(); // already gone, say — redraw from the real state either way
  }

  function isFolded(group) {
    const o = foldOverrides.get(group.id);
    if (o && o.browserCollapsed === group.collapsed) return o.collapsed;
    foldOverrides.delete(group.id); // the browser's own state moved on — it wins again
    return group.collapsed;
  }

  function toggleGroup(group) {
    foldOverrides.set(group.id, { collapsed: !isFolded(group), browserCollapsed: group.collapsed });
    render();
  }

  // ---- render ----

  // Tabs are laid out in a `.tab-grid`: one column on a narrow window,
  // two on a wide one (media query in newtab.html), filled in reading
  // order — a tab on the left, the next one on its right, and so on —
  // so the numbers still read in sequence. A group header always spans
  // the full width, with its own tabs in a grid of their own.

  function renderGroup(group, tabs, query, numbers, isMyWindow) {
    // While searching, every group with a match is open — a number typed
    // for a tab inside a folded group must still show that tab.
    const folded = !query.active && isFolded(group);
    const wrap = el("div", "group" + (folded ? " collapsed" : ""));
    const color = GROUP_COLORS[group.color] || GROUP_COLORS.grey;
    wrap.style.setProperty("--group-color", color);

    const header = el("button", "group-header");
    header.type = "button";
    header.dataset.key = `g:${group.id}`;
    header.setAttribute("aria-expanded", String(!folded));
    const dot = el("span", "dot");
    dot.style.background = color;
    header.append(
      dot,
      el("span", "", group.title || "Untitled group"),
      el("span", "count", String(tabs.length)),
      el("span", "chevron", "▾")
    );
    header.addEventListener("click", () => toggleGroup(group));

    const list = el("div", "group-tabs tab-grid");
    for (const t of tabs) {
      const num = numbers.local.get(t.id);
      list.append(itemRow(t, `t:${t.id}`, num, hostOf(t.url), () => switchTo(t.id, t.windowId), t.active && !isMyWindow, t.id));
    }
    wrap.append(header, list);
    return wrap;
  }

  function render() {
    const focusedKey = (document.activeElement && document.activeElement.dataset.key) || null;
    if (engine) {
      // A service is picked: this is a web search, not a tab search —
      // the tab list steps aside for the one web row.
      localEl.replaceChildren();
      remoteSectionEl.hidden = true;
      archivedSectionEl.hidden = true;
      emptyEl.hidden = true;
      renderWeb(false);
      markSelected({ active: true, digits: null });
      return;
    }
    const myWindowId = selfTab ? selfTab.windowId : null;
    const allWindows = localData.windows
      .slice()
      .sort((a, b) => Number(b.id === myWindowId) - Number(a.id === myWindowId));
    const labelWindows = allWindows.length > 1;
    const windows = allWindows.filter((w) => (w.id === myWindowId ? sections.thisWindow : sections.otherWindows));
    const numbers = numberTabs(windows);
    const query = buildQuery(numbers);
    document.querySelector("main").style.setProperty("--num-w", `${Math.max(2, String(numbers.max).length)}ch`);
    let visible = 0;

    // This device — the window this page lives in first, each window in
    // its own tab-strip order (newtab-core.js's `entries`).
    localEl.replaceChildren();
    for (const win of windows) {
      const isMyWindow = win.id === myWindowId;
      const block = document.createDocumentFragment();
      let run = null; // the grid consecutive ungrouped tabs go into
      let count = 0;

      for (const entry of win.entries) {
        if (entry.kind === "tab") {
          const t = entry.tab;
          const num = numbers.local.get(t.id);
          if (!query.hit(num, t.title, t.url)) continue;
          const meta = hostOf(t.url) + (t.pinned ? " · pinned" : "");
          if (!run) block.append((run = el("div", "tab-grid")));
          run.append(itemRow(t, `t:${t.id}`, num, meta, () => switchTo(t.id, t.windowId), t.active && !isMyWindow, t.id));
          count += 1;
        } else {
          const g = entry.group;
          const groupHit = query.active && query.digits === null && query.hit(0, g.title);
          const tabs = g.tabs.filter((t) => groupHit || query.hit(numbers.local.get(t.id), t.title, t.url, g.title));
          if (tabs.length === 0) continue;
          block.append(renderGroup(g, tabs, query, numbers, isMyWindow));
          run = null;
          count += tabs.length;
        }
      }

      if (count === 0) continue;
      // Labels stay those of the full window list, so hiding "this
      // window" doesn't renumber the others.
      const label = isMyWindow ? "This window" : `Window ${allWindows.indexOf(win) + 1}`;
      localEl.append(el("div", "section-title", labelWindows ? label : "Open tabs"), block);
      visible += count;
    }

    // Other devices.
    remoteEl.replaceChildren();
    let remoteVisible = 0;
    if (sections.otherDevices) {
      if (remoteData.paused && !query.active) {
        remoteEl.append(el("div", "note", "Sync is paused — tabs on your other devices aren't shown."));
      }
      for (const device of remoteData.devices) {
        const tabs = device.tabs.filter((t) =>
          query.hit(numbers.remote.get(`${device.name}|${t.url}`), t.title, t.url, device.name)
        );
        if (tabs.length === 0) continue;
        const grid = el("div", "tab-grid");
        for (const t of tabs) {
          const key = `${device.name}|${t.url}`;
          const isLocal = t.localTabId !== null && t.localTabId !== undefined;
          grid.append(
            itemRow(
              t,
              `r:${key}`,
              numbers.remote.get(key),
              isLocal ? "open here" : hostOf(t.url),
              () => (isLocal ? switchTo(t.localTabId, t.localWindowId) : openHere(t.url)),
              false
            )
          );
        }
        remoteEl.append(el("div", "sub-title", device.name), grid);
        remoteVisible += tabs.length;
      }
    }
    remoteSectionEl.hidden = remoteVisible === 0 && !(sections.otherDevices && remoteData.paused && !query.active);
    visible += remoteVisible;

    // Recently auto-archived tabs, newest day first — a click opens one
    // again right here, in this tab. Nothing is shown while sync is
    // paused (newtab-core.js doesn't read the archive then); the
    // other-devices section already says sync is paused.
    archivedEl.replaceChildren();
    let archivedVisible = 0;
    if (sections.archived) {
      for (const day of archivedData.days) {
        const tabs = day.tabs.filter((t) => query.hit(numbers.archived.get(t.id), t.title, t.url));
        if (tabs.length === 0) continue;
        const grid = el("div", "tab-grid");
        for (const t of tabs) {
          grid.append(itemRow(t, `a:${t.id}`, numbers.archived.get(t.id), hostOf(t.url), () => openHere(t.url), false));
        }
        archivedEl.append(el("div", "sub-title", dayLabel(day.date)), grid);
        archivedVisible += tabs.length;
      }
    }
    archivedTitleEl.textContent = `Auto-archived · ${archivedSpan()}`;
    archivedSectionEl.hidden = archivedVisible === 0;
    visible += archivedVisible;

    const nothingShown = !sections.thisWindow && !sections.otherWindows && !sections.otherDevices && !sections.archived;
    emptyEl.textContent = nothingShown
      ? "Every tab section is turned off — choose what this page shows in SyncMyTabs's settings."
      : "No matching tabs.";
    emptyEl.hidden = !(nothingShown || (query.active && visible === 0));
    renderWeb(visible > 0);
    markSelected(query);

    // A re-render (a tab finished loading somewhere, say) mustn't yank
    // keyboard focus out from under someone arrowing through the list.
    if (focusedKey) {
      const again = document.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      if (again) again.focus();
    }
  }

  // "Today", "Yesterday", else the date in the browser's language — for
  // an archive day folder's "YYYY-MM-DD" (this device's local calendar).
  function dayLabel(key) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ago = Math.round((today - date) / 86400000);
    if (ago === 0) return "Today";
    if (ago === 1) return "Yesterday";
    let text;
    try {
      text = date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
    } catch (e) {
      text = key;
    }
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  }

  function archivedSpan() {
    const n = Math.floor(Number(sections.archivedDays));
    return n === 1 ? "today" : `last ${n >= 1 ? n : NewtabSettings.DEFAULTS.archivedDays} days`;
  }

  // While searching, what Enter would open is highlighted: the exact
  // number match when the query is a number, the first matching tab
  // otherwise — or the web row, when no tab matches or a service is picked.
  function markSelected(query) {
    const items = Array.from(document.querySelectorAll("main .item"));
    for (const item of items) item.classList.remove("selected");
    if (!query.active) return;
    const web = items.find((n) => n.classList.contains("web"));
    const tabs = items.filter((n) => n !== web);
    const exact = query.digits !== null && tabs.find((n) => n.dataset.num === query.digits);
    const pick = engine ? web : exact || tabs[0] || web;
    if (pick) pick.classList.add("selected");
  }

  // ---- web search ----

  // Opens `url` here (or, with Ctrl/Cmd, in a new tab).
  function navigate(url, newTab) {
    if (newTab) browser.tabs.create({ url });
    else if (selfTab) browser.tabs.update(selfTab.id, { url });
    else location.href = url;
  }

  // What the web row does, for the current text: the picked service's
  // search; an address, opened as such; otherwise the browser's own
  // default search engine (search.query — whatever the user chose in the
  // browser, never a hardcoded one), with Google only as a fallback where
  // that API is missing. Called straight from the key/click handler:
  // Firefox only allows search.query from inside a user action.
  function runWebSearch(newTab) {
    const text = searchEl.value.trim();
    if (!text) return;
    if (engine) return navigate(engineUrl(engine, text, locale), newTab);
    const url = urlFromInput(text);
    if (url) return navigate(url, newTab);
    const api = browser.search;
    if (api && api.query) {
      api.query(newTab ? { text, disposition: "NEW_TAB" } : selfTab ? { text, tabId: selfTab.id } : { text });
    } else {
      navigate(engineUrl(engineForKey("g"), text, locale), newTab);
    }
  }

  function setEngine(next, fromPrefix) {
    engine = next;
    engineFromPrefix = !!(next && fromPrefix);
    chipEl.hidden = !engine;
    chipEl.textContent = engine ? engine.name : "";
    render();
  }

  // Tab / Shift+Tab after typing: through every service and back to
  // plain tab search, without retyping.
  function cycleEngine(dir) {
    const order = [null, ...SEARCH_ENGINES];
    const i = order.indexOf(engine);
    setEngine(order[(i + dir + order.length) % order.length], false);
  }

  // The web row (under the search box, only while something is typed)
  // and the line of services under it — each a real link, so a middle
  // click opens it in a new tab like any link.
  function renderWeb(tabsMatched) {
    const text = searchEl.value.trim();
    webActionsEl.replaceChildren();
    webActionsEl.hidden = !text && !engine;
    if (webActionsEl.hidden) return;

    const url = engine ? null : urlFromInput(text);
    const row = el("button", "item web");
    row.type = "button";
    row.dataset.key = "web";
    const label = !text
      ? `Type what to search on ${engine.name}`
      : engine
        ? `Search ${engine.name} for “${text}”`
        : url
          ? `Open ${text}`
          : `Search the web for “${text}”`;
    row.append(
      el("span", "num", engine ? engine.key : "↗"),
      el("span", "title", label),
      el("span", "meta", engine || !tabsMatched ? "↵" : "⇧ ↵")
    );
    row.disabled = !text;
    row.addEventListener("click", (e) => runWebSearch(e.ctrlKey || e.metaKey));
    webActionsEl.append(row);

    const list = el("div", "engines");
    const hint = el("span", "engines-hint", "⇥");
    hint.title = "Tab / Shift+Tab: switch the search service";
    list.append(hint);
    for (const e of SEARCH_ENGINES) {
      const a = el("a", "engine" + (e === engine ? " active" : ""));
      a.href = engineUrl(e, text, locale);
      a.title = `${e.name} — or type “${e.key} ” before your search`;
      a.append(el("span", "engine-key", e.key), document.createTextNode(e.name));
      a.addEventListener("click", (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || !text) return; // a plain link then
        ev.preventDefault();
        navigate(a.href, false);
      });
      list.append(a);
    }
    webActionsEl.append(list);
  }

  // ---- keyboard: type-to-search, Enter opens the selected match, arrows move ----

  function navigables() {
    return Array.from(document.querySelectorAll("main .item, main .group-header")).filter(
      (n) => n.offsetParent !== null
    );
  }

  // Up/Down move by ROW, which in the two-column grid isn't the same as
  // the next/previous element: the nearest row above/below, then the
  // entry in it closest horizontally (a group header spans both
  // columns). Left/Right step through reading order.
  function rowNeighbour(current, dir) {
    const r = current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (const n of navigables()) {
      const q = n.getBoundingClientRect();
      const dy = dir > 0 ? q.top - r.top : r.top - q.top;
      if (dy <= 1) continue;
      const dx = Math.abs(q.left + q.width / 2 - cx);
      if (dy < bestDy - 1 || (Math.abs(dy - bestDy) <= 1 && dx < bestDx)) {
        best = n;
        bestDy = dy;
        bestDx = dx;
      }
    }
    return best;
  }

  document.addEventListener("keydown", (e) => {
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (document.activeElement === searchEl) {
      if (e.key === "Enter") {
        const selected = document.querySelector("main .item.selected");
        if (e.shiftKey || (selected && selected.classList.contains("web"))) {
          e.preventDefault();
          runWebSearch(e.ctrlKey || e.metaKey);
        } else if (selected) {
          e.preventDefault();
          selected.click();
        }
      } else if (e.key === "Tab" && !modified && (searchEl.value.trim() || engine)) {
        e.preventDefault();
        cycleEngine(e.shiftKey ? -1 : 1);
      } else if (e.key === "Backspace" && engine && searchEl.selectionStart === 0 && searchEl.selectionEnd === 0) {
        // Backspace at the very start removes the service chip; a chip
        // that came from a typed prefix gives its letter back.
        e.preventDefault();
        if (engineFromPrefix && !searchEl.value) {
          dismissedPrefix = engine.key;
          searchEl.value = engine.key;
        }
        setEngine(null, false);
      } else if (e.key === "ArrowDown") {
        const target = document.querySelector("main .item.selected") || navigables()[0];
        if (target) {
          e.preventDefault();
          target.focus();
        }
      } else if (e.key === "Escape" && (searchEl.value || engine)) {
        e.preventDefault();
        searchEl.value = "";
        engine = null;
        chipEl.hidden = true;
        onSearchInput();
      }
      return;
    }

    const nav = navigables();
    const i = nav.indexOf(document.activeElement);
    if (i !== -1 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const next = rowNeighbour(nav[i], e.key === "ArrowDown" ? 1 : -1);
      if (next) next.focus();
      else if (e.key === "ArrowUp") searchEl.focus();
    } else if (i !== -1 && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const next = nav[i + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) next.focus();
    } else if (i !== -1 && e.key === "Delete" && nav[i].dataset.tabId) {
      e.preventDefault();
      closeTab(Number(nav[i].dataset.tabId), nav[i]);
    } else if (e.key === "Escape") {
      searchEl.focus();
    } else if (e.key.length === 1 && e.key !== " " && !modified) {
      // Typing anywhere on the page — a digit included — lands in the
      // search box.
      searchEl.focus();
    }
  });

  // The search bar stays pinned at the top while the list scrolls under
  // it; a new query jumps back to the start of the (now filtered) list.
  function onSearchInput() {
    if (!searchEl.value) dismissedPrefix = null;
    if (!engine) {
      const p = parsePrefix(searchEl.value);
      if (p && p.engine.key !== dismissedPrefix) {
        searchEl.value = p.rest;
        setEngine(p.engine, true);
        window.scrollTo(0, 0);
        return;
      }
    }
    render();
    window.scrollTo(0, 0);
  }
  searchEl.addEventListener("input", onSearchInput);

  // The selection highlight only means something while Enter would act
  // on it, i.e. while the search box has focus.
  searchEl.addEventListener("focus", () => document.body.classList.add("searching"));
  searchEl.addEventListener("blur", () => document.body.classList.remove("searching"));

  // Keyboard focus scrolling a row into view must clear the sticky
  // search bar (newtab.html's scroll-padding-top), so it needs the bar's
  // real height.
  function measureBar() {
    document.documentElement.style.setProperty("--bar-h", `${searchBarEl.offsetHeight}px`);
  }
  window.addEventListener("resize", measureBar);

  // ---- data loading + live refresh ----

  async function loadSections() {
    sections = await NewtabSettings.load();
  }

  async function loadLocal() {
    try {
      const data = await browser.runtime.sendMessage({ type: "NEWTAB_LOCAL" });
      if (data && Array.isArray(data.windows)) localData = data;
    } catch (e) {}
    render();
  }

  // Not even asked for while the section is turned off — no reason to
  // walk the bookmark tree for something that isn't shown.
  async function loadRemote() {
    if (!sections.otherDevices) return;
    try {
      const data = await browser.runtime.sendMessage({ type: "NEWTAB_REMOTE" });
      if (data && Array.isArray(data.devices)) remoteData = data;
    } catch (e) {}
    render();
  }

  // Same: not asked for while the section is off.
  async function loadArchived() {
    if (!sections.archived) return;
    try {
      const data = await browser.runtime.sendMessage({ type: "NEWTAB_ARCHIVED", days: sections.archivedDays });
      if (data && Array.isArray(data.days)) archivedData = data;
    } catch (e) {}
    render();
  }

  function debounce(fn, ms) {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // Only while this page is actually visible — a background new tab
  // has no reason to keep re-reading the bookmark tree. The remote half
  // (other devices + archived tabs, both read from bookmarks) is debounced
  // harder: every device's heartbeat is a bookmark change.
  const scheduleLocal = debounce(() => !document.hidden && loadLocal(), 150);
  const scheduleRemote = debounce(() => {
    if (document.hidden) return;
    loadRemote();
    loadArchived();
  }, 1000);

  for (const ev of ["onCreated", "onRemoved", "onMoved", "onActivated", "onAttached", "onDetached"]) {
    browser.tabs[ev].addListener(scheduleLocal);
  }
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    scheduleLocal();
    if (changeInfo.url) scheduleRemote(); // "open here" links follow local URLs
  });
  browser.tabs.onCreated.addListener(scheduleRemote);
  browser.tabs.onRemoved.addListener(scheduleRemote);
  if (browser.tabGroups) {
    // onUpdated covers a group being folded/unfolded in the browser.
    for (const ev of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) {
      if (browser.tabGroups[ev]) browser.tabGroups[ev].addListener(scheduleLocal);
    }
  }
  for (const ev of ["onCreated", "onChanged", "onRemoved", "onMoved"]) {
    browser.bookmarks[ev].addListener(scheduleRemote);
  }

  // Settings changed on the options page: applied live.
  NewtabSettings.onChange((settings) => {
    sections = settings;
    render();
    loadRemote();
    loadArchived();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      loadLocal();
      loadRemote();
      loadArchived();
    }
  });

  // ---- start ----

  measureBar();

  (async () => {
    try {
      selfTab = await browser.tabs.getCurrent();
    } catch (e) {}
    await loadSections();
    if (sections.focusSearch && selfTab && !/[?&]focus\b/.test(location.search)) {
      // A browser opens its new tab page with the cursor in the address
      // bar, and a page can't take it from there. Reloading this page in
      // the same tab (tabs.update) doesn't either: a navigation leaves
      // the focus where it was. What works is a tab that is BORN with a
      // normal address — the browser gives such a tab's content the
      // focus — so this page opens itself again in a new tab, at the same
      // place in the strip, and closes the original. Costs: the address
      // bar shows the page's own address instead of staying empty, and
      // the tab briefly blinks. Hence a setting (`focusSearch`, on by
      // default). `?focus` marks the second page so it doesn't loop.
      try {
        await browser.tabs.create({
          url: browser.runtime.getURL("newtab.html?focus"),
          windowId: selfTab.windowId,
          index: selfTab.index,
          active: true,
        });
        await browser.tabs.remove(selfTab.id);
        return;
      } catch (e) {} // couldn't: carry on as a normal new tab page
    }
    searchEl.focus();
    // autofocus may have focused it before the listener above existed.
    document.body.classList.toggle("searching", document.activeElement === searchEl);
    await loadLocal();
    loadRemote();
    loadArchived();
  })();
})();
