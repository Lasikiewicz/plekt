# Website update workflow

When a website update is requested, carry out the following workflow:

1. Refresh `origin/main` first (`git fetch origin main`) and resolve the latest stable release from that branch's `package.json` or newest `changelog.json` entry. Never use the current `develop` or `alpha` version, a proposed next version, or a hard-coded historical fallback as the new verification baseline. Inspect the current website documentation and its existing `sourceVersion` markers to determine what each page already covers, review the application and changelog for all changes after those markers, and record the resolved latest `main` version on every page that is revalidated.
2. Start the local plembfin server and the local website preview from the `website` folder, and record the local URLs and relevant environment details.
3. Refresh and read the local committed-change inventory with `npm run updates:refresh` and `plan/updates.md`. Start with its **Website check targets**, **Website images to retake** (the same list as `npm run captures:stale`, rebuilt after every commit) and **Changelog-ready changes**, then review the application source, changelog, release data, and existing website content for all changes after the discovered verification baseline. The inventory is a deduplicated review aid; it does not replace the committed changelog manifests or human review.
4. Update the website documentation and supporting content so that it accurately reflects the current product, including names, descriptions, routes, controls, behavior, and links. Do not describe removed pages, removed controls, or historical defects as current behavior. If a repair is still useful, put it in a clearly separate troubleshooting or repair note and describe the current command or setting.
5. Use route-only examples for in-app detail pages, such as `/tvshow/tvdb/<id>-<slug>/` or `/movie/tmdb/<id>-<slug>`. Keep `localhost` or other hosts only in setup instructions that explicitly explain how to start or open the local application.
6. Link every reference to another setting, page, feature, or repair action to its corresponding website section. Keep articles compact: use short paragraphs, bullets, and focused subsections instead of large blocks of prose.
7. When an existing item has changed, inspect the affected page in the local preview and verify whether its rendered appearance has changed. Use the local environment details to check layout, typography, spacing, colors, controls, states, and responsive behavior as applicable. Every screenshot and caption must match the section it illustrates. Use one genuinely full detail-page capture for a page overview, and use focused captures only for the control or section being explained. Remove a redundant image at the very top when the next section already shows the same view; do not replace that with a cropped or first-viewport image when the page overview is expected to show the complete page.
8. Keep page-specific guidance current: show the separate **Spoilers on** and **Spoilers off** states with matching images, document **Force Sync** with both its title-level menu and the broader Sync Tools settings, and give each Trailers & Clips, Reviews, Related Shows, and Appearance section an image that actually depicts that section when a useful capture exists. Provider Reviews and public/example Playlists are approved unblurred content; do not blur them solely because they appear in those sections. If a screenshot is too large, blurry, or privacy-redacted in the wrong place, recapture it at a useful size and preserve allowed public media facts such as watch dates and ratings.
9. Run `npm run captures:inventory` to enumerate every image referenced by the website and report added, changed, removed, missing, or unreferenced captures. Run `npm run check:duplicates` to catch repeated figures inside one article. Use the generated manifest to review the whole capture set together rather than collecting images one by one.
   For a scrollable detail page, use `npm run captures:compose -- --prefix=<temporary-capture-prefix> --positions=0,<middle-scroll>,<max-scroll> --page-height=<page-height> --content-x=<sidebar-width> --fixed-top=<sticky-header-height> --output=<final-capture-path>`. Add `--redact=x,y,width,height` when a reviewed region must be blurred in the composed image.
