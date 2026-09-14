import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, resolveSettings } from "./domain.js";

export const APP_DATA_DIRECTORY = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "XSOAR Incident Assistant"
);
export const CONFIG_PATH = path.join(APP_DATA_DIRECTORY, "config.json");

export const DEFAULT_APP_CONFIG = Object.freeze({
  configVersion: 3,
  session: {
    mode: "managed",
    browser: "edge",
    profileDirectory: path.join(APP_DATA_DIRECTORY, "browser-profile")
  },
  xsoar: DEFAULT_SETTINGS
});

export function resolveAppConfig(input = {}, { requireTenant = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Configuration must be an object.");
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_APP_CONFIG, key)) throw new Error(`Unsupported configuration field: ${key}.`);
  }
  if (input.session !== undefined && (!input.session || typeof input.session !== "object" || Array.isArray(input.session))) {
    throw new Error("session must be an object.");
  }
  if (input.xsoar !== undefined && (!input.xsoar || typeof input.xsoar !== "object" || Array.isArray(input.xsoar))) {
    throw new Error("xsoar must be an object.");
  }
  for (const key of Object.keys(input.session || {})) {
    if (!Object.hasOwn(DEFAULT_APP_CONFIG.session, key)) throw new Error(`Unsupported session field: ${key}.`);
  }
  const merged = structuredClone(DEFAULT_APP_CONFIG);
  Object.assign(merged, input);
  merged.session = { ...DEFAULT_APP_CONFIG.session, ...(input.session || {}) };
  merged.xsoar = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...(input.xsoar || {}),
    fieldLabels: { ...structuredClone(DEFAULT_SETTINGS.fieldLabels), ...(input.xsoar?.fieldLabels || {}) },
    template: { ...DEFAULT_SETTINGS.template, ...(input.xsoar?.template || {}) }
  };
  merged.configVersion = 3;

  if (!["managed", "cdp"].includes(merged.session.mode)) {
    throw new Error("Session mode must be managed or cdp.");
  }
  if (!["edge", "chrome"].includes(merged.session.browser)) {
    throw new Error("Browser must be edge or chrome.");
  }
  if (typeof merged.session.profileDirectory !== "string" || !path.isAbsolute(merged.session.profileDirectory)) {
    throw new Error("The managed profile directory must be an absolute path.");
  }
  const resolvedProfile = path.resolve(merged.session.profileDirectory);
  const defaultChromeData = path.resolve(process.env.LOCALAPPDATA || "C:\\", "Google", "Chrome", "User Data");
  const defaultEdgeData = path.resolve(process.env.LOCALAPPDATA || "C:\\", "Microsoft", "Edge", "User Data");
  if ([defaultChromeData, defaultEdgeData].some((candidate) => {
    const relative = path.relative(candidate, resolvedProfile);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  })) {
    throw new Error("The normal Chrome or Edge user-data directory cannot be used for automation.");
  }
  const relativeToAppData = path.relative(path.resolve(APP_DATA_DIRECTORY), resolvedProfile);
  if (relativeToAppData.startsWith("..") || path.isAbsolute(relativeToAppData)) {
    throw new Error("The browser profile must stay inside the XSOAR Incident Assistant application-data directory.");
  }
  merged.session.profileDirectory = resolvedProfile;
  if (!requireTenant && !String(merged.xsoar.allowedOrigin || "").trim()) return merged;
  merged.xsoar = resolveSettings(merged.xsoar);
  return merged;
}

export async function loadConfig({ requireTenant = false } = {}) {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return resolveAppConfig(parsed, { requireTenant });
  } catch (error) {
    if (error?.code === "ENOENT") return resolveAppConfig({}, { requireTenant: false });
    throw error;
  }
}

export async function saveConfig(input) {
  const config = resolveAppConfig(input);
  await mkdir(APP_DATA_DIRECTORY, { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  return config;
}
