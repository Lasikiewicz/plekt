import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCleanup, assertScope, assertSafePaths, assertBuild, assertRestampOnly, assertCandidateLauncher, knownSecurityAlertNote, versionAtLeast, vitePatched, bugBacklogOverrideApplies, blockingBugBacklogItems } from '../scripts/workflow-check.js';

test('only explicitly documented outstanding live or user tests bypass the bug gate', () => {
  const content = '- [ ] Fix needed\n- [ ] Await test <!-- push-awaiting-test: reporter tests released fix -->\n- [ ] Empty <!-- push-awaiting-test: -->\n- [x] Done';
  assert.deepEqual(blockingBugBacklogItems(content), ['- [ ] Fix needed', '- [ ] Empty <!-- push-awaiting-test: -->']);
});

test('bug backlog exception applies only to an explicitly supplied full HEAD', () => {
  const head = 'a'.repeat(40);
  assert.equal(bugBacklogOverrideApplies(head, head), true);
  for (const override of [undefined, '', '1', 'true', 'a'.repeat(7), 'b'.repeat(40)]) {
    assert.equal(bugBacklogOverrideApplies(override, head), false);
  }
});

test('reviewed security fixes recognize only their older main scan', () => {
  for (const [number, rule, file] of [
    [70, 'js/incomplete-url-substring-sanitization', 'test/sharedAssets.test.js'],
    [69, 'js/incomplete-sanitization', 'scripts/generate-code-index.js'],
    [68, 'js/incomplete-multi-character-sanitization', 'server/src/utils/anidbProtocol.js'],
    [67, 'js/bad-tag-filter', 'test/onboardingTrackersUi.test.js'],
    [66, 'js/bad-tag-filter', 'test/initialSyncUi.test.js'],
  ]) {
    const alert = { number, rule: { id: rule, security_severity_level: 'high' }, most_recent_instance: {
      location: { path: file }, ref: 'refs/heads/main', commit_sha: '453fc063c5ab504be2e51bb0630b4cd9bb0029bb',
    } };
    assert.match(knownSecurityAlertNote('code-scanning', alert), /reviewed fix is present/);
    for (const change of [{ ref: 'refs/heads/develop' }, { commit_sha: 'new-main-commit' }, { location: { path: 'another.js' } }]) {
      assert.equal(knownSecurityAlertNote('code-scanning', { ...alert, most_recent_instance: { ...alert.most_recent_instance, ...change } }), null);
    }
  }
  const latest68 = { number: 68, rule: { id: 'js/incomplete-multi-character-sanitization', security_severity_level: 'high' }, most_recent_instance: {
    location: { path: 'server/src/utils/anidbProtocol.js' }, ref: 'refs/heads/main', commit_sha: '02153c6f9fe558b5343da3a9ba2dfe002f21aa8d',
  } };
  assert.match(knownSecurityAlertNote('code-scanning', latest68), /reviewed fix is present/);
  assert.equal(knownSecurityAlertNote('code-scanning', { ...latest68, number: 69 }), null);
});

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

  const stackAlert = {
    number: 49,
    rule: { id: 'js/stack-trace-exposure', security_severity_level: 'medium' },
    most_recent_instance: {
      location: { path: 'server/src/utils/http.js' },
      ref: 'refs/heads/main',
      commit_sha: 'ef11918693f1a9ce4bfd0c0225ce1652374c871e',
    },
  };
  const viteAlert = {
    number: 19,
    dependency: { package: { ecosystem: 'npm', name: 'vite' }, manifest_path: 'website/package-lock.json' },
    security_advisory: { ghsa_id: 'GHSA-587h-7wmj-h5pm', severity: 'high' },
    security_vulnerability: { vulnerable_version_range: '>= 8.3.0, <= 8.3.2', first_patched_version: { identifier: '8.3.3' } },
  };
  assert.match(knownSecurityAlertNote('code-scanning', stackAlert), /restore-conflict/);
  assert.equal(knownSecurityAlertNote('code-scanning', { ...stackAlert, most_recent_instance: { ...stackAlert.most_recent_instance, commit_sha: 'new-main-commit' } }), null);
  assert.match(knownSecurityAlertNote('dependabot', viteAlert), /patched vite/);
  assert.equal(knownSecurityAlertNote('dependabot', { ...viteAlert, security_advisory: { ghsa_id: 'GHSA-698v-4r3x-3vcv', severity: 'high' } }), null);
  assert.equal(knownSecurityAlertNote('dependabot', { ...viteAlert, security_vulnerability: { vulnerable_version_range: '>= 8.3.0, <= 8.3.4', first_patched_version: { identifier: '8.3.5' } } }), null);

  const pendingFixAlerts = [
    [22, 'vite', 'GHSA-698v-4r3x-3vcv', 'medium', '>= 8.2.0, <= 8.2.3', '8.2.4'],
    [24, 'hono', 'GHSA-5r4p-p66f-jhc7', 'medium', '>= 4.12.4, < 4.13.11', '4.13.11'],
    [26, 'vite', 'GHSA-587h-7wmj-h5pm', 'high', '>= 8.2.0, <= 8.2.3', '8.2.4'],
    [28, 'vite', 'GHSA-r825-w8mm-5pxw', 'medium', '>= 8.2.0, <= 8.2.3', '8.2.4'],
    [30, 'vite', 'GHSA-vfpm-58rq-9qcg', 'medium', '>= 8.2.0, <= 8.2.3', '8.2.4'],
    [31, 'vite', 'GHSA-rq7h-c2jc-7f22', 'medium', '>= 8.2.0, <= 8.2.3', '8.2.4'],
    [32, 'vite', 'GHSA-9jrq-w75r-8gcw', 'low', '>= 8.2.0, <= 8.2.3', '8.2.4'],
  ];
  for (const [number, name, ghsa, severity, range, fixed] of pendingFixAlerts) {
    const alert = {
      number,
      dependency: { package: { ecosystem: 'npm', name }, manifest_path: 'reddit-app/package-lock.json' },
      security_advisory: { ghsa_id: ghsa, severity },
      security_vulnerability: { vulnerable_version_range: range, first_patched_version: { identifier: fixed } },
    };
    assert.match(knownSecurityAlertNote('dependabot', alert), /retired Devvit lockfile/);
    assert.equal(knownSecurityAlertNote('dependabot', { ...alert, security_advisory: { ...alert.security_advisory, ghsa_id: 'GHSA-wrong' } }), null);
  }
  const ipAddressAlert = {
    number: 29,
    dependency: { package: { ecosystem: 'npm', name: 'ip-address' }, manifest_path: 'package-lock.json' },
    security_advisory: { ghsa_id: 'GHSA-rxp7-6hxx-x8q5', severity: 'medium' },
    security_vulnerability: { vulnerable_version_range: '<= 10.7.3', first_patched_version: { identifier: '10.7.4' } },
  };
  const astroAlert = {
    number: 33,
    dependency: { package: { ecosystem: 'npm', name: 'astro' }, manifest_path: 'website/package-lock.json' },
    security_advisory: { ghsa_id: 'GHSA-mpr7-6m5w-76rw', severity: 'low' },
    security_vulnerability: { vulnerable_version_range: '>= 7.1.0, <= 7.3.2', first_patched_version: { identifier: '7.3.3' } },
  };
  assert.match(knownSecurityAlertNote('dependabot', ipAddressAlert), /patched ip-address/);
  assert.match(knownSecurityAlertNote('dependabot', astroAlert), /patched Astro/);
  assert.equal(knownSecurityAlertNote('dependabot', { ...astroAlert, security_vulnerability: { ...astroAlert.security_vulnerability, vulnerable_version_range: '<= 7.3.2' } }), null);
});
test('the vite remedy check accepts only patched versions', () => {
  assert.equal(vitePatched('8.3.2'), false);
  assert.equal(vitePatched('8.3.3'), true);
  assert.equal(vitePatched('8.4.0'), true);
  assert.equal(vitePatched('9.0.0'), true);
  assert.equal(vitePatched('8.2.9'), false);
  assert.equal(vitePatched(''), false);
  assert.equal(versionAtLeast('10.7.3', '10.7.4'), false);
  assert.equal(versionAtLeast('10.7.5', '10.7.4'), true);
  assert.equal(versionAtLeast('7.4.1', '7.3.3'), true);
  assert.equal(versionAtLeast('7.x', '7.3.3'), false);
});
test('reconcile accepts source/asset restamping but refuses missing product changes', () => {
  assertRestampOnly('sourceVersion: 2.0.0\na.js?v=old', 'sourceVersion: 2.1.0\na.js?v=new');
  assert.throws(() => assertRestampOnly('new behavior', 'old behavior'));
  assert.throws(() => assertRestampOnly('const version = 1', 'const version = 2'));
  assertRestampOnly('{"version":"2.0.0","name":"plekt"}', '{"version":"2.1.0","name":"plekt"}', 'package.json');
  assert.throws(() => assertRestampOnly('{"version":"2.0.0","dependencies":{"x":"1.0.0"}}', '{"version":"2.1.0","dependencies":{"x":"2.0.0"}}', 'package.json'));
});
