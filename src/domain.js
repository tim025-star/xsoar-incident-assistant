export const FIELD_LABELS = Object.freeze({
  customerName: ["Customer Name"],
  classification: ["Classification"],
  occurred: ["Occurred"],
  incidentOutcome: ["Incident Outcome"],
  closeNotes: ["Close Notes"],
  ruleName: ["Rule Name"],
  caseType: ["Type", "Case Type"],
  clientIp: ["Client IP"],
  clientHostname: ["Client Hostname", "Client Host Hostname"],
  clientUserName: ["Client User Name"],
  destinationIp: ["Destination IP"],
  deviceHostname: ["Device Hostname", "Device Host Hostname", "Device Name"],
  eventInfo: ["Event Info"],
  eventName: ["Event Name"],
  detectionUrl: ["Detection URL"],
  errorMessage: ["Error Message"],
  serviceMessage: ["Service Message"],
  sourceHostname: ["Source Hostname", "Source Host Hostname"],
  sourceIp: ["Source IP"],
  sourceUsername: ["Source Username"],
  descriptionLong: ["Description Long"]
});

export const DEFAULT_SETTINGS = Object.freeze({
  configVersion: 3,
  allowedOrigin: "",
  incidentUrlPattern: "\\/Custom\\/[^/]+\\/\\d+\\/?(?:[?#].*)?$",
  incidentPathTemplate: "/Custom/GenericLayout/{id}",
  incidentsPath: "/incidents",
  searchQueryParameter: "query",
  lookbackQuery: "created:>=\"7 days ago\"",
  maxHistoricalIncidents: 5,
  pageReadyTimeoutMs: 20000,
  incidentInfoTabLabel: "Incident Info",
  investigationTabLabel: "Investigation",
  historicalSummaryLabels: [],
  historicalRecommendationLabels: [],
  fieldLabels: FIELD_LABELS,
  template: {
    greeting: "Hello",
    recommendationsHeading: "Recommended Actions",
    contactText: "If you require more information or would like to discuss this incident, contact your security operations team and quote the incident ID.",
    signOff: "Kind regards,",
    analystName: "",
    analystTitle: "Security Analyst"
  }
});

export function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function isAvailable(value) {
  const normalized = cleanText(value);
  return Boolean(normalized && !/^(?:n\/?a|none|null|undefined|-)$/i.test(normalized));
}

export function firstAvailable(...values) {
  return values.map(cleanText).find(isAvailable) || "";
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(cleanText(value));
  } catch {
    throw new Error("XSOAR origin must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("XSOAR origin must use HTTPS and must not include a path, credentials, query, or fragment.");
  }
  return url.origin;
}

function validateLabels(value, name) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${name} must contain at least one non-empty label.`);
  }
  return value.map((entry) => entry.trim());
}

function validateOptionalLabels(value, name) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${name} must be an array of non-empty labels.`);
  }
  return value.map((entry) => entry.trim());
}

