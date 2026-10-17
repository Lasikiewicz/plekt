// Rail artwork reaches img.src from a data attribute, so only an absolute http(s) URL or a
// path on the captured site may pass. Resolving against the page's base catches the forms
// that look relative but leave the site: "//host", and "/\host" or "/<tab>/host", which
// browsers read as another host once backslashes and whitespace are stripped.
// Exported pure so the capture spec tests it directly.
export function isAllowedRailSrc(src, base) {
  if (typeof src !== "string" || !src) return false;
  try {
    const url = new URL(src, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (/^https?:\/\//i.test(src)) return true;
    return src.startsWith("/") && url.origin === new URL(base).origin;
  } catch {
    return false;
  }
}
