import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// GitHub treats security-severity scores of 7.0 and above as High or Critical.
// Both levels block this gate.
export const BLOCKING_SECURITY_SEVERITY = 7;

async function sarifFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sarifFiles(path));
    } else if (/\.sarif(?:\.json)?$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function numericSeverity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ruleForResult(run, result) {
  const rules = run?.tool?.driver?.rules || [];
  if (result?.ruleId) return rules.find((rule) => rule.id === result.ruleId) || null;
  if (Number.isInteger(result?.ruleIndex)) return rules[result.ruleIndex] || null;
  return null;
}

function resultSeverity(run, result) {
  const rule = ruleForResult(run, result);
  const candidates = [
    result?.properties?.["security-severity"],
    result?.properties?.security_severity,
    rule?.properties?.["security-severity"],
    rule?.properties?.security_severity,
  ];
  for (const candidate of candidates) {
    const severity = numericSeverity(candidate);
    if (severity !== null) return severity;
  }
  return null;
}

function resultLocation(result) {
  const location = result?.locations?.[0]?.physicalLocation;
  const uri = location?.artifactLocation?.uri || "unknown file";
  const line = location?.region?.startLine;
  return line ? `${uri}:${line}` : uri;
}

function resultMessage(result) {
  return result?.message?.text || result?.message?.markdown || "CodeQL finding";
}

export function findBlockingFindings(sarif, source = "CodeQL") {
  const findings = [];
  for (const run of sarif?.runs || []) {
    for (const result of run.results || []) {
      // Suppressed results are intentionally triaged and should not reopen
      // the release gate. Unsuppressed results remain blocking until fixed.
      if (result.suppressions?.length) continue;
      const severity = resultSeverity(run, result);
      if (severity === null || severity < BLOCKING_SECURITY_SEVERITY) continue;
      findings.push({
        source,
        ruleId: result.ruleId || "unknown rule",
        severity,
        location: resultLocation(result),
        message: resultMessage(result),
      });
    }
  }
  return findings;
}

async function main(directory) {
  if (!directory) throw new Error("CodeQL SARIF directory is required");
  const files = await sarifFiles(directory);
  if (!files.length) throw new Error(`No CodeQL SARIF files found in ${directory}`);

  const findings = [];
  for (const file of files) {
    const sarif = JSON.parse(await readFile(file, "utf8"));
    findings.push(...findBlockingFindings(sarif, file));
  }

  if (!findings.length) {
    console.log("CodeQL severity gate passed: no unsuppressed High or Critical findings.");
  } else {
    console.error(`CodeQL severity gate failed: ${findings.length} High/Critical finding(s) remain.`);
    for (const finding of findings) {
      console.error(`- [${finding.ruleId}] security-severity=${finding.severity} at ${finding.location}: ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  // GitHub's processed alert inventory is an authoritative backstop. SARIF
  // severity metadata can vary across action versions; the former SARIF-only
  // gate silently passed while GitHub opened High alerts.
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !branch || !token) {
    throw new Error('GitHub alert verification requires GITHUB_REPOSITORY, GITHUB_REF_NAME and GITHUB_TOKEN.');
  }
  const ref = `refs/heads/${branch}`;
  let url = `https://api.github.com/repos/${repository}/code-scanning/alerts?state=open&ref=${encodeURIComponent(ref)}&per_page=100`;
  const alerts = [];
  while (url) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub code-scanning alert check failed: HTTP ${response.status}.`);
    alerts.push(...await response.json());
    const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
    url = next?.[1] || '';
  }

  const blockingAlerts = alerts.filter(alert => {
    const alertRef = alert.most_recent_instance?.ref;
    return alert.state === 'open' && alertRef === ref &&
      ['high', 'critical'].includes(alert.rule?.security_severity_level);
  });
  if (blockingAlerts.length) {
    console.error(`GitHub code-scanning gate failed: ${blockingAlerts.length} open High/Critical alert(s) on ${ref}.`);
    for (const alert of blockingAlerts) {
      console.error(`- #${alert.number} [${alert.rule?.id || 'unknown rule'}] ${alert.most_recent_instance?.location?.path || 'unknown file'}:${alert.most_recent_instance?.location?.start_line || '?'}: ${alert.most_recent_instance?.message?.text || 'CodeQL finding'}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`GitHub code-scanning alert gate passed: no open High/Critical alerts on ${ref}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
