// ============================================================
// SyncMyTabs - newtab-options.js
//
// The custom new tab page's own card on the options page: one checkbox
// per new tab page setting (which tab sections show, the bookmarks bar,
// the clock's seconds, search-box focus, matrix rain) — or a number field
// for a numeric one (how many days of archived tabs). The settings
// themselves — key, defaults, labels — live in newtab-settings.js, which
// options.html loads just before this; this file only draws the card.
//
// Kept out of options.js on purpose — like the rest of the new tab page
// feature, nothing that existed before it knows it exists (see
// test/newtab-isolation.test.js): options.html only loads these two
// scripts, and this one builds its card itself, with the page's existing
// card styles, and appends it after the other cards.
//
// The card is DOM-built (textContent only), saved on every change to
// storage.local like every other preference; the new tab page listens for
// the change, so an open one follows it live.
// ============================================================

(function () {
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
    el("div", "card-desc", "Choose what the SyncMyTabs new tab page shows and how it looks. The clock and the search box are always there."),
    body
  );

  const inputs = {};
  let group = null;
  for (const [key, value, label, groupName] of NewtabSettings.OPTIONS) {
    if (groupName !== group) {
      group = groupName;
      body.append(el("div", "section-title", groupName));
    }
    const row = el("label", "checkbox-row");
    const input = el("input");
    if (typeof value === "number") {
      // A number setting: its label first, then the field (the options
      // page's own number-input styles), indented under the checkbox above
      // it, which it refines.
      row.style.paddingLeft = "24px";
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.style.width = "64px";
      input.value = String(value);
      row.append(document.createTextNode(label), input);
    } else {
      input.type = "checkbox";
      input.checked = value;
      row.append(input, document.createTextNode(label));
    }
    inputs[key] = input;
    body.append(row);
  }

  // A number field left empty, below 1 or fractional saves as the nearest
  // whole number ≥ 1 (its default when it's not a number at all).
  function readInput(key) {
    const input = inputs[key];
    if (input.type !== "number") return input.checked;
    let n = Math.floor(Number(input.value));
    if (!(n >= 1)) n = input.value.trim() === "" || Number.isNaN(n) ? NewtabSettings.DEFAULTS[key] : 1;
    input.value = String(n);
    return n;
  }

  async function save() {
    const values = {};
    for (const key of Object.keys(inputs)) values[key] = readInput(key);
    await NewtabSettings.save(values);
    // options.js's own "Saved ✓" flash, when it's there.
    if (typeof flashStatus === "function") flashStatus("Saved ✓");
  }
  for (const input of Object.values(inputs)) input.addEventListener("change", save);

  NewtabSettings.load().then((settings) => {
    for (const key of Object.keys(inputs)) {
      if (inputs[key].type === "number") inputs[key].value = String(settings[key]);
      else inputs[key].checked = !!settings[key];
    }
  });

  // After the last card, before the status line / version footer.
  const anchor = document.getElementById("status");
  anchor.parentNode.insertBefore(card, anchor);
})();
