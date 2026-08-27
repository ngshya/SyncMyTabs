const DEFAULT_PROFILE = "default";

const statusEl = document.getElementById("status");
let statusTimer = null;
function flashStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "var(--status-error)" : "var(--status-ok)";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 1500);
}

// ------------------------------------------------------------
// Theme
// ------------------------------------------------------------
const themeSelect = document.getElementById("themePreference");
window.SyncMyTabsTheme.getThemePreference().then((v) => (themeSelect.value = v));
themeSelect.addEventListener("change", async () => {
  await window.SyncMyTabsTheme.setThemePreference(themeSelect.value);
  flashStatus("Saved ✓");
});

// ------------------------------------------------------------
// Sync on/off — also the master switch (pauses groups + archive too,
// see CLAUDE.md's "Master on/off switch").
// ------------------------------------------------------------
async function refreshSyncState() {
  const { syncEnabled } = await browser.storage.local.get("syncEnabled");
  const on = syncEnabled !== false; // default ON
  document.getElementById("syncToggle").checked = on;
  document.getElementById("pausedNote").hidden = on;
  document.getElementById("syncNow").disabled = !on;
}

document.getElementById("syncToggle").addEventListener("change", async (e) => {
  await browser.storage.local.set({ syncEnabled: e.target.checked });
  await refreshSyncState();
});

// ------------------------------------------------------------
// Device name / interval / lazy restore / TTL — auto-saved.
// ------------------------------------------------------------
const nameInput = document.getElementById("deviceName");
const intervalInput = document.getElementById("intervalMinutes");
const lazyInput = document.getElementById("openRestoredLazy");
const lazyRequireClickInput = document.getElementById("lazyRequireClick");
const ttlEnabledInput = document.getElementById("ttlEnabled");
const ttlDaysInput = document.getElementById("ttlDays");
const closeDuplicateTabsInput = document.getElementById("closeDuplicateTabs");

async function loadSettings() {
  const {
    deviceName,
    syncIntervalMinutes,
    openRestoredLazy,
    lazyRequireClick,
    ttlEnabled,
    ttlDays,
    closeDuplicateTabs,
  } = await browser.storage.local.get([
    "deviceName",
    "syncIntervalMinutes",
    "openRestoredLazy",
    "lazyRequireClick",
    "ttlEnabled",
    "ttlDays",
    "closeDuplicateTabs",
  ]);

  if (deviceName) nameInput.value = deviceName;
  intervalInput.value = syncIntervalMinutes || 1;
  lazyInput.checked = openRestoredLazy !== false; // default ON
  lazyRequireClickInput.checked = lazyRequireClick !== false; // default ON
  ttlEnabledInput.checked = ttlEnabled !== false; // default ON
  ttlDaysInput.value = ttlDays || 14;
  closeDuplicateTabsInput.checked = closeDuplicateTabs === true; // default OFF
}

nameInput.addEventListener("blur", async () => {
  const name = nameInput.value.trim();
  if (!name) return;
  await browser.storage.local.set({ deviceName: name });
  flashStatus("Saved ✓");
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameInput.blur();
});

intervalInput.addEventListener("change", async () => {
  const interval = Number(intervalInput.value);
  if (!interval || interval < 1) {
    flashStatus("Interval must be at least 1 minute", true);
    intervalInput.value = 1;
    return;
  }
  await browser.storage.local.set({ syncIntervalMinutes: interval });
  flashStatus("Saved ✓");
});

lazyInput.addEventListener("change", async () => {
  await browser.storage.local.set({ openRestoredLazy: lazyInput.checked });
  flashStatus("Saved ✓");
});

lazyRequireClickInput.addEventListener("change", async () => {
  await browser.storage.local.set({ lazyRequireClick: lazyRequireClickInput.checked });
  flashStatus("Saved ✓");
});

ttlEnabledInput.addEventListener("change", async () => {
  await browser.storage.local.set({ ttlEnabled: ttlEnabledInput.checked });
  flashStatus("Saved ✓");
});

ttlDaysInput.addEventListener("change", async () => {
  const days = Number(ttlDaysInput.value);
  if (!days || days < 1) {
    flashStatus("Cleanup threshold must be at least 1 day", true);
    ttlDaysInput.value = 14;
    return;
  }
  await browser.storage.local.set({ ttlDays: days });
  flashStatus("Saved ✓");
});

closeDuplicateTabsInput.addEventListener("change", async () => {
  await browser.storage.local.set({ closeDuplicateTabs: closeDuplicateTabsInput.checked });
  flashStatus("Saved ✓");
});

// ------------------------------------------------------------
// Profiles
// ------------------------------------------------------------
async function knownProfiles() {
  const { profiles } = await browser.runtime.sendMessage({
    type: "GET_ALL_KNOWN_PROFILES",
  });
  return profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
}

