import fs from "node:fs";

// The Plekt and Plembfin Docker images are the same build. The legacy tags are
// pushed from a thin layer that sets PLEKT_LEGACY_IMAGE=1, which is the only
// signal that an install is running the retiring image. Unset (the Plekt image,
// bare metal, local development) means no notice anywhere.
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

// The advertised six months after the v2.0.0 rebrand release (11 October 2026).
// The old names keep receiving updates until at least this date.
export const LEGACY_IMAGE_MIN_SUPPORT_DATE = "2027-04-11";

export function isLegacyImage(env = process.env) {
  return TRUE_VALUES.has(String(env.PLEKT_LEGACY_IMAGE || "").trim().toLowerCase());
}

function packageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version || "");
  } catch {
    return "";
  }
}

export function legacyImageNotice(env = process.env) {
  if (!isLegacyImage(env)) return { legacyImage: false };
  return {
    legacyImage: true,
    version: packageVersion(),
    newImages: ["ghcr.io/lasikiewicz/plekt", "plembfin/plekt"],
    supportedUntil: LEGACY_IMAGE_MIN_SUPPORT_DATE,
    // The plekt.net guide. It is live only after a website publish; until then this
    // address does not resolve (the README "Formerly Plembfin" section covers the same swap).
    switchUrl: "https://plekt.net/docs/upgrading-from-plembfin/#switching-from-the-plembfin-docker-image",
  };
}
