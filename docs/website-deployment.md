# Website deployment plan

The static Astro documentation site in `website/` has two deliberately separate
publishing paths:

- **"Push website live"** publishes the current local website tree directly to the
  separate `plembfin-website` Cloudflare Pages project. It does not push GitHub, run
  GitHub Actions, or rebuild the Plekt application.
- **"Force to main"** remains the release-driven path for publishing the reviewed
  website tree alongside an application release. After the release is pushed and the demo
  is verified, it deploys the website from the release commit with the same Wrangler
  command and checks the live site (skill step 8b).

The public application demo is hosted on the dedicated Oracle Cloud Compute instance;
the existing Cloudflare Pages project named `plembfin` is not part of the application
release path and must remain untouched. Use the separate Pages project named
`plembfin-website` for the website and its two small Pages Functions.

## Current repository shape

- Current local Git remote: `https://github.com/Lasikiewicz/plembfin.git`; the planned
  destination is `https://github.com/Lasikiewicz/plekt.git`. The repository rename
  and origin update have not yet been performed.
- Website source: `website/`
- Astro output: `website/dist/`
- Build command: `npm run build` from `website/`
- Current canonical site URL in `website/astro.config.mjs`: `https://plembfin.com`
- The website is a static Astro build (`output: "static"`) with two Pages Functions:
  first-party `/t` serves the Traks tracker JavaScript and `/api/event` forwards event
  requests to the configured collector. The collector origin is a Pages runtime variable;
  it is never embedded in browser code.
- `website/public/_routes.json` includes only `/t` and `/api/event`, so those paths reach
  the Functions instead of falling through to the SPA HTML.

The build reads the repository's root `package.json` and `CHANGELOG.md`, and copies the
root logo, diagram, and provider icons. Cloudflare must therefore build the repository
with `website` as its root directory, not from an exported `website` folder that omits
the rest of the repository.

## Routine local publish: "Push website live"

Use this path when the latest website fixes are in the current local checkout and should
go live immediately. It intentionally does not create a Git commit, push to GitHub, or
start the Plekt application build workflows.

From the repository's `website/` directory:

```bash
npm run check:deploy
npm run build
npx --yes wrangler@latest pages deploy dist --project-name plembfin-website --branch main --commit-message "Update Plekt website from local source" --commit-dirty=true
```

Run the Wrangler command from `website/`, where the sibling `functions/` directory is
available. Wrangler uploads the Pages Functions together with `dist/`; a dashboard
drag-and-drop upload does not compile or publish these Functions.

The deployment must be verified at both the returned `pages.dev` URL and
`https://plembfin.com`. Wrangler deploys the exact `website/dist/` output, so uncommitted
website fixes in the current working tree are included after the checks and build pass.

This path is independent of the GitHub release workflow below. Do not substitute a
repository push, a root `npm run build`, or the `plembfin` application Pages project.

## Local editing and testing: "Start the website"

Use this path when the website should be available locally for editing or testing. It
starts Astro's development server and does not publish or deploy anything.

From the repository root:

```bash
npm --prefix website run dev
```

Open the local URL printed by Astro, normally `http://localhost:4321/`, in the connected
Chrome browser. Keep that server running while editing so changes reload locally. Do not
open `https://plembfin.com` for this workflow, and do not run the application build or
Cloudflare deployment as part of starting the local website.

## 1. Prepare the repository

The root `.gitignore` currently contains `website/`, which keeps this review copy out of
Git. Before the first GitHub deployment:

1. Remove only that root `website/` ignore rule.
2. Add `.local-review/` to `website/.gitignore` so local QA images stay untracked.
3. Keep `website/node_modules/`, `website/.astro/`, `website/dist/`, and `*.local` ignored.
4. Confirm the source and published assets are visible to Git:

   ```bash
   git check-ignore -v website/src/content/docs/guides.mdx
   git status --short --untracked-files=all
   ```

5. Review the list manually. Do not stage `node_modules`, `.astro`, `dist`, local review
   images, `.env` files, provider credentials, tokens, or signed-in browser data.
6. Stage the website source, public assets, `website/package-lock.json`, the website
   privacy manifest, and the related documentation only after the review is clean.

The website is a monorepo project. Keep all root source files used by
`website/scripts/build-release-data.mjs` and `website/scripts/sync-assets.mjs` in the
repository; do not make a second copy of them inside `website/`.

## 2. Validate locally before the first push

From the repository root:

```bash
cd website
npm ci
npm run check:content
npm run check:links
npm run check:assets
npm run check:privacy
npm run check:duplicates
npm run captures:inventory
npm run build
```

Then run the app and website preview together and inspect the affected pages in both
themes. The required baseline and visual/privacy rules are in
[`docs/websiteupdate.md`](websiteupdate.md).

## 3. Optional GitHub release path

The following GitHub path is only for the release-driven `Force to main` workflow. It is
not part of **"Push website live"**.

1. Ensure the deployable website commit reaches the repository's `main` branch only
   through the `Force to main` release workflow.