10. Treat image privacy as a hard release gate. Every image published by the website, including raster captures and SVG assets, must have an explicit entry in `website/capture-privacy.json`. Before committing an image, inspect it for keys: API keys, tokens, and other secrets. The app normally shows these blanked; if one is visible, blur it in the image itself, record the redaction in the privacy manifest, and never publish the raw capture. Nothing else is blurred: usernames, account names, server or library names, playlist titles, backup filenames, and account identifiers stay visible and are recorded under `safeAssets` (user decision, 27 September 2026). Provider Reviews and public/example Playlists are explicit approved exceptions and do not need blurring; keep them unblurred unless the capture also contains unrelated identifying data. Public media titles, cast names, provider ratings, and watch dates are not user-identifiable by themselves and must not be blurred unnecessarily.
11. Check information architecture while updating: removed landing pages must not remain in the sidebar, page navigation, feature outlines, or cross-links; dedicated Watchlist, Ratings, and Playlists pages should be linked directly. Dashboard documentation must describe resume and part-watched items inside **Up Next**, not as a separate current section.
12. Keep the written guidance compact and present-tense. Use a separate repair note for a still-useful current repair, such as “If the actual episode names are missing, run **Settings → Tools → Database Repairs → Restore Missing Episode Names**”; do not describe an old defect, coordinate-only record, or removed workflow as current behavior. Link every reference to another setting, page, feature, or repair action.
13. Before committing, use the same resolved latest `main` version in any verification wording or changelog bullet, such as `Mark Getting started as verified against the v<latest-main> application baseline`. Do not copy the page's previous marker into that wording, and do not rewrite an already-published release entry unless the user explicitly asks for a correction. Run the website checks/build after editing, including the capture inventory, duplicate-figure check, and privacy check. Resolve relevant failures, and report the files changed, validation performed, local preview URL, visual findings, and any remaining content discrepancies.

## Issues found during the current update and how to prevent them

- **Baseline drift:** the website was marked against an older release while the app was
  already on a newer stable release. Discover each page's existing marker so historical
  changes are not skipped, but resolve the new marker from the latest `origin/main` release
  rather than a stale fallback or the current alpha/develop version. Use that same resolved
  version in the page metadata and any verification wording.
- **Duplicate documentation:** an all-features page and a combined library page repeated
  the focused page guides. Keep one canonical page per task, use the [Guides](/docs/guides/)
  landing page as an index, and link to the owner instead of copying procedures.
- **Guides versus Getting started:** Guides is the top-level map for the documentation
  section and should explain how the canonical pages fit together. Getting started should
  stay limited to installation, claiming, Guided Setup, and the first health check; do not
  copy onboarding stages or create a second application-map article.
- **Onboarding repeated in Getting started:** connecting the first media server belongs to
  the in-app Guided Setup flow. Keep Getting started focused on installation, claiming,
  Guided Setup, and post-setup checks; link to [Settings → Media servers](/docs/settings/media-servers/)
  for a later connection.
- **Stale UI actions:** the movie-card menu had changed but its screenshot and text listed
  only three actions. Open the current menu in the local app, record every visible action,
  recapture both themes, and update all pages that reuse that asset.
- **Wrong image for the section:** a full-page image, a focused control crop, and an image
  containing a transient error are not interchangeable. Name captures by the section they
  show, compare the screenshot with the heading and caption, and reject a capture if it
  contains an error banner or unrelated state.
- **Over-redaction:** blur only visible keys, tokens, and secrets (the app normally blanks
  them already). Usernames, account names, server/library names, playlist titles, backup
  filenames, media titles, cast, provider ratings, and watch dates remain visible. A capture
  with no visible key is published without blur and recorded under `safeAssets`.
- **Hostnames in route examples:** in-app route documentation uses paths such as
  `/tvshow/tvdb/<id>-<slug>/`; `localhost` belongs only in setup and local-preview commands.
- **Dense copy:** split long explanations into short paragraphs, bullets, and linked
  subsections. A sentence that points to another page should link directly to that page,
  not reproduce its full guide.
- **Dashboard state confusion:** resume and part-watched items are part of **Up Next**.
  Keep one focused Up Next capture with no provider-error banner and do not document a
  separate current Part Watched section.
- **Missing capture inventory:** run `npm run captures:inventory` after every capture edit,
  crop, deletion, or rename. Review the generated manifest's added, changed, removed,
  missing, and unreferenced lists before the final privacy and build checks.
