// ============================================================
// SyncMyTabs - newtab-options.js
//
// The custom new tab page's own card on the options page: which tab
// sections newtab.html shows (this window / other windows / other
// devices). Kept out of options.js on purpose — like the rest of the new
// tab page feature, nothing that existed before it knows it exists (see
// test/newtab-isolation.test.js): options.html only loads this script,
// and this script builds its card itself, with the page's existing card
// styles, and appends it after the other cards.
//
// The card is DOM-built (textContent only), saved per checkbox on change
// to storage.local like every other preference; newtab.js listens for
// the change, so an open new tab page follows it live.
// ============================================================

(function () {
  // Same key and defaults as newtab.js.
  const SECTIONS_KEY = "newtabSections";
  const DEFAULT_SECTIONS = { thisWindow: true, otherWindows: true, otherDevices: true };

  const OPTIONS = [
    ["thisWindow", "Tabs in the current window"],
    ["otherWindows", "Tabs in your other windows"],
    ["otherDevices", "Tabs on your other devices"],
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const card = el("div", "card");
  const header = el("div", "card-header");
  header.append(el("span", "card-title", "New tab page"));
  const body = el("div", "card-body");
  card.append(
    header,
    el(
      "div",
      "card-desc",
      "Choose which tabs the SyncMyTabs new tab page lists. The clock and the search box are always there."
    ),
    body
  );

  const inputs = {};
  for (const [key, label] of OPTIONS) {
    const row = el("label", "checkbox-row");
    const input = el("input");
    input.type = "checkbox";
    input.checked = DEFAULT_SECTIONS[key];
    inputs[key] = input;
    row.append(input, document.createTextNode(label));
    body.append(row);
  }

  async function save() {
    const value = {};
    for (const [key] of OPTIONS) value[key] = inputs[key].checked;
    await browser.storage.local.set({ [SECTIONS_KEY]: value });
    // options.js's own "Saved ✓" flash, when it's there.
    if (typeof flashStatus === "function") flashStatus("Saved ✓");
  }
  for (const [key] of OPTIONS) inputs[key].addEventListener("change", save);

  browser.storage.local.get(SECTIONS_KEY).then(({ [SECTIONS_KEY]: saved }) => {
    const sections = { ...DEFAULT_SECTIONS, ...(saved && typeof saved === "object" ? saved : {}) };
    for (const [key] of OPTIONS) inputs[key].checked = !!sections[key];
  });

  // After the last card, before the status line / version footer.
  const anchor = document.getElementById("status");
  anchor.parentNode.insertBefore(card, anchor);
})();
