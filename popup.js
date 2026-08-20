const DEFAULT_PROFILE = "default";

async function refreshSyncState() {
  const { syncEnabled } = await browser.storage.local.get("syncEnabled");
  const on = syncEnabled !== false; // default ON
  document.getElementById("syncToggle").checked = on;
  document.getElementById("pausedNote").hidden = on;
  // "Sync now" is a sync action, so it's unavailable while paused.
  document.getElementById("syncNow").disabled = !on;
}

document.getElementById("syncToggle").addEventListener("change", async (e) => {
  await browser.storage.local.set({ syncEnabled: e.target.checked });
  await refreshSyncState();
});

async function refresh() {
  const { deviceName, syncIntervalMinutes, lastActivityTimestamp } =
    await browser.storage.local.get([
      "deviceName",
      "syncIntervalMinutes",
      "lastActivityTimestamp",
    ]);

  document.getElementById("deviceName").textContent =
    deviceName || "not configured";
  document.getElementById("interval").textContent = syncIntervalMinutes
    ? `${syncIntervalMinutes} min`
    : "1 min (default)";
  document.getElementById("lastActivity").textContent = lastActivityTimestamp
    ? new Date(lastActivityTimestamp).toLocaleString()
    : "none";
}

async function knownProfiles() {
  const { profiles } = await browser.runtime.sendMessage({
    type: "GET_ALL_KNOWN_PROFILES",
  });
  return profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
}

async function refreshActiveProfileSelect() {
  const { activeProfile } = await browser.storage.local.get("activeProfile");
  const active = activeProfile || DEFAULT_PROFILE;
  const list = await knownProfiles();

  const select = document.getElementById("activeProfileSelect");
  select.innerHTML = "";
  for (const name of list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === active) opt.selected = true;
    select.appendChild(opt);
  }
}

document
  .getElementById("switchProfile")
  .addEventListener("click", async () => {
    const select = document.getElementById("activeProfileSelect");
    const chosen = select.value;
    const btn = document.getElementById("switchProfile");
    const original = btn.textContent;
    btn.textContent = "...";
    btn.disabled = true;

    await browser.storage.local.set({ activeProfile: chosen });
    await browser.runtime.sendMessage({ type: "SWITCH_PROFILE_AND_SAVE" });

    btn.textContent = "Done ✓";
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
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

document.getElementById("version").textContent =
  "v" + browser.runtime.getManifest().version;

refreshSyncState();
refresh();
refreshActiveProfileSelect();