export function resolveSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Settings must be an object.");
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`Unsupported setting: ${key}.`);
  }
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings, input);
  settings.configVersion = 3;
  settings.allowedOrigin = normalizeOrigin(settings.allowedOrigin);

  for (const key of [
    "incidentUrlPattern",
    "incidentPathTemplate",
    "incidentsPath",
    "searchQueryParameter",
    "lookbackQuery",
    "incidentInfoTabLabel",
    "investigationTabLabel"
  ]) {
    if (typeof settings[key] !== "string" || !settings[key].trim()) {
      throw new Error(`${key} must be a non-empty string.`);
    }
    settings[key] = settings[key].trim();
  }
  try {
    new RegExp(settings.incidentUrlPattern);
  } catch {
    throw new Error("incidentUrlPattern must be a valid regular expression.");
  }
  if ((settings.incidentPathTemplate.match(/\{id\}/g) || []).length !== 1) {
    throw new Error("incidentPathTemplate must contain {id} exactly once.");
  }
  const templateUrl = new URL(settings.incidentPathTemplate.replace("{id}", "1"), settings.allowedOrigin);
  if (templateUrl.origin !== settings.allowedOrigin || templateUrl.username || templateUrl.password
    || templateUrl.search || templateUrl.hash || !settings.incidentPathTemplate.startsWith("/")) {
    throw new Error("incidentPathTemplate must be an absolute path on the configured XSOAR origin without a query or fragment.");
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(settings.searchQueryParameter)) {
    throw new Error("searchQueryParameter contains unsupported characters.");
  }
  const incidentsUrl = new URL(settings.incidentsPath, settings.allowedOrigin);
  if (incidentsUrl.origin !== settings.allowedOrigin) {
    throw new Error("incidentsPath must stay on the configured XSOAR origin.");
  }

  if (!Number.isInteger(settings.maxHistoricalIncidents)
    || settings.maxHistoricalIncidents < 1 || settings.maxHistoricalIncidents > 20) {
    throw new Error("maxHistoricalIncidents must be an integer from 1 to 20.");
  }
  if (!Number.isInteger(settings.pageReadyTimeoutMs)
    || settings.pageReadyTimeoutMs < 1000 || settings.pageReadyTimeoutMs > 120000) {
    throw new Error("pageReadyTimeoutMs must be an integer from 1000 to 120000.");
  }

  const suppliedFieldLabels = input.fieldLabels ?? {};
  if (!suppliedFieldLabels || typeof suppliedFieldLabels !== "object" || Array.isArray(suppliedFieldLabels)) {
    throw new Error("fieldLabels must be an object.");
  }
  settings.fieldLabels = structuredClone(FIELD_LABELS);
  for (const [key, labels] of Object.entries(suppliedFieldLabels)) {
    if (!Object.hasOwn(FIELD_LABELS, key)) throw new Error(`Unsupported field label: ${key}.`);
    settings.fieldLabels[key] = validateLabels(labels, `fieldLabels.${key}`);
  }
  settings.historicalSummaryLabels = validateOptionalLabels(
    settings.historicalSummaryLabels,
    "historicalSummaryLabels"
  );
  settings.historicalRecommendationLabels = validateOptionalLabels(
    settings.historicalRecommendationLabels,
    "historicalRecommendationLabels"
  );

  const suppliedTemplate = input.template ?? {};
  if (!suppliedTemplate || typeof suppliedTemplate !== "object" || Array.isArray(suppliedTemplate)) {
    throw new Error("template must be an object.");
  }
  for (const key of Object.keys(suppliedTemplate)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS.template, key)) throw new Error(`Unsupported template setting: ${key}.`);
  }
  settings.template = { ...DEFAULT_SETTINGS.template, ...suppliedTemplate };
  for (const [key, value] of Object.entries(settings.template)) {
    if (typeof value !== "string" || value.length > 1000) {
      throw new Error(`template.${key} must be a string no longer than 1000 characters.`);
    }
    settings.template[key] = value.trim();
  }
  if (!settings.template.greeting || !settings.template.recommendationsHeading) {
    throw new Error("The greeting and recommendations heading must not be empty.");
  }
  return settings;
}

