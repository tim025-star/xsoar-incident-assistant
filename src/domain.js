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
  deviceHostname: ["Device Hostname", "Device Host Hostname", "Device Name", "Device DNS Name", "CompromisedEntity", "Hostname"],
  eventInfo: ["Event Info"],
  eventName: ["Event Name", "Display Name", "display_name"],
  detectionUrl: ["Detection URL", "IncidentWebURL", "Incident Web URL", "incident_web_url"],
  errorMessage: ["Error Message"],
  serviceMessage: ["Service Message", "Event Info", "Error Message", "Description"],
  sourceHostname: ["Source Hostname", "Source Host Hostname"],
  sourceIp: ["Source IP", "Source IP Address", "Client IP Address"],
  sourceUsername: ["Source Username", "Source User Name", "Client Principal Name", "AccountName"],
  descriptionLong: ["Description Long"]
});

export const LOG_TABLE_FIELD_KEYS = Object.freeze([
  "sourceIp", "sourceUsername", "deviceHostname", "eventName", "detectionUrl", "serviceMessage"
]);

export const DEFAULT_SETTINGS = Object.freeze({
  configVersion: 3,
  allowedOrigin: "",
  incidentUrlPattern: "\\/Custom\\/[^/]+\\/\\d+\\/?(?:[?#].*)?$",
  incidentPathTemplate: "/Custom/GenericLayout/{id}",
  incidentsPath: "/incidents",
  searchQueryParameter: "query",
  lookbackQuery: "created:>=\"3 months ago\"",
  maxHistoricalIncidents: 5,
  pageReadyTimeoutMs: 20000,
  incidentInfoTabLabel: "Incident Info",
  investigationTabLabel: "Investigation",
  historicalSummaryLabels: [],
  historicalRecommendationLabels: [],
  fieldLabels: FIELD_LABELS,
  template: {
    greeting: "Hello",
    // Retained only so existing configuration files continue to load; processed output never renders it.
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
  if ((settings.incidentPathTemplate.match(/\{id\}/g) || []).length !== 1
    || !/\/\{id\}\/?$/.test(settings.incidentPathTemplate)) {
    throw new Error("incidentPathTemplate must end with /{id} so the Incident ID is the final path segment.");
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
  if (!settings.incidentsPath.startsWith("/") || incidentsUrl.origin !== settings.allowedOrigin
    || incidentsUrl.username || incidentsUrl.password || incidentsUrl.search || incidentsUrl.hash) {
    throw new Error("incidentsPath must be an absolute path on the configured XSOAR origin without a query or fragment.");
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
  const configured = new RegExp(settings.incidentUrlPattern).test(`${url.pathname}${url.search}${url.hash}`);
  const resultRoute = !url.search && !url.hash && (
    /^\/incident\/\d+\/?$/i.test(url.pathname)
    || /^\/incident\d+\/\d+\/overview\/?$/i.test(url.pathname)
  );
  if (!configured && !resultRoute) {
    throw new Error(`${operation} did not open a configured XSOAR incident path.`);
  }
  return url;
}

export function incidentTicketIdFromUrl(value, settings, operation = "Incident navigation") {
  const url = assertIncidentUrl(value, settings, operation);
  return url.pathname.match(/^\/incident\d+\/(\d+)\/overview\/?$/i)?.[1]
    || url.pathname.match(/\/(\d+)\/?$/)?.[1]
    || "";
}

export function assertIncidentRouteCompatibility(settings) {
  const supportsAnIncidentIdLength = Array.from({ length: 32 }, (_, index) => "1".repeat(index + 1))
    .some((sampleId) => {
      const sampleUrl = new URL(settings.incidentPathTemplate.replace("{id}", sampleId), settings.allowedOrigin);
      return new RegExp(settings.incidentUrlPattern).test(sampleUrl.pathname);
    });
  if (!supportsAnIncidentIdLength) {
    throw new Error("incidentPathTemplate must match incidentUrlPattern.");
  }
  return settings;
}

function escapeQueryValue(value) {
  return cleanText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildSearchQuery(incidentName, caseType, lookbackQuery = "") {
  if (!isAvailable(incidentName) || !isAvailable(caseType)) {
    throw new Error("The incident must expose both Incident Name and Type before a historic search can run.");
  }
  const parts = [
    `rawName:"${escapeQueryValue(incidentName)}"`,
    `rawType:"${escapeQueryValue(caseType)}"`
  ];
  if (cleanText(lookbackQuery)) parts.push(`(${cleanText(lookbackQuery)})`);
  return parts.join(" and ");
}

export function buildIncidentSearchUrl(settings, query) {
  const url = new URL(settings.incidentsPath, settings.allowedOrigin);
  if (url.origin !== settings.allowedOrigin) {
    throw new Error("The incident search URL left the configured XSOAR origin.");
  }
  const cleanQuery = cleanText(query);
  if (cleanQuery) url.searchParams.set(settings.searchQueryParameter, cleanQuery);
  return url.toString();
}

export function assertSearchUrl(value, settings, expectedQuery) {
  const url = assertTrustedUrl(value, settings, "Historic incident search");
  const configuredUrl = new URL(settings.incidentsPath, settings.allowedOrigin);
  const normalizePath = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalizePath(url.pathname) !== normalizePath(configuredUrl.pathname)) {
    throw new Error("XSOAR did not retain the configured incidents page path.");
  }
  const actualQuery = cleanText(url.searchParams.get(settings.searchQueryParameter));
  if (actualQuery !== cleanText(expectedQuery)) {
    throw new Error("XSOAR did not retain the expected historic query in the page URL.");
  }
  return url;
}

export function buildIncidentUrlFromId(ticketId, settings) {
  if (!/^\d+$/.test(String(ticketId))) throw new Error("Incident ID must be numeric.");
  const url = new URL(settings.incidentPathTemplate.replace("{id}", String(ticketId)), settings.allowedOrigin);
  return assertIncidentUrl(url.toString(), settings, "Requested incident navigation").toString();
}

export function buildHistoricalIncidentUrl(currentIncidentUrl, ticketId, settings) {
  const source = assertIncidentUrl(currentIncidentUrl, settings, "Historic incident URL construction");
  if (!/^\d+$/.test(String(ticketId))) throw new Error("Historic incident ID must be numeric.");
  const replaced = source.pathname.replace(
    /\/\d+(\/?)$/,
    (_match, trailingSlash) => `/${ticketId}${trailingSlash}`
  );
  if (replaced === source.pathname) throw new Error("The current incident URL does not end with a numeric ID.");
  source.pathname = replaced;
  source.search = "";
  source.hash = "";
  return assertIncidentUrl(source.toString(), settings, "Historic incident URL construction").toString();
}

export function mergeIncidentDetails(...details) {
  const merged = {};
  for (const detail of details.filter(Boolean)) {
    for (const [key, value] of Object.entries(detail)) {
      if (key === "tabUrls") continue;
      if (key === "alertJson") {
        const existing = Array.isArray(merged.alertJson) ? merged.alertJson : [];
        const incoming = Array.isArray(value) ? value : [];
        const seen = new Set(existing.map((item) => JSON.stringify(item)));
        merged.alertJson = [...existing];
        for (const item of incoming) {
          const serialized = JSON.stringify(item);
          if (!seen.has(serialized)) {
            merged.alertJson.push(item);
            seen.add(serialized);
          }
        }
        continue;
      }
      if (key === "alertJsonComplete") {
        merged.alertJsonComplete = merged.alertJsonComplete !== false && value !== false;
        continue;
      }
      if (!isAvailable(merged[key]) && isAvailable(value)) merged[key] = cleanText(value);
    }
  }
  return merged;
}

function selectHistoricResolution(item = {}) {
  return firstAvailable(item.historicalRecommendations, item.closeNotes, item.incidentOutcome);
}

function buildHistoric(historical = []) {
  return historical
    .map((item) => ({ ticketId: item.ticketId, resolution: selectHistoricResolution(item) }))
    .filter((item) => item.resolution)
    .map((item, index) => `${index + 1}. #${item.ticketId || "unknown"}: ${item.resolution}`);
}

function buildSignature(template) {
  return [
    template.signOff,
    template.analystName,
    template.analystName ? template.analystTitle : ""
  ].filter(Boolean).join("\n");
}

export function buildDraft(output, templateInput = {}, enrichment = null) {
  const template = { ...DEFAULT_SETTINGS.template, ...templateInput };
  const subjectIdentity = firstAvailable(
    output.deviceHostname,
    output.sourceHostname,
    output.clientHostname,
    output.sourceUsername,
    output.clientUserName
  ) || "n/a";
  const eventSummary = firstAvailable(enrichment?.eventSummary) || "No additional source facts were extracted.";
  const observedFacts = Array.isArray(enrichment?.observedFacts)
    ? [...new Set(enrichment.observedFacts.map(cleanText).filter(isAvailable))].slice(0, 10)
    : [];
  const signature = buildSignature(template);
  const historic = buildHistoric(output.historical);
  const customerName = firstAvailable(output.customerName);
  const greeting = customerName ? `${template.greeting} ${customerName},\n` : "";

  return `${greeting}Incident ID: ${firstAvailable(output.ticketId) || "n/a"}
Incident: ${firstAvailable(output.incidentName) || "n/a"}
Affected entity: ${subjectIdentity}
Recorded classification: ${firstAvailable(output.classification) || "n/a"}
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

Processed Incident Data
Event Summary: ${eventSummary}
Observed Facts:
${observedFacts.length ? observedFacts.map((item) => `- ${item}`).join("\n") : "No additional source facts were extracted."}
-----

${template.contactText}${signature ? `\n\n${signature}` : ""}

Historic
${historic.length ? historic.join("\n") : "No matching historic resolutions were found."}`;
}
