---
name: push-website-live
description: "Publish the current local Astro website directly to the separate Cloudflare Pages project. Use when the user says \"Push website live\" (case-insensitive). This never pushes GitHub or rebuilds the Plekt application."
---

# Push website live

When the user explicitly says **"Push website live"**, or asks to repair/publish the
website or its Traks analytics outside the release workflow, publish the latest website
working tree directly to the existing `plembfin-website` Cloudflare Pages project.
The current checkout is the source of truth, including uncommitted website fixes.

## Boundaries

- Work from the repository root, with the site in `website/`.
- Do not use the GitHub editor/API, checkout, pull, reset, stash, commit, or push Git branches.
- Do not run the root Plekt build, Docker build, or any GitHub workflow.
- Do not deploy the `plembfin` application Pages project; the target is only
  `plembfin-website`.
- Do not deploy when a website check or build fails.
- If the request is ambiguous, keep the same boundary: website/Traks work is local
  website-only unless the user explicitly invokes **"Force to main"**.

## Workflow

1. From `website/`, check the application matches the released main build:

   ```bash
   npm run check:release-parity
   ```

   The live website must never show anything the main build does not have. If it fails,
   stop and show the user the listed application files. Continue only if the user confirms
   in chat that no website text or image shows those changes; otherwise new application
   work is documented through **Force to main**.

2. Check the homepage comparison table date. In `website/src/pages/index.astro`, read the
   "accurate as of <date>" text in the `simple-home-comparison-note` paragraph. Show the
   user that date and the comparison rows, then wait for them to confirm in chat that the
   table is still accurate as of that date. If they do not confirm, stop before deploying.

3. From `website/`, run the website deployment checks:

   ```bash
   npm run check:deploy
   ```

4. Build the current website tree:

   ```bash
   npm run build
   ```

5. Deploy the resulting `dist/` directly to Cloudflare Pages:

   ```bash
   npx --yes wrangler@latest pages deploy dist --project-name plembfin-website --branch main --commit-message "Update Plekt website from local source" --commit-dirty=true
   ```

   If Wrangler needs network access or authentication, request the required permission
   or ask the user to complete Cloudflare login. Do not switch to a GitHub push as a
   workaround.

6. Verify the returned `pages.dev` deployment URL and `https://plembfin.com` both serve
   the new page successfully. Confirm the production response contains the current
   website output when a specific fix or marker is part of the request.

7. Report the production URL and any deployment URL. State clearly that this used the
   website-only path and did not trigger a Plekt application rebuild on GitHub.

"Push to git", "Force to alpha", and "Force to main" remain separate workflows and do
not imply this website-only publish.

## Example request

> Push website live
