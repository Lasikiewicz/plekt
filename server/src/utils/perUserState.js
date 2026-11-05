import path from "node:path";
import { getActiveDataDir } from "./userContext.js";

// One process runs every user's scheduler tick in turn, so cadence state kept
// in a module variable is shared by all of them: the admin's run would mark the
// work done before an added user's turn came round. Each call returns the
// state object for the active user's data folder, created on first use.
//
// maxEntries bounds memory for large per-user state (the history caches): the
// least recently used folder's state is dropped first and is rebuilt from its
// database on that user's next read. Leave it unset for small cadence state,
// where dropping an entry would reset a timer.
export function createPerUserState(initial, { maxEntries = 0 } = {}) {
  const states = new Map();
  const limit = Math.max(0, Math.floor(Number(maxEntries) || 0));
  return () => {
    const key = path.resolve(getActiveDataDir());
    let state = states.get(key);
    if (state) {
      if (limit) {
        // Map keeps insertion order; re-inserting marks this folder most recent.
        states.delete(key);
        states.set(key, state);
      }
      return state;
    }
    state = initial();
    states.set(key, state);
    if (limit) {
      while (states.size > limit) states.delete(states.keys().next().value);
    }
    return state;
  };
}
