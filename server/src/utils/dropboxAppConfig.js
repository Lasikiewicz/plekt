// Public App Key for the bundled Plekt Dropbox backup app (PKCE, no client secret).
// Operators can override it with PLEKT_DROPBOX_APP_KEY (or DROPBOX_APP_KEY) or
// per-destination custom app settings in the UI.
import { brandEnv } from "./brandEnv.js";

export const BUNDLED_DROPBOX_APP_KEY = "lfdkjvsl7z8mcss";

export function resolveDropboxAppKey(env = process.env) {
  const override = String(brandEnv("DROPBOX_APP_KEY", env) || env.DROPBOX_APP_KEY || "").trim();
  return override || BUNDLED_DROPBOX_APP_KEY;
}
