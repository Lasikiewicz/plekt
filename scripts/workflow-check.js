#!/usr/bin/env node
// Read-only workflow gates. No fetch, push, lock acquisition or working-tree writes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockDecision } from './release-lock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function assertCleanup(runs) {
  if (!Array.isArray(runs)) throw Error('Cannot establish GHCR Cleanup status.');
  if (runs.some(r => r.status !== 'completed')) throw Error('GHCR Cleanup is queued/running. Wait; do not publish concurrently.');
}
export function assertScope(baseline, pending) {
  if (!baseline || !Array.isArray(baseline.pending)) throw Error('Narrow push needs a recorded baseline with pending commit hashes.');
  if (baseline.pending.length) throw Error('Baseline contains older unpushed commits. Ask for all-scope or a narrower scope; do not consolidate.');
  if (!pending.includes(baseline.head) && pending.length) throw Error('Current history no longer contains the chat baseline. Reconcile scope before committing.');
}
export function assertSafePaths(paths) {
  for (const p of paths) if (/^(data|backups|node_modules)(\/|$)|(^|\/)\.env($|\.(local|production|development|test)(\.local)?$)|(^|\/)(id_rsa|id_ed25519|private\.key)$/i.test(p)) {
    throw Error(`Forbidden staged path: ${p}. Unstage it; never force-add local data or credentials.`);
  }
}
const KNOWN_SECURITY_ALERTS = {
  'code-scanning:64': {
    matches: a => a.rule?.id === 'js/xss-through-dom' &&
      a.rule?.security_severity_level === 'high' &&
      a.most_recent_instance?.location?.path === 'website/scripts/recapture.mjs' &&
      a.most_recent_instance?.ref === 'refs/heads/main' &&
      a.most_recent_instance?.commit_sha === '003c12e0467ec0c44f294cb8177976e50a1b5798',
    note: 'known: the rail image-source allow-list is in develop; this is the superseded main instance, pending the next main scan',
  },
  'dependabot:17': {
    matches: a => a.dependency?.package?.ecosystem === 'npm' &&
      a.dependency?.package?.name === 'sprintf-js' &&
      a.dependency?.manifest_path === 'reddit-app/package-lock.json' &&
      a.security_advisory?.ghsa_id === 'GHSA-hp3w-g68c-fv3c' &&
      a.security_advisory?.severity === 'medium' &&
      a.security_vulnerability?.vulnerable_version_range === '<= 1.1.3' &&
      a.security_vulnerability?.first_patched_version === null,
    note: 'known: the vulnerable sprintf-js package is in the retired Devvit source removed from develop; GitHub still reports the default-branch alert until that removal reaches main',
  },
};
export function knownSecurityAlertNote(kind, alert) {
  const entry = KNOWN_SECURITY_ALERTS[`${kind}:${alert.number}`];
  return entry?.matches(alert) ? entry.note : null;
}
export function assertBuild(version, changelog, expected, channel = 'release') {
  const normalize = s => String(s || '').replace(/^v/, '');
  if (normalize(version.version) !== normalize(expected) || version.channel !== channel) throw Error('Served /version.json version/channel differs from the approved candidate.');
  if (changelog.channel !== channel) throw Error(`Served changelog channel must be ${channel}.`);
  const installed = channel === 'alpha' ? changelog.alphaBuild?.version : channel === 'develop' ? changelog.developBuild?.version : changelog.current;
  if (normalize(installed) !== normalize(expected)) throw Error('Served /api/changelog build differs from the approved candidate.');
}
export function assertCandidateLauncher(commandLine, launcher) {
  const normalize = s => s.replaceAll('\\', '/').toLowerCase();
  const args = (commandLine.match(/"[^"]*"|[^\s]+/g) || []).map(s => s.replace(/^"|"$/g, ''));
  const script = args.slice(1).find(a => !a.startsWith('-'));
  if (!script || normalize(script) !== normalize(launcher)) throw Error('Listener does not run the recorded absolute candidate launcher. Inspect ownership before proceeding.');
}
export function assertRestampOnly(before, after, file = '') {
  // Ignore only explicit version stamps; everything else requires human reconciliation.
  const normalize = s => {
    if (/^(package(-lock)?|changelog(\.alpha|\.develop)?)\.json$/.test(file)) {
      const data = JSON.parse(s);
      for (const key of ['version', 'baseVersion', 'version5Digit']) if (/^\d+(\.\d+){2,4}$/.test(data[key] || '')) data[key] = '<stamp>';
      if (file === 'package-lock.json' && data.packages?.['']?.version) data.packages[''].version = '<stamp>';
      return JSON.stringify(data);
    }
    return s.replace(/\?v=[\w.-]+/g, '?v=<stamp>')
      .replace(/(sourceVersion["']?\s*:\s*["']?)[\w.-]+/g, '$1<stamp>')
      .replace(/(id="aboutCurrentVersion">)v\d+(\.\d+){2,4}/g, '$1v<stamp>');
  };
  if (normalize(before) !== normalize(after)) throw Error('Develop has content absent/different in the release. Stop and review; do not move develop.');
}
function command(bin, args, cwd = root) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(`${bin} ${args.join(' ')} failed: ${r.error?.message || r.stderr || r.stdout}`);
  return r.stdout.trim();
}
const git = (...args) => command('git', args);
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function railImageSourceFixPresent() {
  try {
    const helper = fs.readFileSync(path.join(root, 'website/scripts/lib/rail-src.mjs'), 'utf8');
    const capture = fs.readFileSync(path.join(root, 'website/scripts/recapture.mjs'), 'utf8');
    return helper.includes('export function isAllowedRailSrc') && capture.includes('isAllowedRailSrc') && capture.includes('allowed.includes(src)');
  } catch { return false; }
}
function redditAppSourceRetired() {
  const appSource = [
    'reddit-app/devvit.json',
    'reddit-app/package.json',
    'reddit-app/package-lock.json',
    'reddit-app/scripts/bundle-release.mjs',
    'reddit-app/src/core/release.ts',
    'reddit-app/src/generated/release.json',
    'reddit-app/src/index.ts',
    'reddit-app/src/routes/scheduler.ts',
    'reddit-app/tsconfig.json',
    'reddit-app/vite.config.ts',
  ];
  return appSource.every(file => !fs.existsSync(path.join(root, file)));
}
function node(script, args = [], cwd = root) { console.log(command(process.execPath, [path.join(root, script), ...args], cwd)); }
function cleanup() { assertCleanup(JSON.parse(command('gh', ['run', 'list', '--workflow', 'ghcr-cleanup.yml', '--limit', '1', '--json', 'status,conclusion,url']))); }
function availableLock() {
  const p = path.join(root, '.git', 'plembfin-release.lock');
  if (fs.existsSync(p)) {
    const decision = lockDecision({ existing: json(p) });
    if (decision.action === 'refuse') throw Error(`Release lock held for ${decision.holder.label}; do not work around it.`);
  }
}
function pinned(config) {
  for (const [ref, hash] of [['origin/alpha', config.alpha], ['origin/main', config.main]]) {
    if (!/^[a-f0-9]{40}$/.test(hash || '') || git('rev-parse', ref) !== hash) throw Error(`${ref} differs from the recorded pin. Stop and reconcile; do not substitute a source.`);
  }
  const remote = git('ls-remote', 'origin', 'refs/heads/alpha', 'refs/heads/main');
  for (const [branch, hash] of [['alpha', config.alpha], ['main', config.main]]) {
    if (!remote.split('\n').some(line => line === `${hash}\trefs/heads/${branch}`)) throw Error(`Remote ${branch} changed during the run. Stop and reconcile before promotion/push.`);
  }
}
async function getJson(url) {
  const headers = process.env.PLEKT_CHECK_COOKIE ? { Cookie: process.env.PLEKT_CHECK_COOKIE } : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw Error(`${new URL(url).pathname}: HTTP ${response.status}; authenticate using PLEKT_CHECK_COOKIE if needed (never print credentials).`);
  return response.json();
}
async function main() {
  const [phase, workflow, ...args] = process.argv.slice(2);
  const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (phase === 'precheck') {
    if (!['push', 'alpha', 'main'].includes(workflow)) throw Error('Choose push, alpha or main.');
    cleanup(); availableLock();
    if (git('branch', '--show-current') !== 'develop') throw Error('Start this workflow on develop; preserve existing changes before switching.');
    console.log(`Baseline HEAD: ${git('rev-parse', 'HEAD')}\nDevelop tip: ${git('rev-parse', 'develop')}\n${git('status', '--short')}`);
    if (workflow === 'push') {
      // Print every alert. Only exact, documented fingerprints are notes; everything else
      // remains blocking when high/critical or in a changed file.
      let blocked = false;
      for (const kind of ['code-scanning', 'dependabot']) {
        const alerts = JSON.parse(command('gh', ['api', `repos/Lasikiewicz/plekt/${kind}/alerts?state=open&per_page=100`]));
        const changed = [...git('diff', '--name-only', 'HEAD').split('\n'), ...git('diff', '--name-only', 'origin/develop...HEAD').split('\n')];
        for (const a of alerts) {
          const severity = a.rule?.security_severity_level || a.rule?.severity || a.security_advisory?.severity;
          const file = a.most_recent_instance?.location?.path || a.dependency?.manifest_path;
          console.log(`Open ${kind} alert ${a.number}: ${severity} ${file}`);
          const fingerprintNote = knownSecurityAlertNote(kind, a);
          const remedyPresent = kind === 'code-scanning' ? railImageSourceFixPresent() :
            kind === 'dependabot' && a.number === 17 && redditAppSourceRetired();
          const note = fingerprintNote && remedyPresent ? fingerprintNote : null;
          if (note) {
            console.log(`Security alert note #${a.number}: ${note}`);
            continue;
          }
          blocked ||= ['high', 'critical'].includes(a.rule?.security_severity_level || a.security_advisory?.severity) || changed.includes(file);
        }
      }
      if (blocked) throw Error('Unreviewed security alert requires an explicit user decision before push. Never dismiss alerts to clear this check.');
    }
    if (workflow === 'alpha') {
      const stable = JSON.parse(git('show', 'origin/main:changelog.json')).version;
      if (json(path.join(root, 'changelog.json')).version !== stable) throw Error('Develop stable base differs from origin/main. Stop and ask; do not promote a stale base.');
    }
    console.log('Read-only precheck complete. No lock acquired; fetch/pinning and human gates remain required.');
  } else if (phase === 'stable-base') {
    const stable = JSON.parse(git('show', 'origin/main:changelog.json')).version;
    if (json(path.join(root, 'changelog.json')).version !== stable) throw Error('Develop stable base differs from origin/main. Stop and ask before promotion.');
    console.log('Stable base matches origin/main.');
  } else if (phase === 'scope') {
    const baseline = json(path.resolve(workflow));
    assertScope(baseline, git('rev-list', 'HEAD').split('\n'));
    console.log('Narrow baseline ancestry/pending check passes; review mixed files against recorded status manually.');
  } else if (phase === 'candidate') {
    const config = json(path.resolve(workflow));
    pinned(config);
    if (command('git', ['rev-parse', 'HEAD'], config.worktree) !== config.alpha) throw Error('Candidate HEAD differs from pinned alpha.');
    if (process.platform !== 'win32') throw Error('Port ownership checker currently requires Windows; verify ownership before proceeding.');
    const owners = JSON.parse(command('powershell.exe', ['-NoProfile', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -LocalPort 5056 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)']));
    if (!owners.length || owners.some(p => p !== config.pid)) throw Error('Port 5056 is not owned exclusively by the recorded candidate PID.');
    const proc = JSON.parse(command('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(config.pid)}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`]));
    const launcher = path.join(fs.realpathSync(config.worktree), 'scripts', 'start-local.js');
    if (!/node(\.exe)?$/i.test(proc.ExecutablePath || '')) throw Error('Candidate listener is not Node; inspect ownership.');
    assertCandidateLauncher(String(proc.CommandLine || ''), launcher);
    const modified = command('git', ['diff', '--name-only', 'HEAD'], config.worktree).split('\n').filter(Boolean);
    const untracked = command('git', ['ls-files', '--others', '--exclude-standard'], config.worktree).split('\n').filter(Boolean);
    for (const file of [...modified, ...untracked]) {
      if (/^server\.(stdout|stderr)\.log$/.test(file)) continue;
      if (/^(changelog(\.alpha|\.develop)?\.json|CHANGELOG\.md)$/.test(file)) continue;
      if (/^(package(-lock)?\.json|public\/|website\/src\/content\/docs\/)/.test(file) && !untracked.includes(file)) {
        assertRestampOnly(command('git', ['show', `HEAD:${file}`], config.worktree), fs.readFileSync(path.join(config.worktree, file), 'utf8').trim(), file);
      } else throw Error(`Unexpected candidate change: ${file}. Do not patch the pinned source.`);
    }
    const base = new URL(config.baseUrl);
    if (!['localhost', '127.0.0.1'].includes(base.hostname) || base.port !== '5056') throw Error('Candidate must use local port 5056.');
    assertBuild(await getJson(new URL('/version.json', base)), await getJson(new URL('/api/changelog', base)), config.version);
    console.log('Pinned candidate, port owner and served release metadata pass. Human app/changelog approval is still required.');
  } else if (phase === 'staged') {
    assertSafePaths(git('diff', '--cached', '--name-only').split('\n'));
    if (git('diff', '--name-only', '--', 'README.md', 'package.json', 'package-lock.json', 'changelog.json', 'changelog.alpha.json', 'changelog.develop.json', 'public')) throw Error('Index differs from checked README/manifests/public. Stage the complete reviewed restamp set before running staged checks.');
    node('scripts/docs-check.js'); node('scripts/asset-versions.js');
  } else if (phase === 'before-push') {
    cleanup(); assertSafePaths(git('diff', '--cached', '--name-only').split('\n'));
    if (workflow === 'push') { node('scripts/check-pending-commits.js'); node('scripts/rebuild-develop-changelog.js', ['--check']); }
    else if (workflow === 'main') pinned(json(path.resolve(option('record') || '')));
    else if (workflow !== 'alpha') throw Error('Choose push, alpha or main.');
    console.log('Mechanical pre-push checks pass. Required approvals and the full pre-push build hook still apply.');
  } else if (phase === 'reconcile') {
    if (git('status', '--porcelain')) throw Error('Reconcile requires a clean working tree.');
    const base = git('merge-base', 'develop', 'HEAD');
    const files = git('diff', '--name-only', `${base}...develop`).split('\n').filter(Boolean);
    console.log(git('log', '--oneline', 'origin/main..develop'));
    for (const file of files) assertRestampOnly(git('show', `develop:${file}`), git('show', `HEAD:${file}`), file);
    console.log('Develop content is carried or source/asset restamping only. Review listed commits before moving the branch.');
  } else throw Error('Usage: workflow-check.js precheck push|alpha|main [--dry-run] | candidate <record.json> | staged | before-push push|alpha|main [--record=...] | reconcile');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`WORKFLOW CHECK FAILED: ${e.message}`); process.exitCode = 1; });
