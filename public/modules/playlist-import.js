// "Import from apps" dialog (plan/archive/custom-playlist-sync/plan.md decisions 21 to 28).
// Lists each connected app's playlists that no Plekt playlist is linked to
// yet. A picked row offers Merge / Import separately on a name clash (Merge by
// default) and the apps to sync to, with only its own app ticked. Smart
// playlists are counted, not listed. playlists.js passes its helpers in, so
// this module imports only utils.
import { escapeAttribute, escapeHtml, platformIconUrl } from "./utils.js?v=2.1.0.0.0";

const APP_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
const APP_ORDER = ["plex", "emby", "jellyfin"];
const KIND_LABELS = { movie: "Movies", tv: "TV", mixed: "Mixed", empty: "Empty" };

function appLabel(provider) {
  return APP_LABELS[provider] || provider;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function candidateKey(candidate = {}) {
  return `${candidate.provider}:${candidate.id}`;
}

// Movies and TV alone do not merge; Mixed or an empty playlist fits either.
function kindsMerge(left, right) {
  const kinds = new Set([left, right].filter((kind) => kind && kind !== "empty"));
  return kinds.size < 2 || kinds.has("mixed");
}

// How a candidate can merge: into an existing Plekt playlist
// ({ mergeInto }), with same-name playlists picked from other apps
// ({ apps }), or not at all (null).
export function importMergeOption(candidate = {}, candidates = new Map()) {
  const clash = candidate.clash || {};
  if (clash.merge_into) return { mergeInto: clash.merge_into };
  if (clash.name_taken || !candidate.kind_guess) return null;
  const apps = (clash.same_name || [])
    .map((ref) => candidates.get(`${ref.provider}:${ref.id}`))
    .filter((other) => other && other.provider !== candidate.provider && other.kind_guess
      && !other.clash?.name_taken && kindsMerge(candidate.kind_guess, other.kind_guess))
    .map((other) => other.provider);
  return apps.length ? { apps: [...new Set(apps)] } : null;
}

function separateName(candidate) {
  const clash = candidate.clash || {};
  return clash.name_taken || clash.same_name?.length ? `${candidate.title} (${appLabel(candidate.provider)})` : candidate.title;
}

function candidateSummary(candidate) {
  if (candidate.error) return "Could not read its items";
  return `${plural(Number(candidate.item_count || 0), "item")} · ${KIND_LABELS[candidate.kind_guess] || "Unknown"}`;
}

function modeHtml(candidate, option) {
  const key = candidateKey(candidate);
  const separate = `Import separately as "${separateName(candidate)}"`;
  if (!option) {
    if (!candidate.clash?.name_taken) return "";
    return `<p class="playlist-import-note">A playlist named "${escapeHtml(candidate.title)}" already exists, so this one is imported as "${escapeHtml(separateName(candidate))}".</p>`;
  }
  const merge = option.mergeInto
    ? `Merge into your "${option.mergeInto.name}" playlist`
    : `Merge with "${candidate.title}" from ${option.apps.map(appLabel).join(" and ")}, if picked`;
  return `
    <fieldset class="playlist-import-mode">
      <legend class="playlist-import-note">Same name as ${option.mergeInto ? "a Plekt playlist" : "a playlist in another app"}. Merging keeps everything from both, nothing is removed.</legend>
      <label><input type="radio" name="mode:${escapeAttribute(key)}" value="merge" checked /> <span>${escapeHtml(merge)}</span></label>
      <label><input type="radio" name="mode:${escapeAttribute(key)}" value="separate" /> <span>${escapeHtml(separate)}</span></label>
    </fieldset>
  `;
}

function targetsHtml(candidate, connected) {
  const key = candidateKey(candidate);
  const choices = APP_ORDER.filter((provider) => provider === candidate.provider || connected.includes(provider)).map((provider) => {
    const source = provider === candidate.provider;
    return `
      <label class="playlist-provider-choice">
        <input type="checkbox" name="targets:${escapeAttribute(key)}" value="${provider}"${source ? " checked disabled" : ""} />
        <img src="${escapeAttribute(platformIconUrl(provider))}" alt="" loading="lazy" decoding="async" />
        <span>${appLabel(provider)}</span>
      </label>
    `;
  }).join("");
  return `<div class="playlist-import-targets"><span class="playlist-import-note">Sync to</span><div class="playlist-provider-choices">${choices}</div></div>`;
}

function rowHtml(candidate, candidates, connected) {
  const key = candidateKey(candidate);
  const other = Number(candidate.other_count || 0);
  return `
    <li class="playlist-import-row" data-import-row="${escapeAttribute(key)}">
      <label class="playlist-import-pick">
        <input type="checkbox" name="import" value="${escapeAttribute(key)}"${candidate.error ? " disabled" : ""} />
        <span class="playlist-import-title">${escapeHtml(candidate.title || "Untitled")}</span>
        <small>${escapeHtml(candidateSummary(candidate))}</small>
      </label>
      ${candidate.error ? `<p class="playlist-import-note">${escapeHtml(candidate.error)}</p>` : ""}
      ${other ? `<p class="playlist-import-note">${plural(other, "item")} ${other === 1 ? "is" : "are"} not a movie or episode and stay${other === 1 ? "s" : ""} in ${appLabel(candidate.provider)} only.</p>` : ""}
      <div class="playlist-import-options" data-import-options hidden>
        ${modeHtml(candidate, importMergeOption(candidate, candidates))}
        ${targetsHtml(candidate, connected)}
      </div>
    </li>
  `;
}

// apps: the list-import-candidates result; connected: apps that can be ticked.
export function importDialogBodyHtml(apps = [], connected = []) {
  if (!apps.length) {
    return `<p class="personal-media-dialog-copy">Connect Plex, Emby, or Jellyfin in Settings to import their playlists.</p>`;
  }
  const candidates = new Map(apps.flatMap((app) => app.playlists || []).map((candidate) => [candidateKey(candidate), candidate]));
  return apps.map((app) => {
    const label = appLabel(app.provider);
    const playlists = app.playlists || [];
    const smart = Number(app.smart_skipped || 0);
    let body;
    if (app.status === "error") body = `<p class="playlist-import-note is-error">Could not read the ${escapeHtml(label)} playlists: ${escapeHtml(app.error || "unknown error")}</p>`;
    else if (!playlists.length) body = `<p class="playlist-import-note">No ${escapeHtml(label)} playlists to import.</p>`;
    else body = `<ul class="playlist-import-list">${playlists.map((candidate) => rowHtml(candidate, candidates, connected)).join("")}</ul>`;
    return `
      <section class="playlist-import-app">
        <h3><img src="${escapeAttribute(platformIconUrl(app.provider))}" alt="" loading="lazy" decoding="async" /> ${escapeHtml(label)}</h3>
        ${body}
        ${smart ? `<p class="playlist-import-note">${plural(smart, "smart playlist")} ${smart === 1 ? "is" : "are"} not listed: rule-based playlists cannot be imported.</p>` : ""}
      </section>
    `;
  }).join("");
}

// The picked rows, ready for the list-import action.
export function importPicks(form, apps = []) {
  const candidates = new Map(apps.flatMap((app) => app.playlists || []).map((candidate) => [candidateKey(candidate), candidate]));
  return [...form.querySelectorAll("input[name=import]:checked")].map((box) => {
    const candidate = candidates.get(box.value);
    if (!candidate) return null;
    const option = importMergeOption(candidate, candidates);
    const row = box.closest("[data-import-row]");
    const chosen = row?.querySelector("input[type=radio]:checked")?.value;
    const mode = option && chosen !== "separate" ? "merge" : "separate";
    const targets = [...(row?.querySelectorAll("[data-import-options] input[type=checkbox]:checked") || [])].map((target) => target.value);
    return {
      provider: candidate.provider,
      remote_playlist_id: candidate.id,
      mode,
      ...(mode === "merge" && option.mergeInto ? { merge_into: option.mergeInto.id } : {}),
      targets,
    };
  }).filter(Boolean);
}

export function importResultMessage(result = {}) {
  const lists = Array.isArray(result.lists) ? result.lists : [];
  const names = lists.map((list) => `"${list.name}"`).join(", ");
  const parts = [`Imported ${plural(lists.length, "playlist")}: ${names}.`];
  if (!result.synced) {
    parts.push("Their items arrive at the next sync, within 5 minutes.");
  } else {
    const unidentified = lists.reduce((sum, list) => sum + Number(list.unidentified || 0), 0);
    if (unidentified) parts.push(`${plural(unidentified, "item")} could not be identified and stay${unidentified === 1 ? "s" : ""} in the app only.`);
    const errors = lists.flatMap((list) => list.errors || []);
    if (errors.length) parts.push(`The first sync had problems: ${errors.join("; ")}`);
  }
  return parts.join(" ");
}

export function openPlaylistImportDialog({ helpers, connected = [] }) {
  const overlay = helpers.dialogFrame("Import from apps", `
    <form class="personal-media-create-form playlist-import">
      <p class="personal-media-dialog-copy">Pick playlists you made in Plex, Emby, or Jellyfin. Each one becomes a Plekt playlist and stays in sync from then on.</p>
      <div class="playlist-import-apps" data-import-body><p class="personal-media-dialog-copy">Loading playlists from your apps...</p></div>
      <p class="personal-media-dialog-error hidden" data-personal-dialog-error role="alert"></p>
      <div class="personal-media-dialog-actions"><button class="button-ghost personal-media-dialog-close" type="button">Cancel</button><button class="button-primary" type="submit" disabled>Import</button></div>
    </form>
  `);
  const form = overlay.querySelector("form");
  const body = form?.querySelector("[data-import-body]");
  const submit = form?.querySelector("[type=submit]");
  const errorMessage = form?.querySelector("[data-personal-dialog-error]");
  let apps = [];
  let submitting = false;
  const showError = (message) => {
    if (!errorMessage || !overlay.isConnected) return;
    errorMessage.textContent = message;
    errorMessage.classList.toggle("hidden", !message);
  };
  const updateSubmit = () => {
    const count = form?.querySelectorAll("input[name=import]:checked").length || 0;
    if (!submit || submitting) return;
    submit.disabled = count === 0;
    submit.textContent = count ? `Import ${plural(count, "playlist")}` : "Import";
  };

  helpers.personalRequest({ action: "list-import-candidates" }).then((result) => {
    if (!overlay.isConnected || !body) return;
    apps = Array.isArray(result?.apps) ? result.apps : [];
    body.innerHTML = importDialogBodyHtml(apps, connected);
    updateSubmit();
  }).catch((error) => {
    if (body && overlay.isConnected) body.innerHTML = "";
    showError(error?.message || "Could not read the app playlists.");
  });

  form?.addEventListener("change", (event) => {
    const box = event.target instanceof Element ? event.target.closest("input[name=import]") : null;
    const options = box?.closest("[data-import-row]")?.querySelector("[data-import-options]");
    if (options) options.hidden = !box.checked;
    updateSubmit();
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const picks = importPicks(form, apps);
    if (!picks.length || submitting) return;
    submitting = true;
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Importing...";
    }
    showError("");
    try {
      const result = await helpers.personalRequest({ action: "list-import", picks });
      await helpers.loadPersonalMedia({ force: true });
      helpers.closePersonalDialog(overlay);
      helpers.setMessage(importResultMessage(result), result?.lists?.some((list) => list.errors?.length) ? "error" : "success");
    } catch (error) {
      submitting = false;
      updateSubmit();
      showError(error?.message || "Unable to import the playlists.");
    }
  });
  return overlay;
}
