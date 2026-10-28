import path from "node:path";
import { getActiveDataDir } from "./userContext.js";

// One process runs every user's scheduler tick in turn, so cadence state kept
// in a module variable is shared by all of them: the admin's run would mark the
// work done before an added user's turn came round. Each call returns the
// state object for the active user's data folder, created on first use.
export function createPerUserState(initial) {
  const states = new Map();
  return () => {
    const key = path.resolve(getActiveDataDir());
    let state = states.get(key);
    if (!state) {
      state = initial();
      states.set(key, state);
    }
    return state;
  };
}