async function getActiveProfile() {
  const { activeProfile } = await browser.storage.local.get("activeProfile");
  return activeProfile || DEFAULT_PROFILE;
}

async function renderProfiles() {
  const [profiles, activeProfile] = await Promise.all([
    knownProfiles(),
    getActiveProfile(),
  ]);
  const listEl = document.getElementById("profileList");
  listEl.innerHTML = "";

  for (const name of profiles) {
    const row = document.createElement("div");
    row.className = "profile-row";

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    if (name === activeProfile) {
      const badge = document.createElement("span");
      badge.className = "badge badge-blue";
      badge.textContent = "Active";
      row.appendChild(badge);
    } else {
      const activateBtn = document.createElement("button");
      activateBtn.className = "secondary";
      activateBtn.textContent = "Set active";
      activateBtn.addEventListener("click", () => setActiveProfile(name));
      row.appendChild(activateBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Remove";
    deleteBtn.disabled = name === activeProfile || profiles.length <= 1;
    deleteBtn.title =
      name === activeProfile
        ? "Switch to another profile before removing this one"
        : profiles.length <= 1
        ? "At least one profile must remain"
        : "Removes it from this device's picker only — data on any device stays restorable";
    deleteBtn.addEventListener("click", () => removeProfileFromLocalList(name));
    row.appendChild(deleteBtn);

    listEl.appendChild(row);
  }
}

async function setActiveProfile(name) {
  await browser.storage.local.set({ activeProfile: name });
  await browser.runtime.sendMessage({ type: "SWITCH_PROFILE_AND_SAVE" });
  flashStatus(`Switched to "${name}" ✓`);
  await renderProfiles();
  await renderGroups();
}

async function removeProfileFromLocalList(name) {
  const { profiles } = await browser.storage.local.get("profiles");
  const list = profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
  const remaining = list.filter((p) => p !== name);
  await browser.storage.local.set({
    profiles: remaining.length ? remaining : [DEFAULT_PROFILE],
  });
  await renderProfiles();
}

document.getElementById("addProfile").addEventListener("click", async () => {
  const input = document.getElementById("newProfileName");
  const raw = input.value.trim();
  if (!raw) return;
  await browser.runtime.sendMessage({ type: "ADD_PROFILE", name: raw });
  input.value = "";
  flashStatus("Added ✓");
  await renderProfiles();
});
document.getElementById("newProfileName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addProfile").click();
});

// ------------------------------------------------------------
// Sync now
// ------------------------------------------------------------
document.getElementById("syncNow").addEventListener("click", async () => {
  const btn = document.getElementById("syncNow");
  const original = btn.textContent;
  btn.textContent = "Syncing...";
  btn.disabled = true;

  await browser.runtime.sendMessage({ type: "SYNC_NOW" });
  btn.textContent = "Synced ✓";

  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
});

// ------------------------------------------------------------
// Tab groups (leashing module — see groups-core.js / CLAUDE.md).
// Group RULES themselves sync via bookmarks (per active profile, like
// everything else); leashEnabled/ungroupUndeclared/startupDelay are
// per-device local preferences (browser.storage.local), same
// convention as syncEnabled/ttlDays/openRestoredLazy above.
// ------------------------------------------------------------
const groupsLeashEnabledInput = document.getElementById("groupsLeashEnabled");
const groupsUngroupUndeclaredInput = document.getElementById("groupsUngroupUndeclared");
const groupsPinToStartInput = document.getElementById("groupsPinToStart");
const groupsStartupDelayInput = document.getElementById("groupsStartupDelay");
const groupListEl = document.getElementById("groupList");
const groupEditorEl = document.getElementById("groupEditor");

let openGroupTitle = null; // which group's editor panel is currently shown, if any

async function loadGroupPrefs() {
  const { leashEnabled, ungroupUndeclared, startupDelaySeconds, pinToStart } =
    await browser.runtime.sendMessage({ type: "GROUPS_GET_PREFS" });
  groupsLeashEnabledInput.checked = leashEnabled !== false;
  groupsUngroupUndeclaredInput.checked = ungroupUndeclared === true;
  groupsPinToStartInput.checked = pinToStart === true;
  groupsStartupDelayInput.value = startupDelaySeconds || 15;
}

groupsLeashEnabledInput.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "GROUPS_SET_PREFS",
    leashEnabled: groupsLeashEnabledInput.checked,
  });
  flashStatus("Saved ✓");
});

groupsUngroupUndeclaredInput.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "GROUPS_SET_PREFS",
    ungroupUndeclared: groupsUngroupUndeclaredInput.checked,
  });
  flashStatus("Saved ✓");
});

