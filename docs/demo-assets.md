## Bundled demo artwork

The public demo uses a fixed, bundled fixture rather than asking a visitor's
browser to contact a metadata provider. `scripts/build-demo-assets.js` creates
that fixture in `public/demo-assets/` from TMDB's API:

```powershell
$env:TMDB_API_KEY = "<local key>"
npm run demo:assets
```

`TMDB_ACCESS_TOKEN` can be used instead of `TMDB_API_KEY`. If neither is set,
the builder also reads the TMDB API key already saved in Plekt's local
settings database. The credential is used only for this build and is never
written to the generated catalog, manifest, or image files. Do not put it in
`public/`, a container image, or source control.

The default selection is a snapshot of 50 image-complete movies and 50
image-complete TV shows, ordered by TMDB vote average and filtered to an
established voting history (10,000 votes for movies and 2,000 for TV) plus a
2024-12-31 release-date cutoff. This keeps newly released titles from
replacing recognizable all-time demo content. The exact query policy and
generation timestamp are recorded in `public/demo-assets/manifest.json`, so a
bundle can be reviewed and reproduced before it is published.

The generated bundle includes resized WebP movie/show posters and backdrops,
one bundled poster for every available TV season, local episode stills (with a
local season-poster fallback where TMDB has no still), full movie and show
detail metadata, local cast and review portraits, detail-gallery images, and
trailer thumbnails.
Related titles are only advertised when their poster is also in the fixed
bundle, so the demo does not depend on a live TMDB image request. The demo's
About/Credits surface must display this notice
and link to TMDB:

> This product uses the TMDB API but is not endorsed or certified by TMDB.

This use is intentionally limited to a non-commercial demo. TMDB's current
requirements and attribution guidance are documented in the [TMDB FAQ](https://developer.themoviedb.org/docs/faq)
and [Logos & Attribution](https://www.themoviedb.org/about/logos-attribution).

`npm run demo:seed` copies that catalog into an explicitly supplied isolated
`DATA_DIR` and also seeds offline Discover rails, a three-month Upcoming
calendar, local watchlist/rating examples, and custom lists. It refuses the
normal Plekt data directory and refuses to seed over non-demo watch history.

The scripts only prepare local assets and fixture data. They do not start the
server, create DNS, publish a container, or deploy the hosted demo. The
`Force to main` release workflow publishes a multi-architecture image, then
deploys the exact released tag to the dedicated Oracle Cloud Compute instance
serving [demo.plembfin.com](https://demo.plembfin.com/). The deployment preserves
the OCI demo's `/data` mount and verifies the released version over HTTPS.
Portainer is a local-only environment and is not part of the public-demo release
gate.
