// ============================================================
// SyncMyTabs - newtab-clock.js
//
// The new tab page's clock and date: in the browser's own language
// (NewtabDom.uiLocale), seconds shown or not per the `clockSeconds`
// setting (newtab-settings.js, on by default), applied live.
// ============================================================

(function () {
  const timeEl = document.getElementById("time");
  const dateEl = document.getElementById("date");
  const locale = NewtabDom.uiLocale();
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const timeFmtSeconds = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (locale) dateEl.lang = locale; // so ::first-letter capitalizes by that language's rules

  let seconds = NewtabSettings.DEFAULTS.clockSeconds;

  function tick() {
    const now = new Date();
    timeEl.textContent = (seconds ? timeFmtSeconds : timeFmt).format(now);
    dateEl.textContent = dateFmt.format(now);
  }

  tick();
  setInterval(tick, 1000);
  const apply = (settings) => {
    seconds = !!settings.clockSeconds;
    tick();
  };
  NewtabSettings.load().then(apply);
  NewtabSettings.onChange(apply);
})();