- **Repeated figures returning:** run `npm run check:duplicates` after restructuring a guide.
  Keep one useful figure per view in an article; use a focused crop for a focused control and
  link to the canonical guide rather than repeating the same screenshot under every related
  subsection.
- **Global search placement:** keep the documentation search control in the shared site
  navbar so it is available from every website page. Submit searches to `/docs/?q=...`, keep
  the results list on the documentation landing page, and verify both empty and populated
  clear states after changing the shared header.
- **Homepage positioning and proof:** the home page should lead with Plekt as the local
  source of truth—the brain that tracks playback, remembers canonical state, and auto-syncs
  the right answer back to connected services. Keep the main Track → Remember → Auto-sync
  loop visible, then send the broader feature inventory to the top-level `/features/` page.
  Use real captures on the feature page when they clarify a workflow; do not force a screenshot
  into the short overview. Preserve the shared navbar, light/dark theme support, responsive
  layout, keyboard focus states, and reduced-motion behavior. Re-run the local visual pass on
  both routes, in both themes, and at narrow widths before accepting a redesign.
- **Homepage tone and spacing:** avoid generated-looking hero treatments, oversized slogan
  typography, fake dashboards, ambient grids, glows, and excessive whitespace between
  related items. Lead with a real product capture, use plain product language, keep the
  Track → Remember → Auto-sync explanation close to the hero, and use compact spacing so
  the page feels like a maintained product rather than a concept page. Check that the hero
  headline, supporting copy, screenshot, and calls to action all explain the same product
  promise before accepting the visual pass.
- **Homepage must feel like Plekt:** keep the home page dark-first, compact, media-first,
  and aligned with the app's dashboard language. Use real screens and the existing tokens;
  do not wrap screenshots in decorative boxes, add marketing-only reveal effects, or fill
  every feature with a paragraph. Use short linked rows for secondary features and let the
  actual media UI carry the visual weight. Check the hero, core flow, feature list, and
  product proof at their anchors in both themes before accepting the page.
- **Keep the homepage and feature index separate:** the homepage should explain Plekt in
  one short overview and one clear Track → Remember → Auto-sync flow. Put the broader feature
  inventory on the top-level `/features/` page, using concise grouped rows and direct links to
  the detailed documentation. Do not turn the homepage into a second documentation index.
