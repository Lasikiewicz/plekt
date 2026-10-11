#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function fail(message) {
  console.error(`Windows package build failed: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

function copyApplicationPublic(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      if (!relative) return true;
      return relative.split(path.sep)[0].toLowerCase() !== "demo-assets";
    },
  });
}

function safeVersion(value) {
  const match = String(value || "").trim().match(/^\d+(?:\.\d+){0,3}/);
  if (!match) throw new Error(`Invalid application version: ${value}`);
  return match[0];
}

function readBuildMetadata(channel) {
  const manifestName = channel === "release" ? "changelog.json" : `changelog.${channel}.json`;
  const manifestPath = path.join(root, manifestName);
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${manifestName}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = safeVersion(channel === "alpha" ? manifest.baseVersion : manifest.version);
  const build = channel === "release" ? "" : String(manifest.build || 0);
  const displayVersion = channel === "release"
    ? version
    : `${version} ${channel} build ${build}`;

  return { channel, version, build, displayVersion, manifestName };
}

async function writeIcon(source, destination) {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default || sharpModule;
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(async (size) => ({
    size,
    data: await sharp(source)
      .resize(size, size, { fit: "cover" })
      .png()
      .toBuffer(),
  })));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  for (const [index, image] of images.entries()) {
    const entryOffset = index * 16;
    const dimension = image.size === 256 ? 0 : image.size;
    directory.writeUInt8(dimension, entryOffset);
    directory.writeUInt8(dimension, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.data.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += image.data.length;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.concat([header, directory, ...images.map((image) => image.data)]));
}

function resolveCsc() {
  const explicit = String(process.env.CSC_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error("Microsoft C# compiler was not found. Set CSC_PATH or build on Windows with .NET Framework installed.");
}

function compileTrayHelper(destination, iconPath) {
  if (process.platform !== "win32") {
    throw new Error("The Windows package must be built on Windows so the tray helper can be compiled.");
  }

  const csc = resolveCsc();
  const source = path.join(root, "packaging", "windows", "tray", "PlektTray.cs");
  const references = [
    "System.dll",
    "System.Core.dll",
    "System.Drawing.dll",
    "System.Net.Http.dll",
    "System.ServiceProcess.dll",
    "System.Windows.Forms.dll",
  ];

  run(csc, [
    "/nologo",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    `/out:${destination}`,
    `/win32icon:${iconPath}`,
    ...references.map((reference) => `/reference:${reference}`),
    source,
  ]);
}

async function main() {
  if (process.platform !== "win32") {
    fail("run this script on a Windows runner or Windows development machine");
  }

  const channel = option("--channel", process.env.BUILD_CHANNEL || "release").toLowerCase();
  if (!["release", "alpha", "develop"].includes(channel)) {
    fail(`unsupported channel "${channel}" (expected release, alpha, or develop)`);
  }

  const winswOption = option("--winsw", "");
  if (!winswOption) {
    fail("WinSW x64 executable not found; pass it with --winsw <path>");
  }
  const winswPath = path.resolve(winswOption);
  if (!fs.existsSync(winswPath)) {
    fail(`WinSW x64 executable not found at ${winswPath}`);
  }

  const outputDir = path.resolve(option("--output", path.join(root, "dist", "windows")));
  const appDir = path.join(outputDir, "app");
  const relativeOutput = path.relative(path.join(root, "dist"), outputDir);
  if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
    fail("output must be a child directory of this checkout\'s dist directory");
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  const metadata = readBuildMetadata(channel);
  const iconPath = path.join(appDir, "plekt.ico");
  await writeIcon(path.join(root, "public", "favicon.png"), iconPath);

  copy(path.join(root, "server"), path.join(appDir, "server"));
  // The public website/demo bundle is deployed separately and can be hundreds of
  // megabytes. The Windows app only needs the application UI and its icons.
  copyApplicationPublic(path.join(root, "public"), path.join(appDir, "public"));
  // Local installer rebuilds can share a release version while their UI differs.
  // Stamp only the packaged copy so immutable browser caches cannot hide fixes.
  const assetVersion = `${metadata.version}-windows-${randomUUID()}`;
  run(process.execPath, [path.join(root, "scripts", "asset-versions.js"),
    "--write", `--version=${assetVersion}`, `--public-dir=${path.join(appDir, "public")}`]);
  copy(path.join(root, "node_modules"), path.join(appDir, "node_modules"));
  copy(path.join(root, "package.json"), path.join(appDir, "package.json"));
  copy(path.join(root, "package-lock.json"), path.join(appDir, "package-lock.json"));
  copy(path.join(root, "LICENSE.md"), path.join(appDir, "LICENSE.md"));
  copy(path.join(root, "README.md"), path.join(appDir, "README.md"));
  for (const manifestName of ["changelog.json", "changelog.alpha.json", "changelog.develop.json"]) {
    const manifestPath = path.join(root, manifestName);
    if (fs.existsSync(manifestPath)) copy(manifestPath, path.join(appDir, manifestName));
  }

  copy(
    path.join(root, "packaging", "windows", "PlektService.xml"),
    path.join(appDir, "PlektService.xml"),
  );
  copy(
    path.join(root, "packaging", "windows", "THIRD-PARTY-NOTICES.txt"),
    path.join(appDir, "THIRD-PARTY-NOTICES.txt"),
  );
  copy(winswPath, path.join(appDir, "PlektService.exe"));
  copy(process.execPath, path.join(appDir, "node.exe"));
  compileTrayHelper(path.join(appDir, "PlektTray.exe"), iconPath);

  const buildInfo = {
    ...metadata,
    assetVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    commit: String(process.env.GITHUB_SHA || "").trim() || null,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(appDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

  const archiveDir = path.join(outputDir, "metadata");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

  console.log(`Prepared Plekt ${metadata.displayVersion} in ${appDir}`);
}

main().catch((error) => {
  fail(error?.stack || error?.message || error);
});
