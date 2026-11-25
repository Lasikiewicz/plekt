// Self-contained upgrading screen served while one-time startup database
// compaction is running. Uses external scripts (/theme-boot.js and
// /upgrade-status.js) so it stays fully compatible with script-src 'self' CSP.

export function renderUpgradeScreenHtml(initialStatus = {}) {
  const safePercent = Math.max(0, Math.min(100, Number(initialStatus.percent) || 0));
  const safeLabel = String(initialStatus.label || "Optimizing database storage…")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Upgrading Plekt</title>
<link rel="icon" href="/icon-192.png" type="image/png" media="(prefers-color-scheme: light)">
<link rel="icon" href="/icon-192-dark.png" type="image/png" media="(prefers-color-scheme: dark)">
<script src="/theme-boot.js"></script>
<script src="/upgrade-status.js" defer></script>
<style>
  :root {
    --bg: #080b0f;
    --surface: #1f242c;
    --border: rgba(255, 255, 255, 0.08);
    --text: #f8fafc;
    --muted: #94a3b8;
    --accent: #10b981;
    --track: rgba(255, 255, 255, 0.09);
    color-scheme: dark;
  }
  html.light-mode {
    --bg: #fbfbfb;
    --surface: #f1f5f9;
    --border: rgba(15, 23, 42, 0.1);
    --text: #0f172a;
    --muted: #475569;
    --accent: #2563eb;
    --track: rgba(15, 23, 42, 0.1);
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Outfit, Arial, sans-serif;
  }
  main {
    width: 100%;
    max-width: 28rem;
    padding: 2.25rem 2rem;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: grid;
    gap: 16px;
    text-align: center;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  }
  .logo {
    height: 36px;
    width: auto;
    margin: 0 auto 4px;
    display: block;
  }
  h1 { margin: 0; font-size: 1.3rem; font-weight: 600; }
  .subtitle { margin: 0; color: var(--muted); font-size: 0.92rem; line-height: 1.5; }
  .progress-wrap { display: grid; gap: 8px; margin-top: 4px; }
  .track {
    width: 100%;
    height: 8px;
    border-radius: 999px;
    background: var(--track);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    width: ${safePercent}%;
    border-radius: 999px;
    background: var(--accent);
    transition: width 0.35s ease;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    font-size: 0.82rem;
    color: var(--muted);
    gap: 12px;
  }
  .note {
    margin: 4px 0 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
</style>
</head>
<body>
<main role="status" aria-live="polite">
  <img id="upgradeLogo" class="logo" src="/plekt_header_logo_dark.png" alt="Plekt">
  <h1>Upgrading Plekt</h1>
  <p class="subtitle">Compressing your local database storage for this update. Your watch history and settings are untouched.</p>
  <div class="progress-wrap">
    <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${safePercent}">
      <div id="upgradeFill" class="fill"></div>
    </div>
    <div class="meta">
      <span id="upgradeLabel">${safeLabel}</span>
      <span id="upgradePercent">${safePercent}%</span>
    </div>
  </div>
  <p id="upgradeStats" class="note">This page will open automatically once complete.</p>
</main>
</body>
</html>`;
}
