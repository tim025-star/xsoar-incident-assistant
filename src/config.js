import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  APP_DATA_DIRECTORY,
  legacyProfileDirectoryForBrowser,
  LOCAL_APP_DATA_DIRECTORY
} from "./browser-profiles.js";
import { DEFAULT_SETTINGS, FIELD_LABELS, resolveSettings } from "./domain.js";
import { DEFAULT_ACTIVATION_HOTKEY, activationHotkeySpec } from "./hotkey.js";

export { APP_DATA_DIRECTORY };
export const CONFIG_PATH = path.join(APP_DATA_DIRECTORY, "config.json");

export const DEFAULT_APP_CONFIG = Object.freeze({
  configVersion: 6,
  session: {
    mode: "managed",
    browser: "chrome",
    activationHotkey: { ...DEFAULT_ACTIVATION_HOTKEY },
    profileDirectory: legacyProfileDirectoryForBrowser("chrome")
  },
  xsoar: DEFAULT_SETTINGS
});

const templateShape = {
  greeting: z.string(),
  recommendationsHeading: z.string(),
  contactText: z.string(),
  signOff: z.string(),
  analystName: z.string(),
  analystTitle: z.string()
};
const templateSchema = z.object(templateShape).partial().strict();

const fieldLabelsShape = Object.fromEntries(
  Object.keys(FIELD_LABELS).map((key) => [key, z.array(z.string())])
);
const fieldLabelsSchema = z.object(fieldLabelsShape).partial().strict();

const xsoarShape = {
  configVersion: z.number().int(),
  allowedOrigin: z.string(),
  incidentUrlPattern: z.string(),
  incidentsPath: z.string(),
  searchQueryParameter: z.string(),
  lookbackQuery: z.string(),
  maxHistoricalIncidents: z.number().int(),
  pageReadyTimeoutMs: z.number().int(),
  incidentInfoTabLabel: z.string(),
  investigationTabLabel: z.string(),
  historicalSummaryLabels: z.array(z.string()),
  historicalRecommendationLabels: z.array(z.string()),
  fieldLabels: fieldLabelsSchema,
  template: templateSchema
};
const xsoarSchema = z.object(xsoarShape).partial().strict();
const activationHotkeySchema = z.object({
  label: z.string(),
  modifiers: z.number().int(),
  code: z.string()
}).strict();

export const appConfigInputSchema = z.object({
  configVersion: z.number().int().optional(),
  session: z.object({
    mode: z.enum(["managed", "diagnostics", "cdp"]),
    browser: z.enum(["edge", "chrome"]),
    activationHotkey: z.union([z.string(), activationHotkeySchema]),
    profileDirectory: z.string()
  }).partial().strict().optional(),
  xsoar: xsoarSchema.optional()
}).strict();

export const resolvedAppConfigSchema = z.object({
  configVersion: z.literal(6),
  session: z.object({
    mode: z.enum(["managed", "diagnostics"]),
    browser: z.enum(["edge", "chrome"]),
    activationHotkey: activationHotkeySchema,
    profileDirectory: z.string()
  }).strict(),
  xsoar: z.object({
    ...xsoarShape,
    configVersion: z.literal(2),
    fieldLabels: z.object(fieldLabelsShape).strict(),
    template: z.object(templateShape).strict()
  }).strict()
}).strict();

function parseConfigInput(input) {
  const parsed = appConfigInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const location = issue.path.length ? `${issue.path.join(".")}: ` : "";
  throw new Error(`${location}${issue.message}`);
}

export function resolveAppConfig(input = {}, { requireTenant = true } = {}) {
  input = parseConfigInput(input);
  const merged = structuredClone(DEFAULT_APP_CONFIG);
  Object.assign(merged, input);
  merged.session = { ...DEFAULT_APP_CONFIG.session, ...(input.session || {}) };
  merged.xsoar = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...(input.xsoar || {}),
    fieldLabels: { ...structuredClone(DEFAULT_SETTINGS.fieldLabels), ...(input.xsoar?.fieldLabels || {}) },
    template: { ...DEFAULT_SETTINGS.template, ...(input.xsoar?.template || {}) }
  };
  merged.configVersion = 6;

  // Version 3 stored debug-mode sessions in a sibling profile. Keep that
  // authenticated profile while migrating away from its TCP control endpoint.
  if (merged.session.mode === "cdp" && (input.configVersion === undefined || input.configVersion === 3)) {
    merged.session.mode = "diagnostics";
    if (!input.session?.profileDirectory) {
      merged.session.profileDirectory = path.join(APP_DATA_DIRECTORY, "browser-profile-debug");
    } else if (!merged.session.profileDirectory.endsWith("-debug")) {
      merged.session.profileDirectory += "-debug";
    }
  }

  if (!["managed", "diagnostics"].includes(merged.session.mode)) {
    throw new Error("Session mode must be managed or diagnostics.");
  }
  if (!["edge", "chrome"].includes(merged.session.browser)) {
    throw new Error("Browser must be edge or chrome.");
  }
  merged.session.activationHotkey = activationHotkeySpec(merged.session.activationHotkey);
  if (typeof merged.session.profileDirectory !== "string" || !path.isAbsolute(merged.session.profileDirectory)) {
    throw new Error("The dedicated profile directory must be an absolute path.");
  }
  const resolvedProfile = path.resolve(merged.session.profileDirectory);
  const defaultChromeData = path.resolve(LOCAL_APP_DATA_DIRECTORY, "Google", "Chrome", "User Data");
  const defaultEdgeData = path.resolve(LOCAL_APP_DATA_DIRECTORY, "Microsoft", "Edge", "User Data");
  if ([defaultChromeData, defaultEdgeData].some((candidate) => {
    const relative = path.relative(candidate, resolvedProfile);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  })) {
    throw new Error("The normal Chrome or Edge user-data directory cannot be used for automation.");
  }
  const protectedRoots = [path.parse(resolvedProfile).root, os.homedir(), LOCAL_APP_DATA_DIRECTORY]
    .map((candidate) => path.resolve(candidate));
  if (protectedRoots.some((candidate) => path.relative(candidate, resolvedProfile) === "")) {
    throw new Error("Choose a dedicated Chromium profile directory, not a filesystem or Windows data root.");
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

export async function saveConfig(input, { requireTenant = true } = {}) {
  const config = resolveAppConfig(input, { requireTenant });
  await mkdir(APP_DATA_DIRECTORY, { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  return config;
}
