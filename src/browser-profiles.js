import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const BROWSERS = Object.freeze({
  edge: {
    name: "Microsoft Edge",
    userDataParts: ["Microsoft", "Edge", "User Data"],
    legacyProfileParts: ["Microsoft", "Edge", "TSOC-Copilot"]
  },
  chrome: {
    name: "Google Chrome",
    userDataParts: ["Google", "Chrome", "User Data"],
    legacyProfileParts: ["Google", "Chrome", "TSOC-Copilot"]
  }
});
const IMPORTED_PROFILE_ENTRIES = Object.freeze([
  "Network",
  "Cookies",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "WebStorage",
  "Preferences",
  "Secure Preferences"
]);
const PROFILE_DIRECTORY_PATTERN = /^(?:Default|Profile [1-9]\d*)$/;

export const LOCAL_APP_DATA_DIRECTORY = process.env.LOCALAPPDATA
  || path.join(os.homedir(), "AppData", "Local");
export const APP_DATA_DIRECTORY = path.join(LOCAL_APP_DATA_DIRECTORY, "XSOAR Incident Assistant");

export const browserProfileSchema = z.object({
  id: z.string(),
  browser: z.enum(["edge", "chrome"]),
  browserName: z.string(),
  directoryName: z.string(),
  name: z.string(),
  isDefault: z.boolean()
}).strict();

export const browserProfileImportSchema = z.object({
  id: z.string().min(1).max(128)
}).strict();

function localAppDataDirectory() {
  return LOCAL_APP_DATA_DIRECTORY;
}

function userDataDirectory(browser, localAppData) {
  return path.join(localAppData, ...BROWSERS[browser].userDataParts);
}

export function standardUserDataDirectoryForBrowser(browser, { localAppData = localAppDataDirectory() } = {}) {
  const definition = BROWSERS[browser];
  if (!definition) throw new Error("Browser must be edge or chrome.");
  return userDataDirectory(browser, path.resolve(localAppData));
}

export function legacyProfileDirectoryForBrowser(browser, { localAppData = localAppDataDirectory() } = {}) {
  const definition = BROWSERS[browser];
  if (!definition) throw new Error("Browser must be edge or chrome.");
  return path.join(path.resolve(localAppData), ...definition.legacyProfileParts);
}

function isProfileDirectoryName(value) {
  return PROFILE_DIRECTORY_PATTERN.test(value);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function isRealDirectory(directoryPath) {
  try {
    const entry = await lstat(directoryPath);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

export async function prepareBrowserProfileDirectory(profileDirectory) {
  const resolvedProfile = path.resolve(profileDirectory);
  await mkdir(resolvedProfile, { recursive: true });
  const [profile, entry, children] = await Promise.all([
    realpath(resolvedProfile),
    lstat(resolvedProfile),
    readdir(resolvedProfile, { withFileTypes: true })
  ]);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("The browser profile must be a real directory, not a link or file.");
  }
  if (children.some((child) => ["lockfile", "SingletonLock"].includes(child.name))) {
    throw new Error("Close the browser that is using this profile before opening it in the assistant.");
  }
  const looksLikeChromium = children.length === 0
    || children.some((child) => child.name === "Local State")
    || children.some((child) => child.isDirectory() && isProfileDirectoryName(child.name));
  if (!looksLikeChromium) {
    throw new Error("The selected custom path is not a Chromium user-data directory.");
  }
  return profile;
}

async function detectedProfilesForBrowser(browser, localAppData) {
  const root = userDataDirectory(browser, localAppData);
  if (!await isRealDirectory(root)) return [];
  const localState = await readJson(path.join(root, "Local State"));
  const infoCache = localState?.profile?.info_cache && typeof localState.profile.info_cache === "object"
    ? localState.profile.info_cache
    : {};
  const directoryNames = new Set(Object.keys(infoCache).filter(isProfileDirectoryName));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && isProfileDirectoryName(entry.name)) {
      directoryNames.add(entry.name);
    }
  }
  const profiles = [];
  for (const directoryName of directoryNames) {
    if (!await isRealDirectory(path.join(root, directoryName))) continue;
    const configuredName = infoCache[directoryName]?.name;
    profiles.push({
      id: `${browser}:${directoryName}`,
      browser,
      browserName: BROWSERS[browser].name,
      directoryName,
      name: typeof configuredName === "string" && configuredName.trim() ? configuredName.trim() : directoryName,
      isDefault: directoryName === "Default"
    });
  }
  return profiles.sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
    || left.directoryName.localeCompare(right.directoryName, undefined, { numeric: true }));
}

