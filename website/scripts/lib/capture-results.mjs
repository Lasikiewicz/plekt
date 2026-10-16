// Turns recapture.mjs output lines into the phase B results table and contact sheet.
// Tool result lines are `<status>\t<file>\t<note>`; the note carries the output size, a
// ` (catalogue WxH)` difference, and ` WARN ...` text.

export function parseToolOutput(text) {
  const rows = [];
  let build = null;
  const errors = [];
  for (const line of text.split(/\r?\n/)) {
    const buildHit = line.match(/^Build at (\S+): (\{.*\})$/);
    if (buildHit) {
      build = { baseUrl: buildHit[1], served: JSON.parse(buildHit[2]) };
      continue;
    }
    const row = line.match(/^(ok|FAIL|skip)\t([^\t]+\.png)\t(.*)$/);
    if (row) rows.push(parseRow(row[1], row[2], row[3]));
    else if (/^(Sign-in failed|Build mismatch|Unknown image id|Nothing selected)/.test(line)) errors.push(line);
  }
  return { build, rows, errors };
}

export function parseRow(status, file, note) {
  const row = { status, file, size: "", catalogue: "", warn: "", note: "" };
  let rest = note;
  if (status === "ok") {
    const warnAt = rest.indexOf(" WARN ");
    if (warnAt >= 0) {
      row.warn = rest.slice(warnAt + 6).trim();
      rest = rest.slice(0, warnAt);
    }
    const catalogue = rest.match(/ \(catalogue (\d+x\d+)\)/);
    if (catalogue) {
      row.catalogue = catalogue[1];
      rest = rest.replace(catalogue[0], "");
    }
    const size = rest.match(/(\d+x\d+)\s*$/);
    if (size) {
      row.size = size[1];
      rest = rest.slice(0, size.index);
    }
  }
  row.note = rest.trim();
  return row;
}

// A clean row was captured at the catalogue size with nothing to say about it.
export function isClean(row) {
  return row.status === "ok" && !row.catalogue && !row.warn && !row.note;
}

export function phaseCReason(row) {
  if (row.status !== "ok") return `${row.status}: ${row.note}`;
  const parts = [];
  if (row.catalogue) parts.push(`size ${row.size}, catalogue says ${row.catalogue}`);
  if (row.warn) parts.push(`WARN ${row.warn}`);
  if (row.note) parts.push(row.note);
  return parts.join("; ");
}

export function summarize(rows) {
  return {
    captured: rows.filter((r) => r.status === "ok").length,
    failed: rows.filter((r) => r.status !== "ok").length,
    warnings: rows.filter((r) => r.status === "ok" && !isClean(r)).length,
  };
}

const cell = (value) => String(value || "").replace(/\|/g, "\\|");

export function resultsMarkdown({ build, rows, errors, expect = {}, exitCode, liveNote = "" }) {
  const { captured, failed, warnings } = summarize(rows);
  const lines = ["# Capture results", ""];
  if (build) lines.push(`- Build at ${build.baseUrl}: \`${JSON.stringify(build.served)}\``);
  else lines.push("- Build: not read");
  lines.push(`- Expected: ${expect.version || "any version"} / ${expect.channel || "any channel"}`);
  lines.push(`- Tool exit code: ${exitCode}`);
  lines.push(`- ${captured} captured, ${failed} failed, ${warnings} warnings`);
  if (liveNote) lines.push(`- ${liveNote}`);
  for (const error of errors) lines.push(`- Error: ${error}`);
  lines.push("", "| Status | File | Size | Catalogue | WARN / note |", "| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(`| ${r.status} | ${cell(r.file)} | ${cell(r.size)} | ${r.catalogue ? `differs: ${r.catalogue}` : r.status === "ok" ? "same" : ""} | ${cell([r.warn && `WARN ${r.warn}`, r.note].filter(Boolean).join("; "))} |`);
  }
  lines.push("", "## For phase C", "");
  const flagged = rows.filter((r) => !isClean(r));
  if (!rows.length) lines.push("- No images were captured.");
  else if (!flagged.length) lines.push("- Nothing flagged; every row is clean.");
  else for (const r of flagged) lines.push(`- \`${r.file}\`: ${phaseCReason(r)}`);
  return lines.join("\n") + "\n";
}

// The id is the file name less its variant; the longest variant matches first so
// `modern-dark` wins over `dark`.
export function splitName(file, variants) {
  const base = file.replace(/\.png$/, "");
  const variant = [...variants].sort((a, b) => b.length - a.length).find((v) => base.endsWith(`-${v}`));
  return variant ? { id: base.slice(0, -variant.length - 1), variant } : { id: base, variant: "" };
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// `imageDir` is the folder of the images relative to the contact sheet.
export function contactSheetHtml({ rows, variants, imageDir = "auto", title = "Capture contact sheet" }) {
  const groups = new Map();
  for (const r of rows) {
    const { id, variant } = splitName(r.file, variants);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ ...r, variant });
  }
  const card = (r) => {
    const href = `${imageDir}/${encodeURIComponent(r.file)}`;
    const flag = isClean(r) ? "" : `<p class="flag">${escapeHtml(phaseCReason(r))}</p>`;
    const image = r.status === "ok" ? `<a href="${href}"><img src="${href}" alt="${escapeHtml(r.file)}" loading="lazy"></a>` : `<div class="missing">no image</div>`;
    return `<figure class="${isClean(r) ? "clean" : "flagged"}">${image}<figcaption>${escapeHtml(r.variant || r.file)} ${escapeHtml(r.size)}</figcaption>${flag}</figure>`;
  };
  const sections = [...groups].map(([id, items]) => `<section><h2>${escapeHtml(id)}</h2><div class="grid">${items.map(card).join("")}</div></section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;background:#f4f4f5;color:#18181b}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
figure{margin:0;padding:8px;background:#fff;border:2px solid #e4e4e7;border-radius:6px}
figure.flagged{border-color:#dc2626;background:#fef2f2}
img{display:block;width:100%;height:auto;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
.missing{padding:48px 0;text-align:center;color:#71717a}
.flag{color:#b91c1c;margin:4px 0 0}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
${sections || "<p>No images were captured.</p>"}
</body></html>
`;
}
