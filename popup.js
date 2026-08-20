const DEFAULT_PROFILE = "default";

const statusEl = document.getElementById("status");
let statusTimer = null;
function flashStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#dc2626" : "#16a34a";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 1500);
}

// ------------------------------------------------------------
// Sync on/off
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
const ttlEnabledInput = document.getElementById("ttlEnabled");
const ttlDaysInput = document.getElementById("ttlDays");

async function loadSettings() {
  const {
    deviceName,
    syncIntervalMinutes,
    openRestoredLazy,
    ttlEnabled,
    ttlDays,
    lastActivityTimestamp,
  } = await browser.storage.local.get([
    "deviceName",
    "syncIntervalMinutes",
    "openRestoredLazy",
    "ttlEnabled",
    "ttlDays",
    "lastActivityTimestamp",
  ]);

  if (deviceName) nameInput.value = deviceName;
  intervalInput.value = syncIntervalMinutes || 1;
  lazyInput.checked = openRestoredLazy !== false; // default ON
  ttlEnabledInput.checked = ttlEnabled !== false; // default ON
  ttlDaysInput.value = ttlDays || 14;
  document.getElementById("lastActivity").textContent = lastActivityTimestamp
    ? new Date(lastActivityTimestamp).toLocaleString()
    : "none";
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
      badge.className = "badge";
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

  await loadSettings();

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
