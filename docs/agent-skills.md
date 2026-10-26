# Plekt agent skills

Use this index to find the workflow that matches a task. Each skill's `SKILL.md` is the
source of truth for its trigger, boundaries, and steps. Follow its links for detailed project
procedures; keep shared guidance in its owning docs instead of copying it into several skills.

## Releases and repository

| Task | Skill | Example request |
| --- | --- | --- |
| Draft release announcements | [announce-release](../.claude/skills/announce-release/SKILL.md) | `Announce release` |
| Promote develop to alpha | [force-to-alpha](../.claude/skills/force-to-alpha/SKILL.md) | `Force to alpha` |
| Promote alpha to main | [force-to-main](../.claude/skills/force-to-main/SKILL.md) | `Force to main` |
| Push the current develop work | [push-to-git](../.claude/skills/push-to-git/SKILL.md) | `Push to git` |
| Commit this chat's finished work locally | [commit-locally](../.claude/skills/commit-locally/SKILL.md) | `Commit locally` |

## Website

| Task | Skill | Example request |
| --- | --- | --- |
| Start the local website preview | [start-website](../.claude/skills/start-website/SKILL.md) | `Start the website` |
| Publish the website | [push-website-live](../.claude/skills/push-website-live/SKILL.md) | `Push website live` |
| Capture website images for a named release handoff | [website-capture](../.claude/skills/website-capture/SKILL.md) | `Force to main v1.2.3, phase B (capture only): read the named captures.md assignment and follow it.` |

## Community and requests

| Task | Skill | Example request |
| --- | --- | --- |
| Check public feature request status | [check-requests](../.claude/skills/check-requests/SKILL.md) | `Check requests` |
| Draft a community post or reply | [draft-community-posts](../.claude/skills/draft-community-posts/SKILL.md) | `Draft a Reddit post for r/selfhosted about Plekt's new release.` |

## Local development

| Task | Skill | Example request |
| --- | --- | --- |
| Start or stop the local app and named test containers | [plekt-local-stack](../.claude/skills/plekt-local-stack/SKILL.md) | `Start the server` |
