// ============================================================
// SyncMyTabs - newtab-matrix.js
//
// Optional "Matrix rain" behind the new tab page — the `matrixRain`
// setting (newtab-settings.js, off by default). Only ever drawn on a dark
// background (the dark or black theme, or "system" with the OS in dark
// mode): on a light page green rain just looks like noise. Kept well in
// the background so it never competes with the text in front of it: a
// canvas behind everything (newtab.html's #matrix, z-index -1), drawn at
// low opacity, and covered by the search bar and bookmarks bar's own
// solid backgrounds where the eye actually reads.
//
// Cheap on purpose: ~20 frames a second, nothing at all while the page
// is hidden (requestAnimationFrame doesn't run in a background tab) or
// while the setting is off or the theme is light, and not animated at all
// for someone whose system asks for reduced motion.
//
// Independent of the rest of the page: own file, own canvas, own
// listeners; it reads the setting and the page's background colour,
// nothing else.
// ============================================================

(function () {
  const canvas = document.getElementById("matrix");
  const ctx = canvas.getContext("2d");
  const FRAME_MS = 50;
  const FONT_PX = 16;
  const GLYPHS =
    "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

  let wanted = false; // the setting
  let running = false;
  let drops = [];
  let lastFrame = 0;
  let width = 0;
  let height = 0;

  // Dark = the page background itself is dark, whatever made it so (an
  // explicit theme or the OS) — read from the real computed colour so it
  // follows theme.css without knowing its rules.
  function pageIsDark() {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    if (!m) return false;
    const [r, g, b] = m.slice(1).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 80;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${FONT_PX}px monospace`;
    const columns = Math.ceil(width / FONT_PX);
    // Each column starts somewhere above the top, so the rain doesn't
    // arrive as one straight line.
    drops = Array.from({ length: columns }, () => -Math.floor(Math.random() * (height / FONT_PX)));
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    // Fade what's already there (trails), on a transparent canvas — so
    // whatever the theme's background colour is shows through unchanged.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#3dff7a";
    for (let i = 0; i < drops.length; i++) {
      const y = drops[i] * FONT_PX;
      if (y >= 0) ctx.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], i * FONT_PX, y);
      if (y > height && Math.random() > 0.975) drops[i] = 0;
      else drops[i] += 1;
    }
  }

  function update() {
    const on = wanted && !reducedMotion.matches && pageIsDark();
    canvas.hidden = !on;
    if (on && !running) {
      running = true;
      resize();
      requestAnimationFrame(frame);
    } else if (!on && running) {
      running = false;
      ctx.clearRect(0, 0, width, height);
    }
  }

  window.addEventListener("resize", () => running && resize());
  // Theme changes: theme.js stamps data-theme on <html>; "system" follows
  // the OS — both re-checked.
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  darkScheme.addEventListener("change", update);
  reducedMotion.addEventListener("change", update);

  NewtabSettings.onChange((settings) => {
    wanted = !!settings.matrixRain;
    update();
  });
  NewtabSettings.load().then((settings) => {
    wanted = !!settings.matrixRain;
    update();
  });
})();