- **Product-site visual direction:** when the homepage or Features page changes, review the
  current official [Sonarr](https://sonarr.tv/), [Radarr](https://radarr.video/),
  [Seerr](https://seerr.dev/), and [Plex](https://www.plex.tv/) presentation patterns. Borrow
  the useful structure—screenshot-led product proof, short feature sections, clear actions,
  and media-first rails—but keep Plekt's own copy, logo, reviewed captures, and UI language.
  Use the existing `--accent`, `--blue`, `--text`, `--soft`, and `--bg` tokens so light mode
  and dark mode retain the Plekt palette. Do not introduce a purple/gradient palette or copy
  another product's identity. Recheck both routes in both themes after every visual change.
- **Simple landing-page reference rule:** a reference such as [Scrob](https://scrob.app/) may
  be reviewed for high-level communication structure only: one clear promise, one useful
  product view, a short feature overview, and direct links into the docs. Never copy its
  wording, logo, colour treatment, imagery, layout details, or product claims. Rebuild the
  idea with Plekt's existing tokens, current screenshots, and accurate source-of-truth
  language. Keep the homepage shorter than the Features page; do not turn either page into a
  large hero, a generic AI-style marketing composition, or a second copy of the docs.
- **Landing-page link audit:** every page-specific documentation link on the homepage or
  Features page must include the exact generated section anchor when one exists, such as
  `/docs/dashboard/#up-next` or `/docs/settings/backup/#remote-backups`. After building, check
  each fragment against the matching `dist/docs/.../index.html` heading ID; the normal link
  checker does not replace this fragment-level verification. Shared navbar and footer links
  may intentionally land on the documentation index.
- **Feature-link meaning audit:** an existing anchor is not automatically the right
  destination. Compare each feature title and summary with the content under the target
  heading; use `#security-basics` for hardening guidance, `#pwa-and-local-operation` for
  PWA/local-operation guidance, and `/docs/getting-started/#before-you-install` for the
  self-hosted setup explanation.
- **Homepage backup reminder:** place the backup explanation in or immediately below the
  Track → Remember → Auto-sync rows, not as a detached aside beside the section heading. It
  must make clear that the local archive can be protected with both local backups and
  optional remote backups. Link the two phrases directly to `#local-backups` and
  `#remote-backups` so the distinction cannot be lost in general backup wording.


Poster acceptance is mandatory for every retained or replacement image: inspect the final
file at its original size and check the visible posters against the live candidate.
No missing/broken/unloaded poster, clipped poster/card at a frame edge, stretched,
squashed, skewed, or incorrect-aspect artwork is accepted. Intentional spoiler masks are
allowed only in the explicitly named spoilers-on view. Inspect natural and rendered image
dimensions/object-fit when proportions are suspect; never resize a frame non-uniformly,
hide an error, or alter DOM content/styles to make it pass. Fix the actual capture framing
or report the app/artwork blocker, then recheck. Tool `ok` and correct output size alone
are not acceptance. Record poster findings per variant in capture results.

## Commit decisions and image selection

Every new commit must state `site-impact: <guide slugs>` (website check required) or
`site-impact: none` (not required), with a plain non-bullet `Website review:` body note
explaining the reason, copy to review, and image IDs/sections to compare (or images: none
and why). Preserve these decisions when consolidating commits. Review means checking
accuracy; it does not automatically require changing a guide or retaking an image.

During Force to main, read the product commits since the published main baseline and
compare existing affected website images and copy against the approved candidate.
Ignore mechanical asset stamps when assessing visible change. Record keep/retake/blocked
with evidence and commit references. Keep accurate images; capture only visibly changed
variants or necessary new illustrations. Update stale or missing written guidance,
captions, and links too. A source-path match, shared stylesheet edit, or generated stale
list is a review aid, never an instruction to recapture everything. Phase B receives only
the confirmed capture list; blocked comparisons remain open phase A work.

## Force-to-main website gate

Run this gate only after the release-candidate phase of **Force to main** has finished.
First pin `origin/alpha`, preview the release changelog, start that pinned build, and get
the user's approval of both the changelog and running app. Record the approved source hash,
served version, server PID, and approval in the per-release summary. If the candidate changes,
repeat its approval before starting phase A. The website gate is mandatory for every main
release.

For the next **Force to main** after the port-default change, create a dedicated website guide for existing users explaining how to move Plekt to port 5056 (including Docker/Unraid port mapping and Windows upgrade behavior), then add a direct link to that guide in the new release changelog entry. Verify the guide link in the public Changelog as part of the website gate.

The gate has three phases, all checked against the same approved release build:

1. **A — review and prepare:** Resolve the current `origin/main` documentation baseline,
   read the release's website-impact targets, review affected guides in the local website
   preview, make any edits on local `develop`, and write the run's `capture-run.json` and
   a short `captures.md` from the skill's template. The capture ids must pass
   `recapture.mjs --check`, and a trial run's WARN lines (cut-off or misshapen posters,
   empty rails) are fixed in the catalogue framing or reported as app defects before handoff.
   `npm run captures:stale` in `website/` lists the images whose catalogued source files
   changed since `origin/main` as review candidates. Compare their existing images first;
   use the suggested command only after narrowing it to confirmed retakes and variants.
   The application being documented is the pinned alpha candidate running on port 5056,
   not the `develop` app. Stop after writing the capture list and hand it to phase B.
2. **B — capture only:** Give a cheaper agent the one-line handoff naming `captures.md`.
   It reads that file alone and runs one command, `npm run captures:release -- --run=<run
folder>`, which checks the served build, signs itself in (from `PLEKT_USER` and
`PLEKT_PASSWORD`, or `.claude/local-environment.md`), takes every listed image, and
   writes `captures/results.md` and `captures/contact-sheet.html`. There is no browser and
   no hand capture. Images that need a live state are included only when phase A created
   that state before handoff (named in `live`). An image with a non-standard frame size has
   its own `viewport` in `website/capture-catalogue.json`. It does not edit `website/` or
   commit. Failed images remain failed.
3. **C — place and check:** Review every staged image and its composition/privacy, place
   accepted images and captions, update the privacy manifest, run the website checks, and
   commit the completed website work on local `develop`. Only after phase C does the release
   procedure carry that website tree into the pinned alpha checkout.

Run the automated content-impact check in phase A to establish the guide list, then run it
again in the alpha checkout after the reviewed website is carried into the release. Finish
the website checks before promotion can continue.

The automated checks below cannot see a stale caption or a screenshot that was never
retaken; they pass as long as each needed guide changed. So when a plan tracks the release's
website work, every unticked item in it must be done, or explicitly accepted by the user in
chat as shipping without it, before the gate passes. Accepted leftovers are listed again at
the release go-ahead.

### Content-impact check (automated, fail-closed)

The website is only updated for application changes during **Force to main**, once the
release is final. Develop and alpha work can still change, and neither branch publishes the
site, so documenting it earlier is wasted effort. Push to git records intent instead: each
product commit ends with a note naming the guides it will need.

```text
site-impact: dashboard, media-details
site-impact: none
```

Slugs are the `docSlug` values in `website/src/data/app-surface.json`.

`scripts/site-impact.js` turns those notes into the release's website to-do list and
enforces it:

- A commit with `site-impact: none` needs no guide.
- A commit naming guides needs exactly those. The note replaces the file mapping for that
  commit, because a shared file such as `public/index.html` maps to a dozen guides. An
  unknown slug fails the check, so a typo cannot silently pass.
- A commit with no note needs every guide `app-surface.json` maps its changed files to (the
  same mapping as `plan/updates.md` **Website check targets**). Changed `public/`, `server/`
  or `docs/` paths that no guide covers are printed for review. They do not fail the check.

A needed guide passes when its content differs from the live `origin/main` website in the
tree being released. Phase C commits the reviewed website on local `develop`; the release
procedure carries that website into the pinned alpha checkout and runs the definitive gate
there. A `sourceVersion` restamp alone does not count, because `promote-alpha-to-main.js`
stamps every page. When the review finds a needed guide is still accurate, record that in
`website/src/data/release-review.json` rather than making a cosmetic edit:

```json
{ "publishedVersion": "1.2.1", "unchanged": { "stats": "only the asset restamp touched it" } }
```

Entries only count while `publishedVersion` is the version live on `origin/main`, so one
release's review never excuses the next.

Run it in phase A to guide review, then re-run it in the release checkout after phase C
until it passes:

```bash
npm run check:website-impact
```

It also runs inside `node scripts/promote-alpha-to-main.js`: `--preview` lists the guides
still outstanding without stopping, so the changelog can be approved before any website work,
and `--confirm` refuses while any remain, so it cannot be skipped. **Resolving a failure:**
update the guide (or record it as reviewed) during phase A/C on `develop`, commit, carry the
website into the pinned release checkout again, and retry. No Force to alpha rerun is needed.

Release-bookkeeping commits (changelog rebuilds, alpha/main promotions, build-counter resets)
are excluded from the walk entirely, since they mechanically restamp most of `public/`
without being a real product change. `website/`-only edits, `README.md`, `package.json`, and
the changelog manifests are release metadata and shared layout, not a catalogued feature
surface, and are not gated.

## Publish plan

The website is a tracked static Astro site in `website/`. The GitHub-to-Cloudflare Pages
setup, including the separate project for the docs site, build checks, previews, domain,
rollback, and verification steps, is documented in [`docs/website-deployment.md`](website-deployment.md).
This update workflow validates the site locally; Cloudflare Pages repeats the deploy checks
before publishing the `main` build.
