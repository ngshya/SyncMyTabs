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

async function refreshRestoreProfileSelect() {
  const select = document.getElementById("restoreProfileSelect");
  const list = await knownProfiles();
  select.innerHTML = "";
  for (const name of list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  await refreshDeviceList(select.value);
}

async function refreshDeviceList(profile) {
  const select = document.getElementById("deviceSelect");
  select.innerHTML = "";
  if (!profile) return;

  const { devices } = await browser.runtime.sendMessage({
    type: "GET_DEVICES_FOR_PROFILE",
    profile,
  });

  if (!devices || devices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No devices found";
    opt.disabled = true;
    select.appendChild(opt);
    document.getElementById("restoreReplace").disabled = true;
    document.getElementById("restoreAdd").disabled = true;
    return;
  }

  for (const name of devices) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  document.getElementById("restoreReplace").disabled = false;
  document.getElementById("restoreAdd").disabled = false;
}

document
  .getElementById("restoreProfileSelect")
  .addEventListener("change", (e) => refreshDeviceList(e.target.value));

document.getElementById("syncNow").addEventListener("click", async () => {
  const btn = document.getElementById("syncNow");
  const original = btn.textContent;
  btn.textContent = "Syncing...";
  btn.disabled = true;

  await browser.runtime.sendMessage({ type: "SYNC_NOW" });
  btn.textContent = "Synced ✓";

  await refresh();
  await refreshRestoreProfileSelect();

  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
});

async function handleManualRestore(mode) {
  const profile = document.getElementById("restoreProfileSelect").value;
  const device = document.getElementById("deviceSelect").value;
  const statusEl = document.getElementById("restoreStatus");
  if (!device || !profile) return;

  statusEl.textContent = "Opening tabs...";
  const result = await browser.runtime.sendMessage({
    type: "MANUAL_RESTORE",
    device,
    profile,
    mode,
  });

  statusEl.textContent = result?.ok
    ? `Done (${mode}) from ${device} / ${profile}.`
    : "No tabs found for this device/profile.";
  statusEl.style.color = result?.ok ? "#16a34a" : "#dc2626";

  setTimeout(() => {
    statusEl.textContent = "";
  }, 3000);
}

document
  .getElementById("restoreReplace")
  .addEventListener("click", () => handleManualRestore("replace"));

document
  .getElementById("restoreAdd")
  .addEventListener("click", () => handleManualRestore("add"));

document.getElementById("version").textContent =
  "v" + browser.runtime.getManifest().version;

refreshSyncState();
refresh();
refreshActiveProfileSelect();
refreshRestoreProfileSelect();
