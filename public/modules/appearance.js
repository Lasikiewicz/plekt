import { buildAuthHeaders } from "./auth.js?v=1.3.1.3.0";
import { state, elements, THEME_STYLE_KEY } from "./state.js?v=1.3.1.3.0";

export const APPEARANCE_DEFAULTS = {
  showLogoArt: true,
  showCast: true,
  showTrailers: true,
  showReviews: true,
  showImages: true,
  showRelated: true,
};

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
