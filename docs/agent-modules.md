# Module rules

## Module discipline (frontend and backend)

Size limits: `public/app.js` is orchestrator only, under **3,000 lines**.
`public/modules/*.js` and `server/src/routes/*.js`: soft limit **1,200**, hard limit **1,500**
lines; split by feature area before adding to a file past the soft limit.
`server/src/index.js` is the route table only, under **500 lines** (currently 190).

### Grandfathered files

Files already over their limit are listed in `docs/development.md` "Module size limits"; the
limits apply in full to every other file.

- **Do not grow them.** New code for these areas goes into a new or existing sibling module.
- **Do not split one on your own initiative.** Being over the limit is not a task. Split only
  when the requested work already touches that file, and only after proposing the extraction
  and getting the user's explicit go-ahead. These files own a lot of behavior; a careless split
  breaks more than it tidies.
- **When a split is approved, do it properly.** Move whole feature units or handler groups, not
  line ranges; keep named exports working or update every importer; check nothing else imported
  what moved. Frontend: add the `modulepreload` link in `index.html` (or register a route module
  in `route-modules.js`) and update the module table in `docs/frontend.md`. Backend: update the `dispatch()` entries in `server/src/index.js` and the API area table.

`server/src/routes/sync.js` deserves particular care: it owns webhook ingestion, manual watch and
unwatch, playback progress, sync job/history APIs, cron and force sync, preview plans, and now
playing, and several incident-driven rules in [`docs/decisions.md`](decisions.md) constrain it.

### Where new frontend code goes

Before adding frontend code, look up the owning module in the feature-area table in
[`docs/frontend.md`](frontend.md) ("Where new frontend code goes") and place the code in the
most specific module listed there. Create a new module only when the area fits none of them and
would exceed 150 lines; follow that doc's "Adding a new module" steps (core-graph modules get a
`modulepreload` link, route modules are registered in `route-modules.js` instead) and add the new
module to the table.

**Dependency rules:** modules may import from `state.js`, `utils.js`, `images.js`, `auth.js`,
`logs.js`, `settings.js`, `settings-ui.js`. `sync.js` may be imported by `dashboard.js` and
`media-detail.js`, not the reverse. No module imports from `app.js`. No circular dependencies;
shared logic for A↔B belongs in a third module.

### Where new route code goes

Add the route entry in `dispatch()` in `server/src/index.js` and put the handler in the owning
`server/src/routes/*.js` module. Keep helpers in `server/src/utils/` only when more than one
route module needs them. No imports back into `server/src/index.js`; route modules may import
utilities and data-layer modules directly. The owning module for each API area is in the
`server/src/routes/` table of `docs/file-map-server.md` (scheduler tick and Plex notification
listener: `server/src/scheduler.js`).
