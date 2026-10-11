// The hosted demo is deliberately isolated from normal Plembfin behaviour.
// Keep this check server-side so demo fixtures can be projected without
// pretending that a real media app or user account is connected.
import { brandEnv } from "./brandEnv.js";

export function isDemoMode() {
  return String(brandEnv("DEMO_MODE") || "").trim() === "1";
}