groupsPinToStartInput.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "GROUPS_SET_PREFS",
    pinToStart: groupsPinToStartInput.checked,
  });
  flashStatus("Saved ✓");
});

groupsStartupDelayInput.addEventListener("change", async () => {
  let seconds = Math.round(Number(groupsStartupDelayInput.value));
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 15;
  groupsStartupDelayInput.value = seconds;
  await browser.runtime.sendMessage({
    type: "GROUPS_SET_PREFS",
    startupDelaySeconds: seconds,
  });
  flashStatus("Saved ✓");
});

async function renderGroups() {
  const { titles, rulesCounts, openTitles } = await browser.runtime.sendMessage({
    type: "GROUPS_LIST",
  });
  groupListEl.innerHTML = "";

  for (const title of titles) {
    const row = document.createElement("div");
    row.className = "group-row";

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = title;
    row.appendChild(nameEl);

    const countEl = document.createElement("span");
    countEl.className = "rule-count";
    const n = rulesCounts[title] || 0;
    countEl.textContent = n === 1 ? "1 rule" : `${n} rules`;
    row.appendChild(countEl);

    if (openTitles.includes(title)) {
      const badge = document.createElement("span");
      badge.className = "badge badge-green";
      badge.textContent = "Open";
      row.appendChild(badge);
    }

    const editBtn = document.createElement("button");
    editBtn.className = "secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openGroupEditor(title));
    row.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "GROUPS_DELETE", title });
      if (openGroupTitle === title) closeGroupEditor();
      flashStatus("Deleted ✓");
      await renderGroups();
    });
    row.appendChild(deleteBtn);

    groupListEl.appendChild(row);
  }
}

document.getElementById("addGroup").addEventListener("click", () => {
  const input = document.getElementById("newGroupName");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  openGroupEditor(title);
});
document.getElementById("newGroupName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addGroup").click();
});

function closeGroupEditor() {
  openGroupTitle = null;
  groupEditorEl.hidden = true;
  groupEditorEl.innerHTML = "";
}

async function openGroupEditor(title) {
  openGroupTitle = title;
  const { rules, openTabs } = await browser.runtime.sendMessage({
    type: "GROUPS_GET",
    title,
  });
  paintGroupEditor(title, rules, openTabs);
}

// Collects every rule row currently in the DOM, saves the whole set
// (an empty set deletes the group — see groups-core.js), then repaints
// both the editor (fresh state) and the group list (rule count/badge).
async function saveRulesFromEditor(title, openTabs) {
  const rows = groupEditorEl.querySelectorAll(".rule-editor-row");
  const rules = Array.from(rows)
    .map((row) => ({
      pattern: row.querySelector(".rule-pattern").value.trim(),
      openUrl: row.querySelector(".rule-open-url").value.trim(),
    }))
    .filter((r) => r.pattern || r.openUrl); // a rule needs at least one to mean anything

  await browser.runtime.sendMessage({ type: "GROUPS_SET", title, rules });
  flashStatus("Saved ✓");
  if (rules.length === 0) {
    closeGroupEditor();
  } else {
    paintGroupEditor(title, rules, openTabs);
  }
  await renderGroups();
}

