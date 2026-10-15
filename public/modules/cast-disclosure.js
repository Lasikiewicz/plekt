import { escapeAttribute, escapeHtml } from "./utils.js?v=2.0.0.0.9";
import { tmdbProfile } from "./images.js?v=2.0.0.0.9";

export function renderCastActor(actor = {}) {
  const avatarUrl = tmdbProfile(actor.profile_path) || "/favicon.svg";
  return `
            <div class="cast-member-card" style="cursor: pointer;" data-person-id="${actor.id}" data-person-name="${escapeAttribute(actor.name)}">
              <img class="cast-avatar-img" src="${escapeAttribute(avatarUrl)}" alt="${escapeAttribute(actor.name)}" loading="lazy" decoding="async" data-err="fav" />
              <span class="cast-actor-name">${escapeHtml(actor.name)}</span>
              <span class="cast-character-name">${escapeHtml(actor.character)}</span>
            </div>
          `;
}

export function hydrateDeferredCastDisclosure(trigger) {
  if (!trigger || trigger.dataset.castHydrated === "true") return;
  let cast = [];
  try {
    cast = JSON.parse(trigger.dataset.castMore || "[]");
  } catch {
    cast = [];
  }
  trigger.insertAdjacentHTML("afterend", cast.map(renderCastActor).join(""));
  trigger.dataset.castHydrated = "true";
  // The trigger is removed, so move focus to the first revealed actor rather
  // than letting it fall back to <body> for keyboard and screen-reader users.
  const firstRevealed = trigger.nextElementSibling;
  const hadFocus = trigger === document.activeElement;
  trigger.remove();
  if (hadFocus && firstRevealed instanceof HTMLElement) {
    firstRevealed.setAttribute("tabindex", "-1");
    firstRevealed.focus();
  }
}
