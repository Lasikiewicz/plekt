import { buildAuthHeaders } from "./auth.js?v=2.0.0.0.7";
import { state, elements, THEME_STYLE_KEY } from "./state.js?v=2.0.0.0.7";

export const APPEARANCE_DEFAULTS = {
  showLogoArt: true,
  showCast: true,
  showTrailers: true,
  showReviews: true,
  showImages: true,
  showRelated: true,
  textScale: 100,
};

const originalFontSizes = new WeakMap();
const stylesheetFontSizes = new Map();
const stylesheetIds = new WeakMap();
let textScaleObserver = null;
let activeTextScale = 1;
let nextStylesheetId = 1;

function scaledFontSize(value, scale) {
  if (scale === 1 || /^(inherit|initial|unset|revert|revert-layer)$/i.test(value.trim())) return value;
  return value.replace(/(-?(?:\d+\.?\d*|\.\d+))(rem|px|vw|vh|vmin|vmax|%|pt|pc|ch|ex|lh|rlh|cap|ic)(?=$|[^a-z])/gi,
    (_match, amount, unit) => `${Number(amount) * scale}${unit}`);
}

function scaleFontSizeDeclaration(owner, style, scale, cache = originalFontSizes) {
  if (!style) return;
  const current = style.getPropertyValue("font-size");
  if (!current) return;
  let record = cache.get(owner);
  if (!record) {
    record = { original: current, priority: style.getPropertyPriority("font-size"), last: current };
    cache.set(owner, record);
  } else if (current !== record.last) {
    record.original = current;
    record.priority = style.getPropertyPriority("font-size");
  }
  const next = scaledFontSize(record.original, scale);
  if (next !== current) style.setProperty("font-size", next, record.priority);
  // Read back what the browser stored: it rounds values such as 0.99000001rem,
  // so comparing against the unrounded string would mistake our own write for
  // a site change and compound the scale on every slider step.
  record.last = style.getPropertyValue("font-size");
}

function stylesheetId(sheet, index = 0) {
  if (sheet.href) return `href:${sheet.href}`;
  const owner = sheet.ownerNode;
  if (owner) {
    let id = stylesheetIds.get(owner);
    if (!id) {
      id = `inline:${nextStylesheetId++}`;
      stylesheetIds.set(owner, id);
    }
    return id;
  }
  return `sheet-index:${index}`;
}

function scaleStylesheetRules(rules, scale, sheetId, path = "") {
  if (!rules) return;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const rulePath = path ? `${path}.${index}` : String(index);
    if (rule.style) scaleFontSizeDeclaration(`${sheetId}:${rulePath}`, rule.style, scale, stylesheetFontSizes);
    if (rule.cssRules) scaleStylesheetRules(rule.cssRules, scale, sheetId, rulePath);
    if (rule.styleSheet) {
      try {
        const importedId = stylesheetId(rule.styleSheet);
        scaleStylesheetRules(rule.styleSheet.cssRules, scale, importedId);
      } catch { /* cross-origin imports are not app styles */ }
    }
  }
}

function scaleAllStylesheets(scale) {
  Array.from(document.styleSheets).forEach((sheet, index) => {
    try { scaleStylesheetRules(sheet.cssRules, scale, stylesheetId(sheet, index)); } catch { /* skip cross-origin stylesheets */ }
  });
}

function scaleInlineStyles(root, scale) {
  if (!(root instanceof Element)) return;
  if (root.hasAttribute("style")) scaleFontSizeDeclaration(root, root.style, scale);
  root.querySelectorAll?.("[style]").forEach((element) => scaleFontSizeDeclaration(element, element.style, scale));
}

