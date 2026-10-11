---
name: start-website
description: "Start the local Astro website preview for editing and testing. Use when the user says \"Start the website\" (case-insensitive). This is local-only and never publishes or deploys."
---

# Start the website

When the user explicitly says **"Start the website"**, start or reuse the local Astro
development server for the static site and load it in the connected Chrome browser.
This workflow is for local editing and testing only.

## Boundaries

- Use the website in `website/`; do not start the Plekt application server unless
  the user separately asks for app-backed testing.
- Reuse an existing healthy website dev server at `http://localhost:4321/` when one is
  already running.
- Keep the dev-server session alive so later edits are reflected by Astro's reload.
- Do not run a production build, deploy, commit, push, or GitHub workflow.
- Use the connected Chrome browser for the local page. Do not open the live site or use
  the remote testing environment for this local workflow.

## Workflow

1. From the repository root, start the website dev server in a persistent terminal
   session when `http://localhost:4321/` is not already healthy:

   ```bash
   npm --prefix website run dev
   ```

   If the server reports a different port, use the exact URL it prints and retain that
   URL for the browser handoff.

2. Make one lightweight request to the exact local URL and require a successful response
   before opening the browser.

3. Open or reuse that exact local URL in the connected Chrome browser. Leave the browser
   on the local website so the user can edit files and refresh/test the result.

4. Report the local URL and that the website is running locally only. Do not describe
   the site as live or imply that any deployment occurred.

If the user later says **"Push website live"**, switch to the separate website-only
publishing workflow; starting the local site never implies publication.
