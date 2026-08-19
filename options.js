const nameInput = document.getElementById("deviceName");
const intervalInput = document.getElementById("intervalMinutes");
const lazyInput = document.getElementById("openRestoredLazy");
const ttlEnabledInput = document.getElementById("ttlEnabled");
const ttlDaysInput = document.getElementById("ttlDays");
const status = document.getElementById("status");
const lastActivityEl = document.getElementById("lastActivity");
const profileListEl = document.getElementById("profileList");
const newProfileInput = document.getElementById("newProfileName");

const DEFAULT_PROFILE = "default";

document.getElementById("version").textContent =
  "v" + browser.runtime.getManifest().version;

async function getKnownProfiles() {
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
    getKnownProfiles(),
    getActiveProfile(),
  ]);
  profileListEl.innerHTML = "";

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
      activateBtn.style.marginTop = "0";
      activateBtn.textContent = "Set active";
      activateBtn.addEventListener("click", () => setActiveProfile(name));
      row.appendChild(activateBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.style.marginTop = "0";
    deleteBtn.textContent = "Remove from list";
    deleteBtn.disabled = name === activeProfile || profiles.length <= 1;
    deleteBtn.title =
      name === activeProfile
        ? "Switch to another profile before removing this one"
        : profiles.length <= 1
        ? "At least one profile must remain"
        : "Removes it from this device's picker only — data already saved for it on any device is kept and still restorable";
    deleteBtn.addEventListener("click", () => removeProfileFromLocalList(name));
    row.appendChild(deleteBtn);

    profileListEl.appendChild(row);
  }
}

async function setActiveProfile(name) {
  await browser.storage.local.set({ activeProfile: name });
  // Immediately reconcile under the newly active profile, instead of
  // waiting for the next alarm cycle.
  await browser.runtime.sendMessage({ type: "SWITCH_PROFILE_AND_SAVE" });
  await renderProfiles();
}

async function removeProfileFromLocalList(name) {
  // Only removes it from THIS device's local "profiles" list (the
  // picker). It does not delete any bookmark data — a profile that
  // still exists as a folder on any device will keep showing up here
  // too, since the picker is the union of local + synced names.
  const { profiles } = await browser.storage.local.get("profiles");
  const list = profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
  const remaining = list.filter((p) => p !== name);
  await browser.storage.local.set({
    profiles: remaining.length ? remaining : [DEFAULT_PROFILE],
  });
  await renderProfiles();
}

document.getElementById("addProfile").addEventListener("click", async () => {
  const raw = newProfileInput.value.trim();
  if (!raw) return;

  await browser.runtime.sendMessage({ type: "ADD_PROFILE", name: raw });
  newProfileInput.value = "";
  await renderProfiles();
});

newProfileInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addProfile").click();
});

// Preload existing values, if any
browser.storage.local
  .get([
    "deviceName",
    "syncIntervalMinutes",
    "openRestoredLazy",
    "ttlEnabled",
    "ttlDays",
    "lastActivityTimestamp",
  ])
  .then(
    ({
      deviceName,
      syncIntervalMinutes,
      openRestoredLazy,
      ttlEnabled,
      ttlDays,
      lastActivityTimestamp,
    }) => {
      if (deviceName) nameInput.value = deviceName;
      if (syncIntervalMinutes) intervalInput.value = syncIntervalMinutes;
      lazyInput.checked = openRestoredLazy !== false; // default ON
      ttlEnabledInput.checked = ttlEnabled !== false; // default ON
      ttlDaysInput.value = ttlDays || 21;
      lastActivityEl.textContent = lastActivityTimestamp
        ? new Date(lastActivityTimestamp).toLocaleString()
        : "none";
    }
  );

renderProfiles();

document.getElementById("save").addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const interval = Number(intervalInput.value);
  const ttlDays = Number(ttlDaysInput.value);

  if (!name) {
    status.textContent = "Please enter a valid name.";
    status.style.color = "#dc2626";
    return;
  }
  if (!interval || interval < 1) {
    status.textContent = "The interval must be at least 1 minute.";
    status.style.color = "#dc2626";
    return;
  }
  if (ttlEnabledInput.checked && (!ttlDays || ttlDays < 1)) {
    status.textContent = "The cleanup threshold must be at least 1 day.";
    status.style.color = "#dc2626";
    return;
  }

  await browser.storage.local.set({
    deviceName: name,
    syncIntervalMinutes: interval,
    openRestoredLazy: lazyInput.checked,
    ttlEnabled: ttlEnabledInput.checked,
    ttlDays: ttlDays || 21,
  });

  status.textContent = `Saved: "${name}", checking every ${interval} min, lazy restore ${
    lazyInput.checked ? "on" : "off"
  }, cleanup ${
    ttlEnabledInput.checked ? `after ${ttlDays} days` : "off"
  }. Closing this tab...`;
  status.style.color = "#16a34a";

  setTimeout(() => {
    browser.tabs.getCurrent().then((tab) => {
      if (tab && tab.id !== undefined) {
        browser.tabs.remove(tab.id);
      }
    });
  }, 900);
});
