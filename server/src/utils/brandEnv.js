// App-specific environment variables are named PLEKT_<NAME>. The app was called
// Plembfin before, and installs configured then still set PLEMBFIN_<NAME>, so
// every read goes through here: the new name wins and the old one is accepted
// indefinitely.
const PREFIX = "PLEKT_";
const LEGACY_PREFIX = "PLEMBFIN_";

function isSet(value) {
  return value !== undefined && String(value).trim() !== "";
}

export function brandEnv(name, env = process.env) {
  const value = env[`${PREFIX}${name}`];
  return isSet(value) ? value : env[`${LEGACY_PREFIX}${name}`];
}

// The app name announced to Plex, Emby and Jellyfin. A device registered before
// the rename is named "Plembfin" and keeps announcing that, so its entry in the
// server's device list is left alone; one registered since is named "Plekt".
export function providerAppName(device) {
  const name = String(device?.deviceName || "").trim();
  return !name || /^plembfin\b/i.test(name) ? "Plembfin" : "Plekt";
}

// Old names that are actually supplying a value (no new-name equivalent set).
export function legacyEnvNamesInUse(env = process.env) {
  return Object.keys(env)
    .filter((key) => key.startsWith(LEGACY_PREFIX) && isSet(env[key]))
    .filter((key) => !isSet(env[`${PREFIX}${key.slice(LEGACY_PREFIX.length)}`]))
    .sort();
}

export function logLegacyEnvNames(env = process.env, log = console.log) {
  const names = legacyEnvNamesInUse(env);
  if (!names.length) return names;
  const renamed = names.map((name) => `${PREFIX}${name.slice(LEGACY_PREFIX.length)}`);
  log(`[config] Using environment variables under their old names: ${names.join(", ")}. They keep working; the current names are ${renamed.join(", ")}.`);
  return names;
}
