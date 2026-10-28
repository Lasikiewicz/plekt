Rules that hold regardless of which skill is running:

- A trigger phrase never means `git push` by itself; the push is one late step inside the
  workflow, after every gate has passed. Never deploy or push to any remote unless the user
  explicitly asked in that request.
- "Start the server": `npm run server:restart -- --if-down` (reuses a running server) on
  `http://localhost:5056`; `npm run server:restart` forces a restart. It needs outbound network
  access for providers; see `docs/development.md` "Windows provider-backed server launches".
- "Check requests" is local-only and read-only: inspect the registered Plex, Emby, and Jellyfin
  request pages in connected Chrome, compare status/votes/comments with the ignored local
  snapshot, and draft (never post) replies a maintainer needs. If a provider asks for login,
  stop at that provider and tell the user which session needs attention.
- Before any remote push, inspect `plan/bugs.md`. Any unchecked bug or follow-up blocks develop, alpha, and main pushes until resolved and verified/closed; deferral does not clear the gate. If the user explicitly authorizes a particular push despite the backlog, set `PLEKT_BUG_BACKLOG_OVERRIDE` to that push's full HEAD SHA for the gate and push command only. The pre-push hook checks the exact SHA and reports the exception; the reports stay open. Never set this exception without explicit user authorization.
- Never bypass a hook with `--no-verify`, and never bypass the changelog rebuild.
- The `.githooks/post-commit`, `post-merge`, and `post-rewrite` hooks regenerate the ignored
  `plan/updates.md` ledger from committed history since `origin/main`. Refresh it with
  `npm run updates:refresh` before Push to git or Force to main and use its changelog bullets
  and website targets as the review inventory. It does not replace the committed changelog
  manifests or the human website gate.
- Before Push to git, Force to alpha, or Force to main, check GHCR Cleanup is not mid-run
  (`gh run list --workflow ghcr-cleanup.yml --limit 1`); each skill repeats this first.
- "Force to alpha" and "Force to main" force-push shared branches; follow each skill's
  changelog and running-build approval gates before pushing. "Force to main" approves the
  pinned alpha changelog and running build before website phases A/B/C, carries the reviewed
  website into that release, then stops for a final review of the exact commit before push.
- Neither force command pushes `develop`. If a procedure tells you to, it is out of date.
