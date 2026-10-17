import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { captureUrls, assertAsset, assertNewestRelease } from '../scripts/verify-release-website.js';
test('finds src and srcset capture URLs, preserving content queries', () => {
  const urls = captureUrls('<img src="/assets/app-captures/a.png?v=a"><source srcset="/assets/app-captures/b.webp?v=b 400w, /assets/app-captures/c.webp?v=c 800w">', 'https://plekt.net');
  assert.equal(urls.length, 3);
  assert.ok(urls.includes('https://plekt.net/assets/app-captures/c.webp?v=c'));
});
test('finds optimized capture paths and theme data attributes', () => {
  const html = '<picture><source srcset="/assets/optimized/app-captures/dashboard-modern-dark-1396.webp?v=f3 1396w"><img src="/assets/optimized/app-captures/dashboard-modern-dark-1396.webp?v=f3" data-dark-src="/assets/optimized/app-captures/dashboard-modern-dark-1396.webp?v=f3" data-light-src="/assets/optimized/app-captures/dashboard-modern-light-1396.webp?v=dd"><img src="/assets/icons/logo.png"></picture>';
  const urls = captureUrls(html, 'https://plekt.net');
  assert.deepEqual(urls.sort(), ['https://plekt.net/assets/optimized/app-captures/dashboard-modern-dark-1396.webp?v=f3', 'https://plekt.net/assets/optimized/app-captures/dashboard-modern-light-1396.webp?v=dd']);
});
test('hashes an optimized variant against its source capture, not the variant bytes', () => {
  const source = Buffer.from('source capture');
  const variant = Buffer.from('webp variant');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 10);
  assertAsset(`https://plekt.net/assets/optimized/app-captures/a-720.webp?v=${hash}`, variant, variant, source);
  assert.throws(() => assertAsset(`https://plekt.net/assets/optimized/app-captures/a-720.webp?v=${hash}`, variant, variant));
});
test('rejects stale immutable URL and mismatched CDN bytes', () => {
  const local = Buffer.from('current image');
  const hash = crypto.createHash('sha256').update(local).digest('hex').slice(0, 10);
  assertAsset(`https://plekt.net/a?v=${hash}`, local, local);
  assert.throws(() => assertAsset('https://plekt.net/a', local, local));
  assert.throws(() => assertAsset(`https://plekt.net/a?v=${hash}`, Buffer.from('old'), local));
});
test('requires the exact newest rendered release, not a version substring or older entry', () => {
  const entry = version => `<div class="changelog-entry-meta"><strong>v${version}</strong></div>`;
  assertNewestRelease(entry('2.1.0'), '2.1.0');
  for (const version of ['2.1.00', '12.1.0', '2.0.0']) assert.throws(() => assertNewestRelease(entry(version) + entry('2.1.0'), '2.1.0'));
});
