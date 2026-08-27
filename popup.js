// Compact toolbar popup: status, one on/off switch per feature module,
// a "Sync now" quick action, and a link to the full options page
// (options.html) for everything else — device name, profiles, check
// interval, per-feature detail settings, tab-group rule editors, and
// the theme selector. See CLAUDE.md for why this was split out of what
// used to be a single, much longer popup.

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

const syncToggle = document.getElementById("syncToggle");
const groupsToggle = document.getElementById("groupsToggle");
const archiveToggle = document.getElementById("archiveToggle");

async function refresh() {
  const [{ syncEnabled, activeProfile, lastActivityTimestamp }, groupPrefs, archivePrefs] =
    await Promise.all([
      browser.storage.local.get([
        "syncEnabled",
        "activeProfile",
        "lastActivityTimestamp",
      ]),
      browser.runtime.sendMessage({ type: "GROUPS_GET_PREFS" }),
      browser.runtime.sendMessage({ type: "ARCHIVE_GET_PREFS" }),
    ]);

  const on = syncEnabled !== false; // default ON
  syncToggle.checked = on;
  document.getElementById("pausedNote").hidden = on;
  document.getElementById("syncNow").disabled = !on;
  groupsToggle.checked = groupPrefs.leashEnabled !== false;
  archiveToggle.checked = archivePrefs.archiveEnabled === true; // default OFF

  document.getElementById("profileName").textContent = activeProfile || DEFAULT_PROFILE;
  document.getElementById("lastActivity").textContent = lastActivityTimestamp
    ? new Date(lastActivityTimestamp).toLocaleString()
    : "none";
}

syncToggle.addEventListener("change", async () => {
  await browser.storage.local.set({ syncEnabled: syncToggle.checked });
  flashStatus("Saved ✓");
  await refresh();
});

groupsToggle.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "GROUPS_SET_PREFS",
    leashEnabled: groupsToggle.checked,
  });
  flashStatus("Saved ✓");
});

archiveToggle.addEventListener("change", async () => {
  await browser.runtime.sendMessage({
    type: "ARCHIVE_SET_PREFS",
    archiveEnabled: archiveToggle.checked,
  });
  flashStatus("Saved ✓");
});

document.getElementById("syncNow").addEventListener("click", async () => {
  const btn = document.getElementById("syncNow");
  const original = btn.textContent;
  btn.textContent = "Syncing...";
  btn.disabled = true;

  await browser.runtime.sendMessage({ type: "SYNC_NOW" });
  btn.textContent = "Synced ✓";

  await refresh();

  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
});

document.getElementById("openOptions").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("options.html") });
});

document.getElementById("version").textContent =
  "v" + browser.runtime.getManifest().version;

refresh();