export function assertTrustedUrl(value, settings, operation = "Navigation") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${operation} returned an invalid URL.`);
  }
  if (url.protocol !== "https:" || url.origin !== settings.allowedOrigin) {
    throw new Error(`${operation} left the configured XSOAR origin.`);
  }
  return url;
}

export function assertIncidentUrl(value, settings, operation = "Incident navigation") {
  const url = assertTrustedUrl(value, settings, operation);
  if (!new RegExp(settings.incidentUrlPattern).test(`${url.pathname}${url.search}${url.hash}`)) {
    throw new Error(`${operation} did not open a configured XSOAR incident path.`);
  }
  return url;
}

function escapeQueryValue(value) {
  return cleanText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildSearchQuery(ruleName, caseType, lookbackQuery = "") {
  if (!isAvailable(ruleName) || !isAvailable(caseType)) {
    throw new Error("The incident must expose both Rule Name and Type before a historical search can run.");
  }
  const parts = [
    `name:"${escapeQueryValue(ruleName)}"`,
    `type:"${escapeQueryValue(caseType)}"`
  ];
  if (cleanText(lookbackQuery)) parts.push(`(${cleanText(lookbackQuery)})`);
  return parts.join(" and ");
}

export function buildIncidentSearchUrl(settings, query) {
  const url = new URL(settings.incidentsPath, settings.allowedOrigin);
  if (url.origin !== settings.allowedOrigin) {
    throw new Error("The incident search URL left the configured XSOAR origin.");
  }
  url.searchParams.set(settings.searchQueryParameter, cleanText(query));
  return url.toString();
}

export function assertSearchUrl(value, settings, expectedQuery) {
  const url = assertTrustedUrl(value, settings, "Incident search");
  const configuredUrl = new URL(settings.incidentsPath, settings.allowedOrigin);
  const normalizePath = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalizePath(url.pathname) !== normalizePath(configuredUrl.pathname)) {
    throw new Error("XSOAR did not retain the configured incidents page path.");
  }
  const actualQuery = cleanText(url.searchParams.get(settings.searchQueryParameter));
  if (actualQuery !== cleanText(expectedQuery)) {
    throw new Error("XSOAR did not retain the expected query in the page URL.");
  }
  return url;
}

export function buildHistoricalIncidentUrl(currentIncidentUrl, ticketId, settings) {
  const source = assertIncidentUrl(currentIncidentUrl, settings, "Historical URL construction");
  if (!/^\d+$/.test(String(ticketId))) throw new Error("Historical incident ID must be numeric.");
  const replaced = source.pathname.replace(/\/\d+\/?$/, `/${ticketId}`);
  if (replaced === source.pathname) throw new Error("The current incident URL does not end with a numeric ID.");
  source.pathname = replaced;
  source.search = "";
  source.hash = "";
  return assertIncidentUrl(source.toString(), settings, "Historical URL construction").toString();
}

export function buildIncidentUrlFromId(ticketId, settings) {
  if (!/^\d+$/.test(String(ticketId))) throw new Error("Incident ID must be numeric.");
  const url = new URL(settings.incidentPathTemplate.replace("{id}", String(ticketId)), settings.allowedOrigin);
  return assertIncidentUrl(url.toString(), settings, "Requested incident navigation").toString();
}

export function mergeIncidentDetails(...details) {
  const merged = {};
  for (const detail of details.filter(Boolean)) {
    for (const [key, value] of Object.entries(detail)) {
      if (key === "tabUrls") continue;
      if (!isAvailable(merged[key]) && isAvailable(value)) merged[key] = cleanText(value);
    }
  }
  return merged;
}

function selectHistoricalRecommendation(item = {}) {
  return firstAvailable(
    item.historicalRecommendations,
    item.closeNotes,
    item.incidentOutcome,
    item.historicalSummary,
    item.descriptionLong
  );
}

export function buildDraft(output, templateInput = {}, enrichment = {}) {
  const template = { ...DEFAULT_SETTINGS.template, ...templateInput };
  const historical = (output.historical || []).filter((item) => item && !item.error);
  const pastRatings = historical.map((item) => cleanText(item.classification)).filter(isAvailable);
  const pastRatingLine = pastRatings.length ? `Past rating: ${pastRatings.join(", ")}\n` : "";
  const subjectIdentity = firstAvailable(
    output.deviceHostname,
    output.sourceHostname,
    output.clientHostname,
    output.sourceUsername,
    output.clientUserName
  ) || "n/a";
  const recommendations = historical
    .map((item) => ({ ticketId: item.ticketId, recommendation: selectHistoricalRecommendation(item) }))
    .filter((item) => item.recommendation)
    .map((item, index) => `${index + 1}. #${item.ticketId || "unknown"}: ${item.recommendation}`);
  const localRecommendations = Array.isArray(enrichment.recommendations)
    ? enrichment.recommendations.map(cleanText).filter(isAvailable).slice(0, 5)
    : [];
  const allRecommendations = [...recommendations, ...localRecommendations.map((item, index) => `${recommendations.length + index + 1}. ${item}`)];
  const investigationSummary = firstAvailable(enrichment.investigationSummary) || "x x x";
  const relatedActivity = firstAvailable(enrichment.relatedActivity) || "x x x";
  const vendorGuidance = firstAvailable(enrichment.vendorGuidance) || "x x x";
  const signature = [
    template.signOff,
    template.analystName,
    template.analystName ? template.analystTitle : ""
  ].filter(Boolean).join("\n");

  return `${template.greeting} ${firstAvailable(output.customerName) || "n/a"},
${pastRatingLine}We have detected ${firstAvailable(output.incidentName) || "n/a"} for ${subjectIdentity}.
-----------------------------------------------------------------

Event info breakdown is as follows:

Time Stamp: ${firstAvailable(output.occurred) || "n/a"}
User: ${firstAvailable(output.sourceUsername, output.clientUserName) || "n/a"}
Source: ${firstAvailable(output.sourceIp, output.sourceUsername, output.clientUserName) || "n/a"}
Destination: ${firstAvailable(output.destinationIp) || "n/a"}
Client Hostname: ${firstAvailable(output.clientHostname, output.deviceHostname) || "n/a"}
Event Detail: ${firstAvailable(output.eventName) || "n/a"}
Event Record URL: ${firstAvailable(output.detectionUrl) || "n/a"}
Error / Service Message: ${firstAvailable(output.serviceMessage, output.eventInfo, output.errorMessage) || "n/a"}
----------------------------------------------------------

Investigation Summary
${investigationSummary}
-----

Related Activity
${relatedActivity}
-----

${template.recommendationsHeading}
${allRecommendations.length ? allRecommendations.join("\n") : "x x x"}
-----------------------------------------------

Vendor Guidance
${vendorGuidance}
-----

${template.contactText}${signature ? `\n\n${signature}` : ""}`;
}
