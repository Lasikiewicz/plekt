import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(websiteRoot, "public", "assets");
const outputPath = path.join(assetsRoot, "og-card.png");
const logoPath = path.resolve(websiteRoot, "..", "public", "plekt_header_logo_dark.png");
const dashboardPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "og-card-dashboard-capture.png");
const canvas = Buffer.from(`<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#05080c"/>
  <text x="60" y="132" fill="#f8fafc" font-family="Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="-1.1">Self-hosted watch-state sync for Plex, Jellyfin and Emby</text>
</svg>`);

const screenshotWidth = 1120;
const screenshot = await sharp(dashboardPath)
  .extract({ left: 198, top: 0, width: 1198, height: 470 })
  .resize({ width: screenshotWidth })
  .png()
  .toBuffer();
const screenshotHeight = await sharp(screenshot).metadata().then(({ height }) => height);
const screenshotMask = Buffer.from(`<svg width="${screenshotWidth}" height="${screenshotHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="${screenshotWidth}" height="${screenshotHeight}" rx="8" fill="white"/></svg>`);
const roundedScreenshot = await sharp(screenshot)
  .composite([{ input: screenshotMask, blend: "dest-in" }])
  .png()
  .toBuffer();
const logo = await sharp(logoPath).resize({ width: 250 }).png().toBuffer();

await sharp(canvas)
  .composite([
    { input: logo, left: 60, top: 25 },
    { input: roundedScreenshot, left: 40, top: 174 },
  ])
  .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 80, effort: 10 })
  .toFile(outputPath);

console.log(`Created ${path.relative(websiteRoot, outputPath)} (1200x630)`);