function buildRuleEditorRow(title, rule, openTabs) {
  const row = document.createElement("div");
  row.className = "rule-editor-row";

  const patternLabel = document.createElement("label");
  patternLabel.textContent =
    "Leash pattern (which pages this covers, and what links must match to stay in-group)";
  const patternInput = document.createElement("input");
  patternInput.className = "rule-pattern";
  patternInput.placeholder = "*://example.com/*";
  patternInput.value = rule.pattern || "";
  patternLabel.appendChild(patternInput);
  row.appendChild(patternLabel);

  const openUrlLabel = document.createElement("label");
  openUrlLabel.textContent = "Reopen if missing on startup (optional)";
  const openUrlInput = document.createElement("input");
  openUrlInput.className = "rule-open-url";
  openUrlInput.placeholder = "https://example.com/";
  openUrlInput.value = rule.openUrl || "";
  openUrlLabel.appendChild(openUrlInput);
  row.appendChild(openUrlLabel);

  for (const input of [patternInput, openUrlInput]) {
    input.addEventListener("change", () => saveRulesFromEditor(title, openTabs));
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "danger delete-rule";
  deleteBtn.textContent = "Delete rule";
  deleteBtn.addEventListener("click", () => {
    row.remove();
    saveRulesFromEditor(title, openTabs);
  });
  row.appendChild(deleteBtn);

  return row;
}

function paintGroupEditor(title, rules, openTabs) {
  groupEditorEl.hidden = false;
  groupEditorEl.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "editor-title";
  heading.textContent = `Editing "${title}"`;
  groupEditorEl.appendChild(heading);

  const ruleList = document.createElement("div");
  for (const rule of rules) {
    ruleList.appendChild(buildRuleEditorRow(title, rule, openTabs));
  }
  groupEditorEl.appendChild(ruleList);

  const addRuleBtn = document.createElement("button");
  addRuleBtn.className = "secondary";
  addRuleBtn.textContent = "Add rule";
  addRuleBtn.addEventListener("click", () => {
    ruleList.appendChild(buildRuleEditorRow(title, {}, openTabs));
  });
  groupEditorEl.appendChild(addRuleBtn);

  // Quick-add: one button per currently-open tab in this group whose
  // URL isn't already covered by a rule — prefills pattern/openUrl from
  // that tab in one click.
  const existingPatterns = new Set(rules.map((r) => r.pattern));
  const candidates = (openTabs || []).filter(
    (t) => !existingPatterns.has(defaultPatternFor(t.url))
  );
  if (candidates.length > 0) {
    const quickAddTitle = document.createElement("div");
    quickAddTitle.className = "section-title";
    quickAddTitle.textContent = "Quick add from open tabs";
    groupEditorEl.appendChild(quickAddTitle);
    for (const tab of candidates) {
      const item = document.createElement("div");
      item.className = "quick-add-item";
      const label = document.createElement("span");
      label.textContent = tab.title || tab.url;
      item.appendChild(label);
      const btn = document.createElement("button");
      btn.className = "secondary";
      btn.textContent = "Use this page";
      btn.addEventListener("click", () => {
        const pattern = defaultPatternFor(tab.url);
        ruleList.appendChild(buildRuleEditorRow(title, { pattern, openUrl: tab.url }, openTabs));
        saveRulesFromEditor(title, openTabs);
      });
      item.appendChild(btn);
      groupEditorEl.appendChild(item);
    }
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "secondary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closeGroupEditor());
  groupEditorEl.appendChild(closeBtn);
}

// Suggested pattern for a URL: domain + full path, query/fragment
// dropped — same heuristic as groups-core.js's own defaultPatternForUrl,
// duplicated here since options.js doesn't load groups-core.js directly.
function defaultPatternFor(url) {
  try {
    const u = new URL(url);
    return `*://${u.hostname}${u.pathname}*`;
  } catch (e) {
    return "*";
  }
}

document.getElementById("groupsReconcileNow").addEventListener("click", async () => {
  const btn = document.getElementById("groupsReconcileNow");
  const original = btn.textContent;
  btn.textContent = "Checking...";
  btn.disabled = true;
  await browser.runtime.sendMessage({ type: "GROUPS_RECONCILE_NOW" });
  btn.textContent = "Done ✓";
  await renderGroups();
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
});

// ------------------------------------------------------------
// Auto-archive idle tabs (see archive-core.js / CLAUDE.md).
// archiveEnabled/archiveIdleDays are per-device local preferences, same
// convention as everything else above.
// ------------------------------------------------------------
const archiveEnabledInput = document.getElementById("archiveEnabled");
const archiveIdleDaysInput = document.getElementById("archiveIdleDays");

async function loadArchivePrefs() {
  const { archiveEnabled, archiveIdleDays } = await browser.runtime.sendMessage({
    type: "ARCHIVE_GET_PREFS",
  });
  archiveEnabledInput.checked = archiveEnabled === true; // default OFF
  archiveIdleDaysInput.value = archiveIdleDays || 3;
}

archiveEnabledInput.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "ARCHIVE_SET_PREFS",
    archiveEnabled: archiveEnabledInput.checked,
  });
  flashStatus("Saved ✓");
});

archiveIdleDaysInput.addEventListener("change", async () => {
  const days = Number(archiveIdleDaysInput.value);
  if (!days || days < 1) {
    flashStatus("Idle threshold must be at least 1 day", true);
    archiveIdleDaysInput.value = 3;
    return;
  }
  await browser.runtime.sendMessage({ type: "ARCHIVE_SET_PREFS", archiveIdleDays: days });
  flashStatus("Saved ✓");
});

document.getElementById("archiveNow").addEventListener("click", async () => {
  const btn = document.getElementById("archiveNow");
  const original = btn.textContent;
  btn.textContent = "Checking...";
  btn.disabled = true;
  await browser.runtime.sendMessage({ type: "ARCHIVE_RECONCILE_NOW" });
  btn.textContent = "Done ✓";
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
});

document.getElementById("version").textContent =
  "v" + browser.runtime.getManifest().version;

refreshSyncState();
loadSettings();
renderProfiles();
loadGroupPrefs();
renderGroups();
loadArchivePrefs();
