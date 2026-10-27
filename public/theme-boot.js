// Theme boot: a small classic script loaded with a blocking <script> in <head>,
// so it runs before the body is parsed. It applies the saved (or system) theme
// before first paint and gives each theme-aware logo its correct image.
//
// The logo <img> elements in index.html deliberately have no src. With a src in
// the markup, the browser's preload scanner requests that image before any
// script can run, and it cannot read the saved theme, so a light-mode load paid
// for the dark logo as well (and a <picture> with a prefers-color-scheme source
// only moved the problem to users whose saved theme differs from the system).
// app.js keeps the theme in sync after this point (initializeTheme and
// updateThemeIcon), including the theme toggle.
(() => {
  const THEME_KEY = "plembfin:theme";
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable: follow the system */ }
  const prefersDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
  const light = saved === "light" || (saved === null && !prefersDark);
  document.documentElement.classList.toggle("light-mode", light);

  // Modern is the only theme style. The old Classic/Modern choice
  // (plembfin:style) is cleared so no stale value lingers.
  try { localStorage.removeItem("plembfin:style"); } catch { /* storage unavailable */ }

  // Card Art and Background Art (Appearance menu, modules/appearance.js) are on
  // unless this browser turned them off; set here so artwork that is off never
  // flashes in.
  for (const [key, attribute] of [["plekt:card-art", "data-card-art"], ["plekt:background-art", "data-background-art"]]) {
    let value = null;
    try { value = localStorage.getItem(key); } catch { /* storage unavailable: on */ }
    if (value === "off") document.documentElement.setAttribute(attribute, "off");
  }

  const logo = light ? "/plekt_header_logo_light.png?v=2.2.0.0.1" : "/plekt_header_logo_dark.png?v=2.2.0.0.1";
  const preload = document.createElement("link");
  preload.rel = "preload";
  preload.as = "image";
  preload.href = logo;
  document.head.appendChild(preload);

  const assign = (img) => {
    if (!img.getAttribute("src")) img.src = logo;
  };
  const assignWithin = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches("img[data-theme-logo]")) assign(node);
    for (const img of node.querySelectorAll("img[data-theme-logo]")) assign(img);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) assignWithin(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => {
    observer.disconnect();
    assignWithin(document.documentElement);
  }, { once: true });
})();
