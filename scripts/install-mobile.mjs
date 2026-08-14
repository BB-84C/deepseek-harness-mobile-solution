#!/usr/bin/env node
/**
 * dsh mobile installer — installs the dsh-mobile plugin packages into the
 * `mobile` and `web` dsh profiles, using the verified junction + relative
 * link: pattern (see packages/dev/hello-bundle/README.md for the why).
 *
 * Usage:
 *   node scripts/install-mobile.mjs            install both profiles
 *   node scripts/install-mobile.mjs --uninstall
 *
 * Works on Windows (junction), macOS and Linux (symlink). Never touches the
 * shipped dsh installation or the shipped presets; all state lives in the
 * profiles under $DSH_HOME and in $DSH_HOME/mobile.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILES_DIR = join(DSH_HOME, "profiles");

/** profile name -> plugin packages (repo-relative dirs under packages/) */
const PROFILE_PACKAGES = {
  mobile: ["dsh-mobile-cli"],
  web: ["dsh-mobile-server"],
};

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
const BASE_BUNDLES = ["@deepseek-ai/dsh-base"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Initialize a profile directory exactly like dsh's own initProfile does. */
function initProfile(dir, name) {
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) {
    writeJson(manifestPath, {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...BASE_BUNDLES] } },
    });
  }
  const patchPath = join(dir, "cordis.patch.yml");
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);
  const workspacePath = join(dir, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE);
  return manifestPath;
}

/** Remove a junction/symlink only (never a real directory). */
function removeLink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) rmSync(path, { recursive: false, force: true });
  } catch {
    /* absent — fine */
  }
}

/** Ensure <profileDir>/vendor-packages links to the repo's packages/ dir. */
function ensureVendorLink(profileDir) {
  const linkPath = join(profileDir, "vendor-packages");
  const target = join(REPO_ROOT, "packages");
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      console.error(`installer: refusing to touch ${linkPath} — it exists and is not a link`);
      process.exit(1);
    }
    return; // exists as a link; keep it
  } catch {
    /* absent — create */
  }
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function packageNamesFor(profile) {
  return (PROFILE_PACKAGES[profile] ?? []).map((dir) => `@bb-84c/${dir}`);
}

function installProfile(name) {
  const dir = join(PROFILES_DIR, name);
  const manifestPath = initProfile(dir, name);
  ensureVendorLink(dir);
  const manifest = readJson(manifestPath);
  const dependencies = manifest.dependencies ?? {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  for (const pkgDir of PROFILE_PACKAGES[name] ?? []) {
    const pkgName = `@bb-84c/${pkgDir}`;
    if (!existsSync(join(REPO_ROOT, "packages", pkgDir, "package.json"))) {
      console.warn(`installer: packages/${pkgDir} not present in the checkout — skipped (re-run once it lands)`);
      continue;
    }
    dependencies[pkgName] = `link:./vendor-packages/${pkgDir}`;
    if (!bundles.includes(pkgName)) bundles.push(pkgName);
  }
  manifest.dependencies = dependencies;
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } };
  writeJson(manifestPath, manifest);
  console.log(`installer: ${name} profile -> bundles ${bundles.join(", ")}`);
}

function uninstallProfile(name) {
  const dir = join(PROFILES_DIR, name);
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath);
  const ours = new Set(packageNamesFor(name));
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([key]) => !ours.has(key)));
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((bundle) => !ours.has(bundle));
  manifest.dependencies = dependencies;
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } };
  writeJson(manifestPath, manifest);
  for (const pkgName of ours) removeLink(join(dir, "node_modules", ...pkgName.split("/")));
  console.log(`installer: ${name} profile -> removed ${[...ours].join(", ")}`);
}

const uninstall = process.argv.includes("--uninstall");
if (uninstall) {
  for (const name of Object.keys(PROFILE_PACKAGES)) uninstallProfile(name);
  console.log("uninstall complete — data under $DSH_HOME/mobile was kept");
} else {
  mkdirSync(DSH_HOME, { recursive: true });
  for (const name of Object.keys(PROFILE_PACKAGES)) installProfile(name);
  console.log("install complete.");
  console.log("try: dsh --profile mobile doctor");
}
