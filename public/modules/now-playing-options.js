import { buildAuthHeaders } from "./auth.js?v=2.2.4.3.0";
import { state } from "./state.js?v=2.2.4.3.0";

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

async function savePanelOptions(options, section) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: buildAuthHeaders(state.token),
    body: JSON.stringify({ [section]: options }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.details) && body.details.length ? `: ${body.details.join("; ")}` : "";
    throw new Error(`${body.error || `Save failed with ${response.status}`}${detail}`);
  }
  return body.config?.[section] || options;
}

if (hasDocument) {
  const button = document.querySelector?.("#nowPlayingOptionsButton");
  const menu = document.querySelector?.("#nowPlayingOptionsMenu");
  if (button && menu) {
    // Keep the popup outside the dashboard's clipped card/scroll containers.
    document.body.append(menu);
    const errorLine = menu.querySelector(".now-playing-option-error");
    const control = (key) => menu.querySelector(`[data-now-playing-option="${key}"]`);
    const syncControl = menu.querySelector('[data-up-next-sync-option="enabled"]');

    const showError = (message) => {
      if (!errorLine) return;
      errorLine.textContent = message || "";
      errorLine.classList.toggle("hidden", !message);
    };

    const renderMenu = () => {
      const options = nowPlayingOptions();
      for (const key of NOW_PLAYING_FLAGS) control(key).checked = options[key];
      if (syncControl) syncControl.checked = state.savedConfig?.upNextSync?.enabled !== false;
      // Do not overwrite a number the user is still typing.
      if (document.activeElement !== control("itemCount")) control("itemCount").value = String(options.itemCount);
    };

    const positionMenu = () => {
      if (menu.classList.contains("hidden")) return;
      const rect = button.getBoundingClientRect();
      const gap = 6;
      const inset = 8;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - inset);
      const above = Math.max(0, rect.top - gap - inset);
      const flip = below < 240 && above > below;
      menu.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
      menu.style.left = `${Math.max(inset, Math.min(rect.left, window.innerWidth - menu.offsetWidth - inset))}px`;
      menu.style.top = `${flip ? Math.max(inset, rect.top - gap - menu.offsetHeight) : rect.bottom + gap}px`;
    };

    const setOpen = (open) => {
      menu.classList.toggle("hidden", !open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        showError("");
        renderMenu();
        positionMenu();
      }
    };

    let saveQueue = Promise.resolve();
    const pendingKeys = new Map();
    const commit = (changes, section = "nowPlaying") => {
      const previous = { ...(section === "nowPlaying" ? nowPlayingOptions() : state.savedConfig?.[section]) };
      const key = Object.keys(changes)[0];
      const keyId = `${section}:${key}`;
      const user = state.currentUser;
      const token = state.token;
      const sessionIsCurrent = () => state.currentUser === user && state.token === token;
      let pending = pendingKeys.get(keyId);
      if (!pending || pending.user !== user || pending.token !== token) {
        pending = { confirmed: previous[key], revision: 0, count: 0, user, token };
        pendingKeys.set(keyId, pending);
      }
      const revision = ++pending.revision;
      pending.count += 1;
      state.savedConfig = { ...state.savedConfig, [section]: { ...previous, ...changes } };
      document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
      showError("");
      saveQueue = saveQueue.then(async () => {
        try {
          if (!sessionIsCurrent()) return;
          // The server merges individual section fields. Sending only this
          // change avoids overwriting settings refreshed elsewhere in the UI.
          const saved = await savePanelOptions(changes, section);
          if (!sessionIsCurrent()) return;
          pending.confirmed = saved[key] ?? changes[key];
          if (pending.revision === revision) {
            state.savedConfig = { ...state.savedConfig, [section]: { ...state.savedConfig?.[section], [key]: pending.confirmed } };
          }
        } catch (error) {
          if (!sessionIsCurrent()) return;
          if (pending.revision === revision) {
            state.savedConfig = { ...state.savedConfig, [section]: { ...state.savedConfig?.[section], [key]: pending.confirmed } };
            showError(error.message || "Could not save.");
          }
        } finally {
          pending.count -= 1;
          if (!pending.count && pendingKeys.get(keyId) === pending) pendingKeys.delete(keyId);
          if (sessionIsCurrent()) {
            renderMenu();
            document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
          }
        }
      });
      return saveQueue;
    };

    button.addEventListener("click", () => setOpen(menu.classList.contains("hidden")));
    window.addEventListener("resize", positionMenu);
    document.addEventListener("scroll", positionMenu, true);
    document.addEventListener("plembfin:config-changed", renderMenu);
    syncControl?.addEventListener("change", async (event) => {
      syncControl.disabled = true;
      try {
        await commit({ enabled: event.target.checked }, "upNextSync");
      } finally {
        syncControl.disabled = false;
      }
    });
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
