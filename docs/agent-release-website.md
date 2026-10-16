# Release website operations

Read for Force to main phases A and C. Skill asset paths resolve from
`.claude/skills/force-to-main/`. Phase B is assigned to the website-capture skill.

### 3 - Website phase A: review against the approved running build

Return to the main checkout on `develop`. Follow `docs/websiteupdate.md` for baseline
discovery, change review, content quality, and visual/privacy checks. Its Force-to-main
section defines phases A/B/C; the app target is the running main-build candidate on 5056. Never
restart the develop app to review or take captures. Only describe behaviour present in
the approved release source, including in website pages already edited on develop.

```bash
npm run updates:refresh
npm run check:website-impact
```

Read `plan/updates.md` (Website check targets, Website images to retake, Changelog-ready changes, and commit inventory).
The develop inventory can include later application work: reconcile targets against the
pinned alpha changes and preview's outstanding list. The definitive impact check is run
in the alpha checkout after carrying in the reviewed website in step 5.

Before choosing captures, read the actual product commits between the published main
baseline and the pinned candidate, including their `site-impact:` and `Website review:`
notes. For older commits without explicit notes, inspect the meaningful diff, ignoring
asset version stamps and release bookkeeping. A changed source path or shared stylesheet
is only a review candidate, never proof that every image needs replacing.


Poster acceptance is mandatory for every retained or replacement image: inspect the final
file at its original size and check the visible posters against the live candidate.
No missing/broken/unloaded poster, clipped poster/card at a frame edge, stretched,
squashed, skewed, or incorrect-aspect artwork is accepted. Intentional spoiler masks are
allowed only in the explicitly named spoilers-on view. Inspect natural and rendered image
dimensions/object-fit when proportions are suspect; never resize a frame non-uniformly,
hide an error, or alter DOM content/styles to make it pass. Fix the actual capture framing
or report the app/artwork blocker, then recheck. The capture tool reports clipped and
misshapen posters, empty rails, and unloaded images as WARN; a row with no WARN still gets
a look in phase C.

Compare the existing website's affected text, captions, and images with the approved
running main candidate in the same route, state, viewport, style, and mode. For each
candidate image record the introducing commit, existing asset, comparison evidence, and
one decision: **retake - visible difference and reason**, **keep - still accurate and why**,
or **blocked - comparison not completed**. Keep accurate images. Retake only variants
whose depicted UI changed; never feed the whole stale-tool output into the capture tool.
Include a new image only when changed/new guidance needs one and no existing accurate
image explains it. Update stale or missing website information, instructions, captions,
and links as well as images; a fresh screenshot alone does not finish a guide review.
Do not hand off phase B with an unperformed comparison labelled as a required retake.
Put this decision record in the phase A results and only confirmed retakes/new images in
`captures.md` and its IDs file. Each capture entry must state why the existing image is
insufficient and which commit changed it. If none differ, explicitly hand off no captures.
On a resumed handoff, the user's narrowed scope takes precedence over the inherited list;
reconcile it before creating live state or taking further images.

Review affected guides and shared site surfaces against the running candidate. Make
website copy edits on `develop`, identify required captures, and start the website preview
from `website/` with `npm run dev`. Find image review candidates with `npm run captures:stale`
in `website/` (source paths changed since `origin/main`; this is not a mandatory retake list), reconciled
against the pinned alpha changes like the inventory; `npm run captures:retake -- <ids>`
retakes them as `website/capture-catalogue.json` describes. A placed image whose size
differs from the catalogue fails `npm run check:catalogue`, so update its catalogue sizes. A guide that remains accurate may instead be recorded
in `website/src/data/release-review.json` with a reason; `publishedVersion` must match the
version live on `origin/main`, so old reviews never excuse this release.

End phase A with a handoff phase B can run as one command. The capture tool
(`website/scripts/recapture.mjs`, wrapped by `npm run captures:release`) is the only capture
method; there is no hand capture. When the tool cannot take a frame, fix its entry in
`website/capture-catalogue.json` (target, steps, `viewport` for a non-standard frame such as
`manual-watch-review` at 2560 x 1290, sizes), never take it by hand.

1. Write `plan/active/force-to-main-<version>/capture-run.json`:
   `{ "baseUrl": "<candidate URL>", "expectVersion": "<version>", "expectChannel": "release",
   "ids": [...], "live": [...] }`. If no captures are needed, say so and skip phase B.
2. Live states (`playback`, `manual-review-item`, `dismissed-up-next`, `sync-issue`): the tool
   does not create them yet. Phase A creates any that a listed id needs in the local test
   environment just before handoff and names it in `live`; otherwise that id is left out and
   recorded in the run summary for phase C.
3. From `website/` run `node scripts/recapture.mjs --check --ids-file=<ids> --base-url=<URL>
   --expect-version=<version> --expect-channel=release --live=<states>`. It must exit 0. A
   framing target it cannot resolve is a catalogue fix now, not a phase B problem.
4. Run the same ids once without `--check` into a scratch folder and read the WARN lines. A
   cut-off, squashed or heavily cropped poster, or an empty rail, is a framing or app layout
   problem a retake cannot fix: fix the catalogue framing, or report the app defect to the
   user before handoff.
5. Copy [assets/captures.template.md](../.claude/skills/force-to-main/assets/captures.template.md) to
   `plan/active/force-to-main-<version>/captures.md` and fill its placeholders. It carries no
   credentials; the tool reads the sign-in from `.claude/local-environment.md` itself.

Record the phase result and the run folder in the run summary, then stop.

### 4 - Website phase B handoff, then phase C completion

**Stop after phase A and print this one line for the user to paste into a cheaper agent:**

```text
Force to main v<version>, phase B (capture only): read plan/active/force-to-main-<version>/captures.md and follow it.
```

When invoked with **phase B (capture only)**, read only the named `captures.md` and do
what it says: one `npm run captures:release` command, then report. Do not restart the
release procedure, touch its lock, use a browser, capture by hand, edit `website/`, or
commit. A failed item stays failed. Return the summary line, the results path, and the
phase C handoff line, then stop.

Do not take over phase B's captures in the phase A session. Record the waiting state and
leave the worktree, server, and lock available. The handoff back is:

```text
Force to main v<version>, phase C: read the run summary.
```

When invoked with **phase C**, resume here from `plan/force-to-main-<version>.md` and
the recorded capture results; do not rerun promotion or earlier approvals. Reconcile the
lock as described in step 0. Verify the same alpha hash and server are still in use,
then open `captures/contact-sheet.html` and `captures/results.md`, and inspect every staged
image and every WARN row before bringing accepted images into `website/`. A WARN (cut off,
squashed, cropped, empty rail, never loaded) is a framing or app problem: fix the catalogue
or report it; do not send it back for a plain retake. Reject stale states, wrong views, errors, or visible secrets; apply the privacy
rules in `docs/websiteupdate.md` and record all published images in the privacy manifest.
Complete captions, links, themes, affected-page visual checks, and the full website gate.
Run from `website/`:

```bash
npm run captures:inventory
npm run check
npm run build
```

Review inventory changes and resolve gate failures. Automated checks cannot establish
that captions and captures are current. Every unticked release website item must be done
or explicitly accepted by the user in chat as shipping without it; record accepted
leftovers for the final review. Commit website changes on local `develop` before step 5.
Do not push develop, and do not run Force to alpha again for website-only work.

`website/` is taken from local `develop` so reviewed edits remain available permanently.
The release commit is never merged back; website work confined to alpha would be lost.
Cloudflare Pages publishes only `main`, so these local develop edits are not public yet.
