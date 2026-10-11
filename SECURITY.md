# Security Policy

## Supported Versions

Only the latest release on the `main` branch receives security fixes.

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Threat Model

Plekt is a **self-hosted, single-user** dashboard. It assumes:

- The host machine is trusted (it has full access to the SQLite database and `data/` directory).
- The network perimeter is controlled by the operator (typically behind a reverse proxy or VPN).
- A single admin account controls the instance - multi-tenancy is out of scope.

Out-of-scope threats:

- Physical access to the host.
- Compromise of upstream media servers (Plex/Emby/Jellyfin).
- Attacks that require valid admin credentials already.

## Webhook URL Format

Webhooks from Plex, Emby, and Jellyfin should be pointed at:

```
http(s)://<host>/api/webhook?token=<WEBHOOK_SECRET>
```

`WEBHOOK_SECRET` is auto-generated on first boot and shown in **Settings → Media servers → Webhooks**.
Keep it secret - anyone with this URL can inject watch events.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via one of:

- GitHub private security advisory: **Security → Report a vulnerability** (preferred)
- Email: the address in the repository's GitHub profile

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept or affected code reference)
- Affected version / commit hash

You can expect an initial response within **72 hours** and a patch or mitigation within **14 days** for confirmed critical issues.

We do not currently offer a bug bounty.
