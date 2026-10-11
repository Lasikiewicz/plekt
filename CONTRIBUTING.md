# Contributing to Plekt

Thanks for your interest in improving Plekt. This is a self-hosted, single-maintainer
project, so please keep pull requests focused and read this guide before opening one.

## Before you start

- For anything beyond a small fix, open an issue first to discuss the change. This avoids
  wasted effort on approaches that don't fit the project's direction.
- Check existing issues and pull requests to avoid duplicate work.
- Security vulnerabilities should **not** be reported as public issues - see [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm install
npm run dev   # auto-reload dev server on http://localhost:5056
```

On Windows, use the host's normal network-enabled environment for this server. If
Codex is launching it, the start command must use the approved elevated network
execution path; the restricted sandbox can serve the UI while denying outbound
connections to connected media servers.

Automated checks are available: `npm test` runs the test suite, while `npm run build`
runs the syntax, documentation, route-guard, and clean-startup checks. There is no
separate linter configured, so also verify changes by running the app locally and
exercising the affected feature in the browser.

## Project structure

See [docs/architecture.md](docs/architecture.md) for a full breakdown of the server
and frontend architecture, including:

- Frontend module boundaries (`public/modules/*.js`) and where new UI code belongs
- The webhook → sync data flow
- SQLite schema and data layer conventions

Please follow the existing module boundaries described there - `public/app.js` is an
orchestrator only, and new frontend logic should go in the most specific existing module for
that feature area.

## Making changes

- Keep pull requests scoped to a single feature or fix. Avoid bundling unrelated refactors.
- Match the existing code style (plain ES modules, no build step, no TypeScript, no framework).
- Update relevant documentation in `docs/` and `README.md` when behavior, setup, or
  configuration changes.
- Write clear commit messages describing the *why*, not just the *what*.

## Submitting a pull request

1. Fork the repository and create a branch from `main`.
2. Make your changes and verify them locally.
3. Open a pull request describing the change, the motivation, and how you tested it.
4. Be responsive to review feedback - this is a small project maintained in spare time, so
   reviews may take a few days.

## Reporting bugs and requesting features

Use the issue templates provided when opening a new issue. Include enough detail (Plex/Emby/
Jellyfin version, relevant log excerpts, and steps to reproduce) for the maintainer to act on the
report. Redact passwords, API keys, access tokens, webhook URLs, and personal information before
posting logs or configuration details.

## Code of Conduct

By participating in this project, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