2. Use the normal repository release workflow if the app is being promoted through
   `develop` → `alpha` → `main`; do not create a separate website-only release branch
   unless that is explicitly chosen.
3. Push the reviewed commit to GitHub only after the user explicitly authorizes the push.
4. Confirm GitHub shows `website/package-lock.json`, `website/src/`, `website/public/`,
   `website/scripts/`, and the root source files the build reads.

## 4. Create the Cloudflare Pages project

In Cloudflare:

1. Open **Workers & Pages**.
2. Select **Create application → Pages → Connect to Git**.
3. Install and authorize the Cloudflare GitHub app for the `Lasikiewicz/plekt`
   repository only where possible.
4. Select `Lasikiewicz/plekt`, then choose **Begin setup**.
5. Use these build settings:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | `website` |
   | Build command | `npm run check:deploy && npm run build` |
   | Build output directory | `dist` |
   | Node version | `22.19.0` via `NODE_VERSION` in Pages environment variables |

Set `NODE_VERSION` for both Production and Preview environments so Pages matches the
Node version used by the local setup guide. The shared website layout embeds the Plekt
Traks key `pb_live_fnve8des76y7lxf58ivx7a5s` and the direct collector script at
`https://plembfin-traks-collect.lasikie.workers.dev/t.js`. Website analytics do not need
build or runtime variables. Do not add application secrets.

Leave automatic production branch deployments enabled, set the production branch to
`main`, and set the preview branch to **None (Disable automatic branch deployments)**.
This means the public site changes only when the release workflow force-pushes the
approved `main` tip; ordinary `develop` and `alpha` pushes do not start Pages builds.
Keep build watch paths at their default so a root application, changelog, release, or
asset change cannot silently skip the next release rebuild. If watch paths are tightened
later, include at least:
`website/**`, `public/**`, `server/src/**`, `docs/**`, `README.md`, `CHANGELOG.md`,
`changelog*.json`, `package.json`, and the website lockfile.

Save and deploy. A successful build should generate release data, synchronize shared
assets, run Astro's static build, and publish `dist/`.

## 5. Add the production domain

1. Open the Pages project and choose **Custom domains → Set up a domain**.
2. Add the final public domain. The current Astro canonical URL is `plembfin.com`; if a
   different hostname is selected, update `website/astro.config.mjs` before the first
   production deployment so canonical links and the sitemap agree with the domain.
3. For an apex domain, put the zone on Cloudflare and configure its nameservers. For a
   subdomain managed elsewhere, associate the domain in Pages first, then create the
   required CNAME to the Pages `*.pages.dev` hostname.
4. Wait for domain verification and HTTPS to become active. Do not rely on a manually
   created CNAME before associating the domain in Pages.

## 6. Verify the first deployment

Check the deployment log and then test the deployed site at its `pages.dev` hostname and
custom domain:

- `/` and `/docs/` return the expected pages;
- `GET /t` returns JavaScript rather than the SPA `index.html`;
- a real page load produces a 2xx first-party `/api/event` request and a pageview in the
  Traks dashboard;
- `/docs/guides/`, `/docs/getting-started/`, `/docs/movies/`, and
  `/docs/tv-shows/media-page/` load directly;
- all internal links remain path-only and do not expose local hostnames;
- dark and light screenshots load, including the full detail-page captures and focused
  Up Next and movie-menu captures;
- the movie three-dot screenshot matches the current six-action menu;
- preview and production pages contain no transient provider-error banner or identifying
  data in a published image; and
- the sitemap and canonical URLs use the intended public domain.

Use the local preview and the app's connected test environment for pre-release review.
Automatic Cloudflare preview deployments are disabled so `develop` and `alpha` remain
release staging branches rather than public Pages deployment sources.

## 7. Operate and recover

- The `Force to main` workflow publishes the production deployment itself with Wrangler
  after its push to `main`, then verifies the live site; it does not rely on the
  Git-connected build.
- `/assets/*` is cached as immutable for a year, so `ScreenshotFigure` adds a `?v=` hash of
  the source file to every screenshot URL. A retaken capture then gets a new address
  instead of a stale cached copy. Images referenced outside that component have no hash:
  rename the file when its content changes.
- Ordinary pushes to `develop` and `alpha` do not create Pages deployments.
- Keep the Cloudflare GitHub app access scoped to the repository and review build logs
  for accidental secret output.
- If a production build is bad, use **Deployments → … → Rollback to this deployment**
  for the last successful production build, then fix the source and merge a normal
  follow-up commit.
- Run the website update workflow whenever app behavior, release data, routes, settings,
  or screenshots change. The mandatory Force-to-main website gate in `CLAUDE.md` and
  `docs/websiteupdate.md` happens before promotion work begins.

## Official references

- [Cloudflare Pages Astro guide](https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/)
- [Cloudflare Pages Functions routing](https://developers.cloudflare.com/pages/functions/routing/)
- [Cloudflare Pages Direct Upload and Functions](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- [Build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Build image and Node versions](https://developers.cloudflare.com/pages/configuration/build-image/)
- [Monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/)
- [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- [Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
