import { buildAuthHeaders } from "./auth.js?v=2.2.0.0.1";
import { state } from "./state.js?v=2.2.0.0.1";

// The Now Playing / Up Next panel options (cog beside the Dashboard heading).
// Saved server-wide in the `nowPlaying` config section, so every device shows
// the same panel. dashboard-modern.js reads them through nowPlayingOptions().

export const NOW_PLAYING_ITEM_COUNT_MAX = 3;
export const NOW_PLAYING_DEFAULTS = Object.freeze({ allowPartWatched: true, allowUpNext: true, itemCount: 3 });
const NOW_PLAYING_FLAGS = ["allowPartWatched", "allowUpNext"];

const hasDocument = typeof document !== "undefined";

export function nowPlayingOptions(config = state.savedConfig) {
  const saved = config?.nowPlaying || {};
  const count = Math.round(Number(saved.itemCount));
  return {
    allowPartWatched: saved.allowPartWatched === undefined ? NOW_PLAYING_DEFAULTS.allowPartWatched : saved.allowPartWatched === true,
    allowUpNext: saved.allowUpNext === undefined ? NOW_PLAYING_DEFAULTS.allowUpNext : saved.allowUpNext === true,
    itemCount: Number.isFinite(count) ? Math.min(NOW_PLAYING_ITEM_COUNT_MAX, Math.max(1, count)) : NOW_PLAYING_DEFAULTS.itemCount,
  };
}

async function saveNowPlayingOptions(options) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: buildAuthHeaders(state.token),
    body: JSON.stringify({ nowPlaying: options }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.details) && body.details.length ? `: ${body.details.join("; ")}` : "";
    throw new Error(`${body.error || `Save failed with ${response.status}`}${detail}`);
  }
  return body.config?.nowPlaying || options;
}

if (hasDocument) {
  const button = document.querySelector?.("#nowPlayingOptionsButton");
  const menu = document.querySelector?.("#nowPlayingOptionsMenu");
  if (button && menu) {
    const errorLine = menu.querySelector(".now-playing-option-error");
    const control = (key) => menu.querySelector(`[data-now-playing-option="${key}"]`);

    const showError = (message) => {
      if (!errorLine) return;
      errorLine.textContent = message || "";
      errorLine.classList.toggle("hidden", !message);
    };

    const renderMenu = () => {
      const options = nowPlayingOptions();
      for (const key of NOW_PLAYING_FLAGS) control(key).checked = options[key];
      // Do not overwrite a number the user is still typing.
      if (document.activeElement !== control("itemCount")) control("itemCount").value = String(options.itemCount);
    };

    const setOpen = (open) => {
      menu.classList.toggle("hidden", !open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        showError("");
        renderMenu();
        // Open just below the cog; its height differs by width (44px tap target on phones).
        const parent = menu.offsetParent;
        if (parent) {
          const gap = 6;
          const top = button.getBoundingClientRect().bottom - parent.getBoundingClientRect().top + gap;
          menu.style.top = `${Math.round(top)}px`;
        }
      }
    };

    const commit = async (changes) => {
      const previous = state.savedConfig;
      const next = { ...nowPlayingOptions(), ...changes };
      state.savedConfig = { ...previous, nowPlaying: next };
      document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
      showError("");
      try {
        const saved = await saveNowPlayingOptions(next);
        state.savedConfig = { ...state.savedConfig, nowPlaying: saved };
      } catch (error) {
        state.savedConfig = previous;
        showError(error.message || "Could not save.");
      }
      renderMenu();
      document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
    };

    button.addEventListener("click", () => setOpen(menu.classList.contains("hidden")));
    document.addEventListener("click", (event) => {
      if (menu.classList.contains("hidden")) return;
      if (menu.contains(event.target) || button.contains(event.target)) return;
      setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || menu.classList.contains("hidden")) return;
      setOpen(false);
      button.focus();
    });

    for (const key of NOW_PLAYING_FLAGS) {
      control(key).addEventListener("change", (event) => commit({ [key]: event.target.checked }));
    }
    control("itemCount").addEventListener("change", (event) => {
      const value = Number(event.target.value);
      if (!Number.isInteger(value) || value < 1 || value > NOW_PLAYING_ITEM_COUNT_MAX) {
        showError(`Enter a whole number from 1 to ${NOW_PLAYING_ITEM_COUNT_MAX}.`);
        event.target.value = String(nowPlayingOptions().itemCount);
        return;
      }
      commit({ itemCount: value });
    });
  }
}
