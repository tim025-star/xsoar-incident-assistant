import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { DEFAULT_SETTINGS, FIELD_LABELS, resolveSettings } from "./domain.js";
import { DEFAULT_OLLAMA_MODEL, localAiSettingsSchema } from "./local-ai.js";

const localAppDataDirectory = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const APP_DATA_DIRECTORY = path.join(localAppDataDirectory, "XSOAR Incident Assistant");
const CONFIG_PATH = path.join(APP_DATA_DIRECTORY, "config.json");

export const DEFAULT_APP_CONFIG = Object.freeze({
  configVersion: 11,
  xsoar: DEFAULT_SETTINGS,
  localAi: { enabled: false, model: DEFAULT_OLLAMA_MODEL }
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
const retiredFieldLabels = ["customerShortName", "owner", "phase", "description"];
const legacyFieldLabelsSchema = z.object({
  ...fieldLabelsShape,
  ...Object.fromEntries(retiredFieldLabels.map((key) => [key, z.array(z.string())]))
}).partial().strict();

const xsoarShape = {
  configVersion: z.number().int(),
  allowedOrigin: z.string(),
  incidentUrlPattern: z.string(),
  incidentPathTemplate: z.string(),
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
const xsoarInputSchema = z.object({ ...xsoarShape, fieldLabels: legacyFieldLabelsSchema }).partial().strict();

// Accept known legacy settings so existing installations migrate cleanly.
// Browser modes, profile settings, and retired field labels are discarded.
const legacySessionSchema = z.object({
  mode: z.enum(["current", "managed", "diagnostics", "cdp"]).optional(),
  browser: z.enum(["edge", "chrome"]).optional(),
  activationHotkey: z.union([
    z.string(),
    z.object({ label: z.string(), modifiers: z.number().int(), code: z.string() }).strict()
  ]).optional(),
  profileDirectory: z.string().optional()
}).strict();

export const appConfigInputSchema = z.object({
  configVersion: z.number().int().min(3).max(11).optional(),
  session: legacySessionSchema.optional(),
  xsoar: xsoarInputSchema.optional(),
  localAi: localAiSettingsSchema.optional()
}).strict().superRefine((input, context) => {
  const isLegacy = input.configVersion === undefined
    ? input.session !== undefined
    : input.configVersion < 9;
  if (isLegacy) return;
  if (input.session !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["session"],
      message: "Current configurations must not contain retired browser settings."
    });
  }
  for (const key of retiredFieldLabels) {
    if (!Object.hasOwn(input.xsoar?.fieldLabels || {}, key)) continue;
    context.addIssue({
      code: "custom",
      path: ["xsoar", "fieldLabels", key],
      message: `Unsupported field label: ${key}.`
    });
  }
});

export const resolvedAppConfigSchema = z.object({
  configVersion: z.literal(11),
  xsoar: z.object({
    ...xsoarShape,
    configVersion: z.literal(3),
    fieldLabels: z.object(fieldLabelsShape).strict(),
    template: z.object(templateShape).strict()
  }).strict(),
  localAi: localAiSettingsSchema
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
  const suppliedFieldLabels = { ...(input.xsoar?.fieldLabels || {}) };
  for (const key of retiredFieldLabels) delete suppliedFieldLabels[key];
  const merged = {
    configVersion: 11,
    xsoar: {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(input.xsoar || {}),
      fieldLabels: { ...structuredClone(DEFAULT_SETTINGS.fieldLabels), ...suppliedFieldLabels },
      template: { ...DEFAULT_SETTINGS.template, ...(input.xsoar?.template || {}) }
    },
    localAi: { ...DEFAULT_APP_CONFIG.localAi, ...(input.localAi || {}) }
  };
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
