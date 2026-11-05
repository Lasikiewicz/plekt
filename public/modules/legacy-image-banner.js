// Notice for installs still running the retiring Plembfin Docker image.
//
// The server reports `legacyImage: true` only when the image was built with
// PLEKT_LEGACY_IMAGE=1 (the Plembfin tags). On the Plekt image, bare metal and
// local development the route answers `legacyImage: false` and nothing is drawn.
//
// It is a small card pinned to the top centre rather than a row in the page
// layout, so it cannot disturb any view (the dashboard is a fixed-height grid).
// Dismissing hides it for the installed version only, so it returns after every
// update until the install switches to the Plekt image.

const BANNER_ID = "legacy-image-banner";
const STYLE_ID = "legacy-image-banner-style";
const DISMISS_KEY = "plekt.legacyImageBannerDismissedFor";

const STYLE = `
.legacy-image-banner{position:fixed;top:calc(1rem + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);z-index:60;box-sizing:border-box;width:min(25rem,calc(100vw - 2rem));display:grid;gap:.6rem;padding:.9rem 1rem;border:1px solid var(--border,rgba(127,127,127,.35));border-radius:.75rem;background:var(--surface,#141b22);color:var(--text,#f8fafc);box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:.86rem;line-height:1.45}
.legacy-image-banner-title{margin:0;font-size:.95rem;font-weight:700}
.legacy-image-banner p{margin:0;color:var(--text-muted,inherit);opacity:.92}
.legacy-image-banner ul{margin:0;padding:0;list-style:none;display:grid;gap:.25rem}
.legacy-image-banner code{display:block;padding:.3rem .5rem;border-radius:.45rem;background:rgba(127,127,127,.16);font-size:.8rem;overflow-wrap:anywhere}
.legacy-image-banner-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.15rem}
.legacy-image-banner a.legacy-image-banner-link,.legacy-image-banner button{min-height:2.25rem;padding:.35rem .85rem;border-radius:.6rem;font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.legacy-image-banner a.legacy-image-banner-link{background:#f59e0b;color:#1c1200;text-decoration:none;border:1px solid transparent}
.legacy-image-banner button{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.5)}
@media (max-width:760px){.legacy-image-banner{left:.75rem;right:.75rem;width:auto;transform:none;top:calc(.75rem + env(safe-area-inset-top,0px))}}
`;

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; }
}

function writeDismissed(version) {
  try { localStorage.setItem(DISMISS_KEY, version); } catch { /* storage unavailable: it returns next load */ }
}

function formatDate(isoDate) {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? isoDate
    : parsed.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function renderLegacyImageBanner(notice, host = document.body) {
  if (!notice?.legacyImage || !host || document.getElementById(BANNER_ID)) return null;
  if (readDismissed() === String(notice.version || "")) return null;

  if (!document.getElementById(STYLE_ID)) {
    document.head.append(element("style", { id: STYLE_ID, textContent: STYLE }));
  }

  const [ghcr, hub] = notice.newImages || [];
  const dismiss = element("button", { type: "button", textContent: "Dismiss" });
  const banner = element(
    "aside",
    { id: BANNER_ID, className: "legacy-image-banner" },
    element("h2", { className: "legacy-image-banner-title", textContent: "This Docker image is being retired" }),
    element("p", { textContent: "Plekt was formerly Plembfin, and the Plembfin image will stop receiving updates. Switch to the Plekt image:" }),
    element("ul", {}, element("li", {}, element("code", { textContent: ghcr })), element("li", {}, element("code", { textContent: `${hub} (Docker Hub)` }))),
    element("p", { textContent: `Your data, settings and tag stay the same. The old name keeps receiving updates until at least ${formatDate(notice.supportedUntil)}.` }),
    element(
      "div",
      { className: "legacy-image-banner-actions" },
      element("a", { className: "legacy-image-banner-link", href: notice.switchUrl, target: "_blank", rel: "noopener noreferrer", textContent: "How to switch" }),
      dismiss,
    ),
  );
  banner.setAttribute("role", "status");
  dismiss.addEventListener("click", () => {
    writeDismissed(String(notice.version || ""));
    banner.remove();
  });
  host.append(banner);
  return banner;
}

async function checkLegacyImage() {
  try {
    const response = await fetch("/api/legacy-image", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    renderLegacyImageBanner(await response.json());
  } catch { /* offline or signed out: no notice */ }
}

// The app shell stays hidden until the user is signed in. Check once it appears.
function start() {
  const shell = document.querySelector("#appShell");
  if (!shell) return;
  let checked = false;
  const run = () => {
    if (checked || shell.classList.contains("hidden")) return;
    checked = true;
    observer.disconnect();
    checkLegacyImage();
  };
  const observer = new MutationObserver(run);
  observer.observe(shell, { attributes: true, attributeFilter: ["class"] });
  run();
}

if (typeof document !== "undefined") start();
