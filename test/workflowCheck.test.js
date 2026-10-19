import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCleanup, assertScope, assertSafePaths, assertBuild, assertRestampOnly, assertCandidateLauncher, knownSecurityAlertNote } from '../scripts/workflow-check.js';

test('cleanup refuses running and queued jobs, accepts no run or completed', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) assert.throws(() => assertCleanup([{ status }]));
  assertCleanup([]); assertCleanup([{ status: 'completed' }]);
});
test('narrow scope cannot absorb pending baseline commits or rewritten history', () => {
  assert.throws(() => assertScope({ head: 'old', pending: ['earlier'] }, ['old']));
  assert.throws(() => assertScope({ head: 'old', pending: [] }, ['new']));
  assertScope({ head: 'old', pending: [] }, ['new', 'old']);
});
test('sensitive paths cannot enter a release staging set', () => {
  for (const p of ['data/config.json', 'backups/archive.zip', '.env', 'website/.env.local', 'private.key']) assert.throws(() => assertSafePaths([p]));
  assertSafePaths(['docs/backups.md', 'public/app.js', '.env.example', 'public/certificate.pem']);
});
test('candidate rejects stale version or wrong channel/current', () => {
  assertBuild({ version: '2.1.0', channel: 'release' }, { current: '2.1.0', channel: 'release' }, '2.1.0');
  assert.throws(() => assertBuild({ version: '2.0.0' }, { current: '2.1.0', channel: 'release' }, '2.1.0'));
  assert.throws(() => assertBuild({ version: '2.1.0', channel: 'release' }, { current: '2.1.0', channel: 'alpha' }, '2.1.0'));
  assert.throws(() => assertBuild({ version: '2.1.0', channel: 'release' }, { current: '2.0.0', channel: 'release' }, '2.1.0'));
});
test('candidate listener must execute its recorded launcher, not merely mention it', () => {
  const launcher = 'C:/candidate/scripts/start-local.js';
  assertCandidateLauncher('"C:/Program Files/nodejs/node.exe" "C:/candidate/scripts/start-local.js"', launcher);
  assert.throws(() => assertCandidateLauncher('node scripts/start-local.js', launcher));
  assert.throws(() => assertCandidateLauncher('node C:/wrong/server.js C:/candidate/scripts/start-local.js', launcher));
  assert.throws(() => assertCandidateLauncher('node C:/candidate/scripts/start-local.js.other', launcher));
});
test('only the exact documented security alert fingerprints become notes', () => {
  const codeAlert = {
    number: 64,
    rule: { id: 'js/xss-through-dom', security_severity_level: 'high' },
    most_recent_instance: {
      location: { path: 'website/scripts/recapture.mjs' },
      ref: 'refs/heads/main',
      commit_sha: '003c12e0467ec0c44f294cb8177976e50a1b5798',
    },
  };
  const sprintfAlert = {
    number: 17,
    dependency: { package: { ecosystem: 'npm', name: 'sprintf-js' }, manifest_path: 'reddit-app/package-lock.json' },
    security_advisory: { ghsa_id: 'GHSA-hp3w-g68c-fv3c', severity: 'medium' },
    security_vulnerability: { vulnerable_version_range: '<= 1.1.3', first_patched_version: null },
  };

  assert.match(knownSecurityAlertNote('code-scanning', codeAlert), /allow-list/);
  assert.match(knownSecurityAlertNote('dependabot', sprintfAlert), /removed from develop/);
  assert.equal(knownSecurityAlertNote('code-scanning', { ...codeAlert, number: 65 }), null);
  assert.equal(knownSecurityAlertNote('code-scanning', { ...codeAlert, most_recent_instance: { ...codeAlert.most_recent_instance, commit_sha: 'new-main-commit' } }), null);
  assert.equal(knownSecurityAlertNote('dependabot', { ...sprintfAlert, security_vulnerability: { vulnerable_version_range: '<= 1.1.4', first_patched_version: null } }), null);
});
test('reconcile accepts source/asset restamping but refuses missing product changes', () => {
  assertRestampOnly('sourceVersion: 2.0.0\na.js?v=old', 'sourceVersion: 2.1.0\na.js?v=new');
  assert.throws(() => assertRestampOnly('new behavior', 'old behavior'));
  assert.throws(() => assertRestampOnly('const version = 1', 'const version = 2'));
  assertRestampOnly('{"version":"2.0.0","name":"plekt"}', '{"version":"2.1.0","name":"plekt"}', 'package.json');
  assert.throws(() => assertRestampOnly('{"version":"2.0.0","dependencies":{"x":"1.0.0"}}', '{"version":"2.1.0","dependencies":{"x":"2.0.0"}}', 'package.json'));
});