export async function detectBrowserProfiles({ localAppData = localAppDataDirectory() } = {}) {
  const groups = await Promise.all(Object.keys(BROWSERS)
    .map((browser) => detectedProfilesForBrowser(browser, path.resolve(localAppData))));
  return groups.flat();
}

function assertInside(root, candidate, message) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

async function copyProfileEntry(source, destination) {
  try {
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      filter: async (candidate) => !(await lstat(candidate)).isSymbolicLink()
    });
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

function importedDirectoryName(profile) {
  return `imported-${profile.browser}-${profile.directoryName.toLowerCase().replaceAll(" ", "-")}`;
}

async function existingImportedDirectory(appDataDirectory, destination) {
  if (!await isRealDirectory(destination)) return null;
  const [realRoot, realDestination] = await Promise.all([realpath(appDataDirectory), realpath(destination)]);
  assertInside(realRoot, realDestination, "The imported profile must stay inside the assistant application-data directory.");
  return realDestination;
}

export async function importBrowserProfile(id, {
  localAppData = localAppDataDirectory(),
  appDataDirectory = APP_DATA_DIRECTORY
} = {}) {
  const profiles = await detectBrowserProfiles({ localAppData });
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error("Select an available browser profile before importing it.");

  const resolvedAppData = path.resolve(appDataDirectory);
  const sourceRoot = userDataDirectory(profile.browser, path.resolve(localAppData));
  const sourceProfile = path.join(sourceRoot, profile.directoryName);
  const destination = path.join(resolvedAppData, importedDirectoryName(profile));
  assertInside(resolvedAppData, destination, "The imported profile must stay inside the assistant application-data directory.");
  await mkdir(resolvedAppData, { recursive: true });

  const existing = await existingImportedDirectory(resolvedAppData, destination);
  if (existing) return { browser: profile.browser, profileDirectory: existing, reused: true };

  const browserIsOpen = (await Promise.all([
    pathExists(path.join(sourceRoot, "lockfile")),
    pathExists(path.join(sourceRoot, "SingletonLock"))
  ])).some(Boolean);
  if (browserIsOpen) throw new Error(`Close ${profile.browserName} completely before importing this profile.`);

  const localState = await readJson(path.join(sourceRoot, "Local State"));
  if (!localState) throw new Error(`Close ${profile.browserName}, then try importing the profile again.`);
  const importedLocalState = {
    os_crypt: structuredClone(localState.os_crypt || {}),
    profile: {
      info_cache: { Default: { name: profile.name } },
      last_active_profiles: ["Default"],
      last_used: "Default"
    }
  };

  const staging = path.join(resolvedAppData, `.profile-import-${randomBytes(12).toString("hex")}`);
  assertInside(resolvedAppData, staging, "The profile import staging directory is invalid.");
  try {
    await mkdir(path.join(staging, "Default"), { recursive: true });
    let copied = 0;
    for (const entry of IMPORTED_PROFILE_ENTRIES) {
      if (await copyProfileEntry(path.join(sourceProfile, entry), path.join(staging, "Default", entry))) copied += 1;
    }
    if (!copied) throw new Error("The selected browser profile did not contain importable session data.");
    await Promise.all([
      writeFile(path.join(staging, "Local State"), `${JSON.stringify(importedLocalState)}\n`, { mode: 0o600 }),
      writeFile(path.join(staging, "First Run"), "", { mode: 0o600 })
    ]);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (["EBUSY", "EPERM", "EACCES"].includes(error?.code)) {
      throw new Error(`Close ${profile.browserName} completely, then try importing the profile again.`);
    }
    throw error;
  }
  return { browser: profile.browser, profileDirectory: destination, reused: false };
}
