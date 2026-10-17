// ============================================================
// SyncMyTabs - newtab-clock.js
//
// The new tab page's clock and date: in the browser's own language
// (NewtabDom.uiLocale); 24-hour (`clock24h`, on by default — off falls
// back to that language's own format, AM/PM for English) and with seconds
// (`clockSeconds`, on by default) per newtab-settings.js, applied live.
// ============================================================

(function () {
  const timeEl = document.getElementById("time");
  const dateEl = document.getElementById("date");
  const locale = NewtabDom.uiLocale();
  // [24h][seconds] → formatter. 24-hour: always two-digit hours, 00–23.
  const timeFmts = {};
  for (const h24 of [true, false]) {
    for (const sec of [true, false]) {
      timeFmts[`${h24}${sec}`] = new Intl.DateTimeFormat(locale, {
        hour: h24 ? "2-digit" : "numeric",
        minute: "2-digit",
        ...(sec ? { second: "2-digit" } : {}),
        ...(h24 ? { hourCycle: "h23" } : {}),
      });
    }
  }
  const dateFmt = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (locale) dateEl.lang = locale; // so ::first-letter capitalizes by that language's rules

  let seconds = NewtabSettings.DEFAULTS.clockSeconds;
  let h24 = NewtabSettings.DEFAULTS.clock24h;

  function tick() {
    const now = new Date();
    timeEl.textContent = timeFmts[`${h24}${seconds}`].format(now);
    dateEl.textContent = dateFmt.format(now);
  }

  tick();
  setInterval(tick, 1000);
  const apply = (settings) => {
    seconds = !!settings.clockSeconds;
    h24 = !!settings.clock24h;
    tick();
  };
  NewtabSettings.load().then(apply);
  NewtabSettings.onChange(apply);
})();