function observeDynamicStyles() {
  if (textScaleObserver || typeof MutationObserver === "undefined") return;
  textScaleObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        scaleFontSizeDeclaration(record.target, record.target.style, activeTextScale);
      } else {
        if (record.target instanceof HTMLStyleElement) scaleAllStylesheets(activeTextScale);
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            scaleInlineStyles(node, activeTextScale);
            if (node.matches("style, link[rel='stylesheet']")) scaleAllStylesheets(activeTextScale);
            node.querySelectorAll("style, link[rel='stylesheet']").forEach(() => scaleAllStylesheets(activeTextScale));
          }
        }
      }
    }
  });
  textScaleObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
  document.addEventListener("load", (event) => {
    if (event.target instanceof HTMLLinkElement && event.target.rel === "stylesheet") scaleAllStylesheets(activeTextScale);
  }, true);
}

export function applyTextScale(value) {
  const percent = Math.min(130, Math.max(100, Number(value) || 100));
  activeTextScale = percent / 100;
  scaleAllStylesheets(activeTextScale);
  scaleInlineStyles(document.body, activeTextScale);
  observeDynamicStyles();
  const slider = document.querySelector("#appearTextScale");
  const output = document.querySelector("#appearTextScaleValue");
  if (slider) slider.value = String(percent);
  if (output) output.value = `${percent}%`;
}

export function applyAppearanceToBody(prefs) {
  try {
    localStorage.removeItem("plembfin_bio_media_layout");
  } catch {}
  document.body.classList.toggle("hide-logo-art", !prefs.showLogoArt);
  document.body.classList.toggle("hide-cast", !prefs.showCast);
  document.body.classList.toggle("hide-trailers", !prefs.showTrailers);
  document.body.classList.toggle("hide-reviews", !prefs.showReviews);
  document.body.classList.toggle("hide-images", !prefs.showImages);
  document.body.classList.toggle("hide-related", !prefs.showRelated);
  applyTextScale(prefs.textScale);
}

function populateAppearanceForm(prefs) {
  if (elements.appearShowLogoArt) elements.appearShowLogoArt.checked = prefs.showLogoArt;
  if (elements.appearShowCast) elements.appearShowCast.checked = prefs.showCast;
  if (elements.appearShowTrailers) elements.appearShowTrailers.checked = prefs.showTrailers;
  if (elements.appearShowReviews) elements.appearShowReviews.checked = prefs.showReviews;
  if (elements.appearShowImages) elements.appearShowImages.checked = prefs.showImages;
  if (elements.appearShowRelated) elements.appearShowRelated.checked = prefs.showRelated;
}

// Theme style (Classic or Modern) is per browser, like the light/dark mode, and
// independent of it. theme-boot.js applies the saved style before first paint;
// this keeps it in sync afterwards. Classic is the absence of data-style.
let themeStyleTransitionTimeout = null;

// Dispatched on document after the style changes, for features that render
// differently under Modern (modules/dashboard-modern.js).
export const THEME_STYLE_EVENT = "plembfin:theme-style";

export function isModernStyle() {
  return typeof document !== "undefined" && document.documentElement?.getAttribute("data-style") === "modern";
}

export function toggleThemeStyle() {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  clearTimeout(themeStyleTransitionTimeout);
  themeStyleTransitionTimeout = setTimeout(() => root.classList.remove("theme-transition"), 180);

  const modern = root.getAttribute("data-style") !== "modern";
  if (modern) root.setAttribute("data-style", "modern");
  else root.removeAttribute("data-style");
  try {
    if (modern) localStorage.setItem(THEME_STYLE_KEY, "modern");
    else localStorage.removeItem(THEME_STYLE_KEY);
  } catch { /* storage unavailable: the choice lasts for this page only */ }
  document.dispatchEvent(new CustomEvent(THEME_STYLE_EVENT));
}

// The sidebar toggle is static markup and module scripts run after parsing,
// so it can be bound here without a hook in app.js or app-events.js.
if (typeof document !== "undefined") {
  document.querySelector?.("#themeStyleButton")?.addEventListener("click", toggleThemeStyle);
}

export async function loadAppearanceSettings() {
  const response = await fetch("/api/appearance", { headers: buildAuthHeaders(state.token) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return;
  const prefs = { ...APPEARANCE_DEFAULTS, ...(body.appearance || {}) };
  applyAppearanceToBody(prefs);
  populateAppearanceForm(prefs);
}
