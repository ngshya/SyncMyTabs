// ============================================================
// SyncMyTabs - theme.js
//
// Shared dark/light theme handling for popup.html and options.html.
// Reads `themePreference` from storage.local ("system" | "light" |
// "dark", default "system" — same as before this existed, following the
// OS via prefers-color-scheme) and stamps it as a data-theme attribute
// on <html> for theme.css's [data-theme] overrides to key off. Applied
// asynchronously on load — there's a brief flash of the OS-default
// theme before an explicit override applies, since browser.storage.local
// has no synchronous read; not worth the added complexity of a
// synchronous cache for a popup/options page this short-lived.
//
// Also listens for storage.onChanged so a theme change made in one page
// (e.g. options.html) is reflected live in another already-open one
// (e.g. the popup, if somehow open at the same time).
// ============================================================

(function () {
  async function getThemePreference() {
    const { themePreference } = await browser.storage.local.get("themePreference");
    return themePreference || "system";
  }

  async function setThemePreference(value) {
    await browser.storage.local.set({ themePreference: value });
    applyTheme(value);
  }

  function applyTheme(value) {
    if (value === "light" || value === "dark") {
      document.documentElement.setAttribute("data-theme", value);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.themePreference) return;
    applyTheme(changes.themePreference.newValue || "system");
  });

  getThemePreference().then(applyTheme);

  window.SyncMyTabsTheme = { getThemePreference, setThemePreference };
})();
