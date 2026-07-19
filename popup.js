const DEFAULT_PROFILE = "default";

async function refresh() {
  const { deviceName, syncIntervalMinutes, lastSeenTimestamp } =
    await chrome.storage.local.get([
      "deviceName",
      "syncIntervalMinutes",
      "lastSeenTimestamp",
    ]);

  document.getElementById("deviceName").textContent =
    deviceName || "not configured";
  document.getElementById("interval").textContent = syncIntervalMinutes
    ? `${syncIntervalMinutes} min`
    : "1 min (default)";
  document.getElementById("lastSeen").textContent = lastSeenTimestamp
    ? new Date(lastSeenTimestamp).toLocaleString()
    : "none";
}

async function refreshActiveProfileSelect() {
  const { activeProfile } = await chrome.storage.local.get("activeProfile");
  const active = activeProfile || DEFAULT_PROFILE;

  const { profiles } = await chrome.runtime.sendMessage({
    type: "GET_ALL_KNOWN_PROFILES",
  });
  const list = profiles && profiles.length ? profiles : [DEFAULT_PROFILE];

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

    await chrome.storage.local.set({ activeProfile: chosen });
    await chrome.runtime.sendMessage({ type: "SWITCH_PROFILE_AND_SAVE" });

    btn.textContent = "Done ✓";
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  });

async function refreshDeviceList() {
  const select = document.getElementById("deviceSelect");
  const { devices } = await chrome.runtime.sendMessage({
    type: "GET_DEVICES",
  });

  select.innerHTML = "";

  if (!devices || devices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No devices found";
    opt.disabled = true;
    select.appendChild(opt);
    document.getElementById("restoreReplace").disabled = true;
    document.getElementById("restoreAdd").disabled = true;
    document.getElementById("profileSelect").innerHTML = "";
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

  await refreshProfileList(select.value);
}

async function refreshProfileList(deviceName) {
  const profileSelect = document.getElementById("profileSelect");
  profileSelect.innerHTML = "";
  if (!deviceName) return;

  const { profiles } = await chrome.runtime.sendMessage({
    type: "GET_PROFILES_FOR_DEVICE",
    device: deviceName,
  });

  if (!profiles || profiles.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No profiles found";
    opt.disabled = true;
    profileSelect.appendChild(opt);
    return;
  }

  for (const name of profiles) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    profileSelect.appendChild(opt);
  }
}

document
  .getElementById("deviceSelect")
  .addEventListener("change", (e) => refreshProfileList(e.target.value));

document.getElementById("syncNow").addEventListener("click", async () => {
  const btn = document.getElementById("syncNow");
  const original = btn.textContent;
  btn.textContent = "Syncing...";
  btn.disabled = true;

  const result = await chrome.runtime.sendMessage({ type: "SYNC_NOW" });

  btn.textContent = result?.updateFound ? "Update found ✓" : "No update found";

  await refresh();
  await refreshDeviceList();

  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1800);
});

async function handleManualRestore(mode) {
  const device = document.getElementById("deviceSelect").value;
  const profile = document.getElementById("profileSelect").value;
  const statusEl = document.getElementById("restoreStatus");
  if (!device || !profile) return;

  statusEl.textContent = "Opening tabs...";
  const result = await chrome.runtime.sendMessage({
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

refresh();
refreshActiveProfileSelect();
refreshDeviceList();
