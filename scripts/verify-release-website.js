#!/usr/bin/env node
// Read-only final website gate: run against the clean, published release checkout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function captureUrls(html, base) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|srcset)=["']([^"']+)["']/gi)) {
    for (const entry of match[1].split(',')) {
      const url = new URL(entry.trim().split(/\s+/)[0].replaceAll('&amp;', '&'), base);
      if (url.pathname.includes('/assets/app-captures/')) found.add(url.href);
    }
  }
  return [...found];
}
export function assertAsset(url, remote, local) {
  const hash = crypto.createHash('sha256').update(local).digest('hex').slice(0, 10);
  if (new URL(url).searchParams.get('v') !== hash) throw Error(`Missing/stale content hash: ${new URL(url).pathname}`);
  if (!Buffer.from(remote).equals(local)) throw Error(`Live screenshot bytes differ: ${new URL(url).pathname}`);
}
export function assertNewestRelease(page, version) {
  const first = page.match(/class="changelog-entry-meta"[^>]*>\s*<strong>v([^<]+)<\/strong>/);
  if (first?.[1] !== version) throw Error('Live changelog newest entry differs from this release.');
}
async function read(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
  if (response.status !== 200) throw Error(`${url}: HTTP ${response.status}; expected 200`);
  if (new URL(response.url).origin !== new URL(url).origin || new URL(response.url).pathname.replace(/\/$/, '') !== new URL(url).pathname.replace(/\/$/, '')) throw Error(`${url}: redirected away from the expected page`);
  return response;
}
async function main() {
  const [version, base = 'https://plekt.net/'] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Usage: verify-release-website.js <version> [website URL]');
  const release = JSON.parse(fs.readFileSync(path.join(root, 'changelog.json'), 'utf8'));
  if (release.version !== version || release.entries[0]?.version !== version) throw Error('Local release does not match the requested published version.');
  const page = await (await read(new URL('/changelog/', base))).text();
  assertNewestRelease(page, version);
  const urls = new Set(JSON.stringify(release.entries[0]).match(/https?:[^\s"<>]+/g) || []);
  for (const url of urls) if (new URL(url).origin === new URL(base).origin && new URL(url).pathname.startsWith('/docs/')) await read(url);
  const homepage = await (await read(new URL('/', base))).text();
  const captures = captureUrls(homepage, base);
  if (!captures.length) throw Error('No homepage screenshot URLs found; inspect markup before claiming verification.');
  const publicRoot = path.join(root, 'website', 'public');
  for (const url of captures) {
    const local = path.resolve(publicRoot, '.' + decodeURIComponent(new URL(url).pathname));
    if (!local.startsWith(publicRoot + path.sep)) throw Error('Screenshot path escapes website/public.');
    assertAsset(url, await (await read(url)).arrayBuffer(), fs.readFileSync(local));
  }
  console.log(`Live website v${version}, release guide links and ${captures.length} hashed screenshot URLs pass.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`LIVE WEBSITE CHECK FAILED: ${e.message}`); process.exitCode = 1; });
