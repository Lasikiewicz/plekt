#!/usr/bin/env node

// Creates or updates the GitHub Release for one committed main or alpha
// changelog entry. Both the image and Windows workflows call this helper, so
// either workflow can finish first without producing duplicate or generic
// release notes.

import { generateReleaseNotes, getReleaseMetadata, loadReleaseManifest } from "./generate-release-notes.js";

const apiBase = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const repository = process.env.GITHUB_REPOSITORY || "Lasikiewicz/plekt";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

if (!token) {
  console.error("GITHUB_TOKEN or GH_TOKEN is required to publish a GitHub Release.");
  process.exit(1);
}

async function githubRequest(endpoint, options = {}) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${payload?.message || text || "request failed"}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function findRelease(tagName) {
  try {
    return await githubRequest(`/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function waitForRelease(tagName) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const release = await findRelease(tagName);
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function publishRelease({ metadata, body, commit }) {
  const payload = {
    name: metadata.title,
    body,
    draft: false,
    prerelease: metadata.channel === "alpha",
  };
  let release = await findRelease(metadata.tagName);
  if (release) {
    release = await githubRequest(`/repos/${repository}/releases/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return release;
  }

  try {
    return await githubRequest(`/repos/${repository}/releases`, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        tag_name: metadata.tagName,
        target_commitish: commit || undefined,
      }),
    });
  } catch (error) {
    // The alpha image and Windows workflows can publish at the same time. If
    // both observe a missing release, one POST wins and the other updates it.
    if (error.status !== 422) throw error;
    release = await waitForRelease(metadata.tagName);
    if (!release) throw error;
    return githubRequest(`/repos/${repository}/releases/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
}

const channel = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (channel !== "main" && channel !== "alpha") {
  console.error("Usage: node scripts/publish-github-release.js <main|alpha>");
  process.exit(1);
}

try {
  const manifest = loadReleaseManifest(channel);
  const metadata = getReleaseMetadata({ channel, manifest });
  const body = generateReleaseNotes({
    channel,
    manifest,
    repository,
    serverUrl,
    commit: process.env.GITHUB_SHA || "",
  });
  const release = await publishRelease({
    metadata,
    body,
    commit: process.env.GITHUB_SHA || "",
  });
  console.log(`Published ${metadata.channel} GitHub Release ${release.tag_name}: ${release.html_url}`);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
