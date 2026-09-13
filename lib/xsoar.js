// @ts-check
"use strict";

const FIELD_LABELS = {
  customerName: ["Customer Name"],
  customerShortName: ["Customer Short Name"],
  classification: ["Classification"],
  owner: ["Owner"],
  phase: ["Phase"],
  occurred: ["Occurred"],
  incidentOutcome: ["Incident Outcome"],
  closeNotes: ["Close Notes"],
  ruleName: ["Rule Name"],
  caseType: ["Type", "Case Type"],
  description: ["Description"],
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
  descriptionLong: {
    labels: ["Description Long"],
    unlabeledSelectors: [".editable-long-text-field", ".text-field-wrapper.longText"]
  }
};

const RESULT_ROOT_SELECTOR = "[role='grid'][aria-rowcount],.fixedDataTableLayout_main";
const RESULT_TICKET_LINK_SELECTOR = "a.investigation-id[href],a[href*='/incident/' i]";
const searchNetworkProbes = new WeakMap();
const TEMPLATE_DEFAULTS = Object.freeze({
  greeting: "Hello",
  recommendationsHeading: "Recommended Actions",
  contactText: "If you require more information or would like to discuss this incident, contact your security operations team and quote the incident ID.",
  signOff: "Kind regards,",
  analystName: "",
  analystTitle: "Security Analyst"
});

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function isAvailableValue(value) {
  const normalized = cleanText(value);
  return Boolean(normalized && !/^(?:n\/?a|none|null|undefined|-)$/i.test(normalized));
}

function firstAvailable(...values) {
  return values.map(cleanText).find(isAvailableValue) || "";
}

function escapeXsoarValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSearchQuery(ruleName, caseType) {
  return `name:"${escapeXsoarValue(ruleName)}" and type:"${escapeXsoarValue(caseType)}"`;
}

function headlessBrowserChannelForProduct(product) {
  const value = String(product || "");
  if (/\b(?:edg|edge)\//i.test(value)) return "msedge";
  return "chrome";
}

function resolveTemplateConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("template must be a JSON object when provided.");
  }
  const resolved = { ...TEMPLATE_DEFAULTS };
  for (const key of Object.keys(TEMPLATE_DEFAULTS)) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== "string" || value[key].length > 1000) {
      throw new Error(`template.${key} must be a string no longer than 1000 characters.`);
    }
    resolved[key] = value[key].trim();
  }
  if (!resolved.greeting) throw new Error("template.greeting must not be empty.");
  if (!resolved.recommendationsHeading) {
    throw new Error("template.recommendationsHeading must not be empty.");
  }
  return resolved;
}

function normalizeAllowedOrigins(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("allowedXsoarOrigins must contain at least one trusted HTTPS origin.");
  }
  const origins = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("allowedXsoarOrigins entries must be non-empty strings.");
    }
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`allowedXsoarOrigins contains an invalid URL: ${entry}`);
    }
    if (url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`allowedXsoarOrigins must contain exact HTTPS origins without paths: ${entry}`);
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function resolveFieldLabels(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fieldLabels must be a JSON object when provided.");
  }
  const resolved = { ...FIELD_LABELS };
  for (const [key, configured] of Object.entries(value)) {
    if (!Object.hasOwn(FIELD_LABELS, key)) {
      throw new Error(`fieldLabels.${key} is not a supported incident field.`);
    }
    const labels = Array.isArray(configured)
      ? configured
      : (!Array.isArray(FIELD_LABELS[key]) && configured && typeof configured === "object")
        ? configured.labels
        : null;
    if (!Array.isArray(labels) || labels.length === 0
      || labels.some((label) => typeof label !== "string" || !label.trim())) {
      throw new Error(`fieldLabels.${key} must be a non-empty array of non-empty strings.`);
    }
    const normalized = labels.map((label) => label.trim());
    resolved[key] = Array.isArray(FIELD_LABELS[key])
      ? normalized
      : { ...FIELD_LABELS[key], labels: normalized };
  }
  return resolved;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config.json must contain a JSON object.");
  }

  for (const key of [
    "cdpEndpoint",
    "notepadPlusPlusPath",
    "incidentUrlPattern",
    "searchRequestUrlPattern",
    "incidentsPath",
    "timeRangeLabel"
  ]) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
  for (const [key, fallback] of [
    ["incidentInfoTabLabel", "Incident Info"],
    ["investigationTabLabel", "Investigation"]
  ]) {
    const value = config[key] ?? fallback;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${key} must be a non-empty string.`);
    }
    config[key] = value.trim();
  }
  try {
    const endpoint = new URL(config.cdpEndpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)) throw new Error("unsupported protocol");
    if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname.toLowerCase())) {
      throw new Error("non-loopback host");
    }
  } catch {
    throw new Error("cdpEndpoint must be a valid loopback HTTP(S) or WebSocket URL.");
  }
  try {
    new RegExp(config.incidentUrlPattern);
  } catch {
    throw new Error("incidentUrlPattern must be a valid regular expression.");
  }
  try {
    new RegExp(config.searchRequestUrlPattern, "i");
  } catch {
    throw new Error("searchRequestUrlPattern must be a valid regular expression.");
  }
  try {
    new URL(config.incidentsPath, "https://xsoar.invalid");
  } catch {
    throw new Error("incidentsPath must be a valid URL or URL path.");
  }

  for (const key of ["navigationTimeoutMs", "resultsTimeoutMs"]) {
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }
    config[key] = value;
  }
  for (const [key, fallback] of [
    ["paginationTimeoutMs", config.resultsTimeoutMs],
    ["historicalFieldsTimeoutMs", 5000]
  ]) {
    const value = Object.hasOwn(config, key) ? config[key] : fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive number.`);
    }
    config[key] = value;
  }
  for (const key of ["excludeCurrentTicket", "collectHistoricalDetails"]) {
    if (typeof config[key] !== "boolean") {
      throw new Error(`${key} must be a boolean.`);
    }
  }
  const debugMode = config.debugMode ?? false;
  if (typeof debugMode !== "boolean") {
    throw new Error("debugMode must be a boolean.");
  }
  config.debugMode = debugMode;
  const headless = config.headless ?? false;
  if (typeof headless !== "boolean") {
    throw new Error("headless must be a boolean.");
  }
  config.headless = headless;
  const headlessBrowserChannel = config.headlessBrowserChannel ?? "auto";
  if (typeof headlessBrowserChannel !== "string"
    || !["auto", "chrome", "msedge", "chromium"].includes(headlessBrowserChannel)) {
    throw new Error("headlessBrowserChannel must be auto, chrome, msedge, or chromium.");
  }
  config.headlessBrowserChannel = headlessBrowserChannel;
  if (Object.hasOwn(config, "headlessExecutablePath")
    && (typeof config.headlessExecutablePath !== "string" || !config.headlessExecutablePath.trim())) {
    throw new Error("headlessExecutablePath must be a non-empty string when provided.");
  }
  const concurrency = config.historicalConcurrency ?? 2;
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("historicalConcurrency must be a positive integer.");
  }
  config.historicalConcurrency = concurrency;
  const maxHistoricalIncidents = config.maxHistoricalIncidents ?? 5;
  if (typeof maxHistoricalIncidents !== "number"
    || !Number.isInteger(maxHistoricalIncidents)
    || maxHistoricalIncidents < 1) {
    throw new Error("maxHistoricalIncidents must be a positive integer.");
  }
  config.maxHistoricalIncidents = maxHistoricalIncidents;
  for (const key of ["historicalSummaryLabels", "historicalRecommendationLabels"]) {
    const labels = config[key] ?? [];
    if (!Array.isArray(labels)
      || labels.some((label) => typeof label !== "string" || !label.trim())) {
      throw new Error(`${key} must be an array of non-empty strings.`);
    }
    config[key] = labels;
  }
  config.allowedXsoarOrigins = normalizeAllowedOrigins(config.allowedXsoarOrigins);
  config.fieldLabels = resolveFieldLabels(config.fieldLabels ?? {});
  config.template = resolveTemplateConfig(config.template ?? {});
  return config;
}

async function extractLabeledFields(page, requestedLabels) {
  return page.evaluate((fieldDefinitions) => {
    const normalize = (value) => String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
    const normalizeLabel = (value) => normalize(value).toLowerCase().replace(/\s+/g, " ");
    const isAvailable = (value) => Boolean(value
      && !/^(?:n\/?a|none|null|undefined|-)$/i.test(normalize(value)));
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const wrappers = Array.from(document.querySelectorAll(".field-wrapper")).filter(isVisible);

    const extractValue = (root) => {
      if (!root) return "";
      const preferredSelectors = [
        ".text-field-display-value",
        ".date-display-value",
        ".single-select-field-wrapper__single-value",
        "[class*='singleValue']",
        ".markdown",
        ".preplacer"
      ];

      for (const selector of preferredSelectors) {
        const element = Array.from(root.querySelectorAll(selector)).find(isVisible);
        if (!element) continue;
        const value = normalize(element.getAttribute("title") || element.innerText || element.textContent);
        if (value && !/^(edit|clear|select)$/i.test(value)) return value;
      }

      const titled = Array.from(root.querySelectorAll("[title]"))
        .filter((element) => isVisible(element)
          && !element.closest("label,button,input,textarea,select"))
        .map((element) => normalize(element.getAttribute("title")))
        .filter((value) => value && !/^(edit|clear|select|open)$/i.test(value));
      if (titled.length) return titled.sort((a, b) => b.length - a.length)[0];

      const clone = root.cloneNode(true);
      clone.querySelectorAll("label,button,input,textarea,select,svg,object,.resize-sensor,.xdr-sr-only")
        .forEach((element) => element.remove());
      return normalize(clone.innerText || clone.textContent);
    };

    const result = {};
    for (const [key, definition] of Object.entries(fieldDefinitions)) {
      const labels = Array.isArray(definition) ? definition : definition.labels || [];
      const includes = Array.isArray(definition) ? [] : definition.includes || [];
      const includesAll = Array.isArray(definition) ? [] : definition.includesAll || [];
      const unlabeledSelectors = Array.isArray(definition) ? [] : definition.unlabeledSelectors || [];
      const fieldIds = [...new Set([
        key,
        ...(Array.isArray(definition) ? [] : definition.fieldIds || [])
      ].map((value) => normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean))];
      const accepted = labels.map(normalizeLabel);
      const fragments = includes.map(normalizeLabel);
      const requiredFragments = includesAll.map((group) => group.map(normalizeLabel));
      const findByFieldId = () => {
        for (const fieldId of fieldIds) {
          const candidates = Array.from(document.querySelectorAll(`.fieldId-${fieldId}`));
          for (const candidate of candidates) {
            if (!isVisible(candidate)) continue;
            const wrapper = candidate.matches(".field-wrapper")
              ? candidate
              : candidate.querySelector(".field-wrapper");
            if (wrapper && !isVisible(wrapper)) continue;
            const root = wrapper?.querySelector(".value-wrapper") || wrapper || candidate;
            if (!isVisible(root)) continue;
            const value = extractValue(root);
            if (isAvailable(value)) return value;
          }
        }
        return "";
      };
      const findValue = (matcher) => {
        for (const wrapper of wrappers) {
          const label = wrapper.querySelector("label");
          if (!label) continue;
          const actualLabels = [
            normalizeLabel(label.getAttribute("title")),
            normalizeLabel(label.innerText || label.textContent)
          ].filter(Boolean);
          if (!matcher(actualLabels)) continue;
          const candidate = extractValue(wrapper.querySelector(".value-wrapper") || wrapper);
          if (isAvailable(candidate)) return candidate;
        }
        return "";
      };
      let value = findByFieldId();
      if (!value) value = findValue((actualLabels) => actualLabels.some((actual) => accepted.includes(actual)));
      if (!value && requiredFragments.length) {
        value = findValue((actualLabels) => actualLabels.some((actual) => requiredFragments.some(
          (group) => group.every((fragment) => actual.includes(fragment))
        )));
      }
      if (!value && fragments.length) {
        value = findValue((actualLabels) => actualLabels.some(
          (actual) => fragments.some((fragment) => actual.includes(fragment))
        ));
      }
      if (!value && unlabeledSelectors.length) {
        const candidates = wrappers.filter((wrapper) => !wrapper.querySelector("label")
          && unlabeledSelectors.some((selector) => wrapper.matches(selector) || wrapper.querySelector(selector)));
        if (candidates.length === 1) {
          value = extractValue(candidates[0].querySelector(".value-wrapper") || candidates[0]);
        }
      }
      result[key] = value;
    }
    return result;
  }, requestedLabels);
}

async function extractSeverity(page) {
  const explicit = await extractLabeledFields(page, { severity: ["Severity"] });
  if (explicit.severity) return cleanText(explicit.severity);

  const indicator = page.locator(".investigation-header .severity-color").first();
  if (!(await indicator.count())) return "";
  return cleanText(await indicator.evaluate((element) => {
    const className = String(element.className || "");
    const match = className.match(/severity-(informational|low|medium|high|critical)-24-r/i)
      || className.match(/severity-color\s+([a-z]+)/i);
    return match ? match[1] : "";
  }).catch(() => ""));
}

async function extractIncidentName(page) {
  const header = page.locator(".header-inv-title").first();
  if (!(await header.count())) return "";
  let incidentName = cleanText(await header.getAttribute("title").catch(() => "")
    || await header.textContent().catch(() => ""));
  const activeTab = cleanText(await page.locator("[role='tab'][aria-selected='true'] .tab-label").first()
    .textContent().catch(() => ""));
  if (activeTab && incidentName.toLowerCase().endsWith(` - ${activeTab}`.toLowerCase())) {
    incidentName = incidentName.slice(0, -(activeTab.length + 3)).trim();
  } else {
    incidentName = incidentName.replace(/\s+-\s+(?:incident info|investigation)$/i, "").trim();
  }
  return incidentName;
}

async function extractEmbeddedEventFacts(page) {
  const aliases = {
    sourceIp: [
      "source ip", "source ip address", "client ip address",
      "alerts evidence ip evidence ip address"
    ],
    sourceUsername: [
      "source username", "source user name", "client principal name",
      "user account account name", "accountname"
    ],
    deviceHostname: [
      "device hostname", "device dns name", "compromisedentity",
      "sql server name", "alerts evidence device evidence device dns name", "hostname"
    ],
    eventName: ["event name", "display name", "display_name", "alerts display name"],
    detectionUrl: [
      "detection url", "incidentweburl", "incident web url", "incident_web_url",
      "alerts incident web url", "alerts_incident_web_url",
      "alerts alert web url", "alerts_alert_web_url"
    ],
    serviceMessage: [
      "service message", "event info", "error message", "description",
      "alerts description", "alerts_description"
    ]
  };

  return page.evaluate((requestedAliases) => {
    const normalize = (value) => String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizeKey = (value) => normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const available = (value) => Boolean(value && !/^(?:n\/?a|none|null|undefined|-)$/i.test(value));
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const pairs = [];
    const addPair = (key, value) => {
      const normalizedKey = normalizeKey(key);
      const normalizedValue = normalize(value).replace(/\s*\(⭷\)\s*$/, "").trim();
      if (normalizedKey && available(normalizedValue) && normalizedValue.length <= 10000) {
        pairs.push([normalizedKey, normalizedValue]);
      }
    };

    for (const row of document.querySelectorAll("tr")) {
      if (!isVisible(row)) continue;
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) addPair(cells[0].innerText || cells[0].textContent, cells[1].innerText || cells[1].textContent);
    }
    for (const emphasis of document.querySelectorAll("em")) {
      if (!isVisible(emphasis)) continue;
      const strong = emphasis.querySelector(":scope > strong");
      if (!strong) continue;
      let value = "";
      for (let sibling = emphasis.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE
          && sibling instanceof Element && sibling.matches("em")) break;
        if (sibling.nodeType === Node.TEXT_NODE) value += sibling.textContent || "";
      }
      addPair(strong.textContent, value.replace(/^\s*:\s*/, ""));
    }

    const result = {};
    for (const [name, candidates] of Object.entries(requestedAliases)) {
      result[name] = "";
      for (const candidate of candidates) {
        const normalizedCandidate = normalizeKey(candidate);
        const match = pairs.find(([key]) => key === normalizedCandidate);
        if (match) {
          result[name] = match[1];
          break;
        }
      }
    }
    return result;
  }, aliases);
}

async function extractIncident(page, config = {}) {
  if (config.allowedXsoarOrigins) {
    assertTrustedIncidentUrl(
      page.url(),
      config.incidentUrlPattern,
      config.allowedXsoarOrigins,
      "Incident extraction"
    );
  }
  const configuredFieldLabels = resolveFieldLabels(config.fieldLabels ?? {});
  const labels = {
    ...configuredFieldLabels,
    historicalSummary: {
      labels: config.historicalSummaryLabels || [],
      includesAll: (config.historicalSummaryLabels || []).length
        ? []
        : [["historical", "summary"]]
    },
    historicalRecommendations: {
      labels: config.historicalRecommendationLabels || [],
      includesAll: (config.historicalRecommendationLabels || []).length
        ? []
        : [
          ["historical", "recommendation"],
          ["customer", "recommendation"]
        ]
    }
  };
  const fields = await extractLabeledFields(page, labels);
  const embedded = await extractEmbeddedEventFacts(page);
  const headerTicket = cleanText(await page.locator(".header-inv-id").first().textContent().catch(() => ""));
  const urlTicket = page.url().match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1] || "";
  const ticketId = (headerTicket.match(/\d+/)?.[0] || urlTicket).trim();

  return {
    ticketId,
    incidentName: await extractIncidentName(page),
    ruleName: cleanText(fields.ruleName),
    caseType: cleanText(fields.caseType),
    customerName: cleanText(fields.customerName),
    customerShortName: cleanText(fields.customerShortName),
    classification: cleanText(fields.classification),
    owner: cleanText(fields.owner),
    severity: await extractSeverity(page),
    description: cleanText(fields.description),
    occurred: cleanText(fields.occurred),
    phase: cleanText(fields.phase),
    incidentOutcome: cleanText(fields.incidentOutcome),
    closeNotes: cleanText(fields.closeNotes),
    clientIp: cleanText(fields.clientIp),
    clientHostname: cleanText(fields.clientHostname),
    clientUserName: cleanText(fields.clientUserName),
    destinationIp: firstAvailable(fields.destinationIp),
    deviceHostname: firstAvailable(fields.deviceHostname, embedded.deviceHostname),
    eventInfo: cleanText(fields.eventInfo),
    eventName: firstAvailable(fields.eventName, embedded.eventName),
    detectionUrl: firstAvailable(fields.detectionUrl, embedded.detectionUrl),
    errorMessage: cleanText(fields.errorMessage),
    serviceMessage: firstAvailable(fields.serviceMessage, embedded.serviceMessage),
    sourceHostname: cleanText(fields.sourceHostname),
    sourceIp: firstAvailable(fields.sourceIp, fields.clientIp, embedded.sourceIp),
    sourceUsername: firstAvailable(fields.sourceUsername, fields.clientUserName, embedded.sourceUsername),
    descriptionLong: cleanText(fields.descriptionLong),
    historicalSummary: cleanText(fields.historicalSummary),
    historicalRecommendations: cleanText(fields.historicalRecommendations)
  };
}

async function discoverIncidentTabUrl(page, tabLabel) {
  const currentOrigin = new URL(page.url()).origin;
  const discovered = await page.evaluate((expectedLabel) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const expected = normalize(expectedLabel);
    const links = Array.from(document.querySelectorAll("a[role='tab'][href]"));
    const match = links.find((link) => {
      const label = link.querySelector(".tab-label") || link;
      return normalize(label.getAttribute("title") || label.textContent) === expected;
    });
    return match ? new URL(match.getAttribute("href"), location.href).href : "";
  }, tabLabel);
  if (discovered && new URL(discovered).origin !== currentOrigin) {
    throw new Error(`The ${tabLabel} tab resolved outside the selected XSOAR origin.`);
  }
  return discovered;
}

function mergeIncidentDetails(details) {
  const merged = {};
  const keys = new Set(details.flatMap((item) => Object.keys(item || {})));
  for (const key of keys) {
    const values = details.map((item) => item?.[key]);
    merged[key] = firstAvailable(...values) || cleanText(values.find((value) => cleanText(value)));
  }
  return merged;
}

async function extractIncidentAcrossTabs(
  context,
  incidentPage,
  config,
  reportProgress = async (_stage, _detail) => {}
) {
  const originalUrl = incidentPage.url();
  const originalRoute = new URL(originalUrl).pathname;
  const activeLabel = cleanText(await incidentPage
    .locator("[role='tab'][aria-selected='true'] .tab-label,[role='tab'][aria-selected='true']")
    .first()
    .textContent()
    .catch(() => ""));
  await waitForIncidentReady(incidentPage, config.navigationTimeoutMs, {
    requiredFields: incidentViewRequirements(activeLabel, config)
  });
  const initial = await extractIncident(incidentPage, config);
  const incidentInfoTabLabel = config.incidentInfoTabLabel || "Incident Info";
  const investigationTabLabel = config.investigationTabLabel || "Investigation";
  const incidentInfoUrl = await discoverIncidentTabUrl(incidentPage, incidentInfoTabLabel);
  const investigationUrl = await discoverIncidentTabUrl(incidentPage, investigationTabLabel);
  const additional = [];
  const routes = [
    [incidentInfoTabLabel, incidentInfoUrl],
    [investigationTabLabel, investigationUrl]
  ];
  const visited = new Set([originalRoute.toLowerCase()]);

  try {
    for (const [label, url] of routes) {
      if (!url) continue;
      const route = new URL(url).pathname.toLowerCase();
      if (visited.has(route)) continue;
      visited.add(route);
      await reportProgress("reading_incident_view", `Opening the ${label} view to collect its incident fields.`);
      let page;
      try {
        page = await openForegroundPage(
          context,
          url,
          config.navigationTimeoutMs,
          new URL(originalUrl).origin
        );
        await waitForIncidentReady(page, config.navigationTimeoutMs, {
          requiredFields: incidentViewRequirements(label, config)
        });
        const details = await extractIncident(page, config);
        if (initial.ticketId && details.ticketId !== initial.ticketId) {
          throw new Error(`Expected incident ${initial.ticketId}, but the ${label} view opened ${details.ticketId || "an unknown ticket"}.`);
        }
        additional.push(details);
      } finally {
        if (page) await settleWithin(() => page.close(), 3000);
      }
    }
  } finally {
    await settleWithin(() => incidentPage.bringToFront(), 3000);
  }

  return {
    incident: mergeIncidentDetails([initial, ...additional]),
    incidentInfoUrl: incidentInfoUrl || originalUrl
  };
}

function incidentViewRequirements(label, config = {}) {
  const labels = resolveFieldLabels(config.fieldLabels ?? {});
  const incidentInfoTabLabel = cleanText(config.incidentInfoTabLabel || "Incident Info");
  const investigationTabLabel = cleanText(config.investigationTabLabel || "Investigation");
  if (cleanText(label).toLowerCase() === incidentInfoTabLabel.toLowerCase()) {
    return [
      { labels: labels.ruleName },
      { labels: labels.caseType }
    ];
  }
  if (cleanText(label).toLowerCase() === investigationTabLabel.toLowerCase()) {
    return [
      { labels: labels.occurred },
      { labels: labels.eventName }
    ];
  }
  return [];
}

function incidentUrlMatches(url, pattern, allowedOrigins) {
  try {
    const parsed = new URL(url);
    return allowedOrigins.includes(parsed.origin)
      && new RegExp(pattern, "i").test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return false;
  }
}

function collectRenderedLinks({ maxLinks, maxUrlChars, maxTextChars, maxScannedLinks = 5000 }) {
  const links = [];
  const seen = new Set();
  const visited = new Set();
  let scanned = 0;

  function isRendered(element) {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    try {
      const style = getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && style.contentVisibility !== "hidden";
    } catch {
      return true;
    }
  }

  function compactLinkText(anchor) {
    const visibleText = (anchor.textContent || "").replace(/\s+/g, " ").trim();
    const text = visibleText || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "";
    return text.slice(0, maxTextChars);
  }

  function collectNode(node) {
    if (!node || scanned >= maxScannedLinks || visited.has(node)) return;
    visited.add(node);
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (!isRendered(node)) return;
      if (node.localName === "a" && node.hasAttribute("href")) {
        scanned += 1;
        const rawHref = node.getAttribute("href") || "";
        if (rawHref && rawHref.length <= maxUrlChars) {
          try {
            const parsed = new URL(rawHref, document.baseURI);
            const url = parsed.href;
            if (/^https?:$/i.test(parsed.protocol) && url.length <= maxUrlChars && !seen.has(url)) {
              seen.add(url);
              const text = compactLinkText(node);
              const routeSegments = `${parsed.pathname}/${parsed.hash}/${parsed.search}`
                .split(/[\/#?&=]+/)
                .map((segment) => segment.toLowerCase())
                .filter(Boolean);
              const score = (parsed.origin === document.location.origin ? 20 : 0)
                + (text.toLowerCase() === "incidents" ? 100 : 0)
                + (routeSegments.includes("incidents") ? 80 : 0);
              links.push({ url, text, score, index: scanned });
            }
          } catch {
            // Ignore malformed and non-navigable href values.
          }
        }
      }
      if (scanned >= maxScannedLinks) return;
      if (node.localName === "slot" && typeof node.assignedNodes === "function") {
        const assigned = node.assignedNodes({ flatten: true });
        for (const child of assigned.length > 0 ? assigned : node.childNodes) collectNode(child);
        return;
      }
      if (node.shadowRoot) {
        collectNode(node.shadowRoot);
        return;
      }
    }
    for (const child of node.childNodes || []) collectNode(child);
  }

  if (document.body) collectNode(document.body);
  return links
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxLinks)
    .map(({ url, text }) => ({ url, text }));
}

async function discoverIncidentsUrl(page, configuredPath) {
  const currentUrl = new URL(page.url());
  const fallbackUrl = new URL(configuredPath, currentUrl);
  if (fallbackUrl.origin !== currentUrl.origin) {
    throw new Error("incidentsPath must resolve to the same XSOAR origin as the active incident.");
  }

  const links = await page.evaluate(collectRenderedLinks, {
    maxLinks: 200,
    maxUrlChars: 2048,
    maxTextChars: 160,
    maxScannedLinks: 5000
  });
  const candidatesByUrl = new Map();

  for (const link of links) {
    let candidate;
    try {
      candidate = new URL(link.url, currentUrl);
    } catch {
      continue;
    }
    if (candidate.origin !== currentUrl.origin) continue;

    const text = cleanText(link.text).toLowerCase();
    const routeSegments = `${candidate.pathname}/${candidate.hash}/${candidate.search}`
      .split(/[\/#?&=]+/)
      .map((segment) => segment.toLowerCase())
      .filter(Boolean);
    const exactLabel = text === "incidents";
    const incidentsRoute = routeSegments.includes("incidents");
    if (!exactLabel && !incidentsRoute) continue;

    let score = (exactLabel ? 100 : 0) + (incidentsRoute ? 80 : 0);
    if (/\b(?:linked|my) incidents\b/i.test(text)) score -= 100;
    if (score <= 0) continue;

    const key = candidate.href.toLowerCase();
    const existing = candidatesByUrl.get(key);
    if (!existing || score > existing.score) candidatesByUrl.set(key, { url: candidate.href, score });
  }

  const candidates = [...candidatesByUrl.values()]
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  if (!candidates.length) return fallbackUrl.toString();
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    throw new Error("Multiple rendered Incidents navigation links were equally plausible.");
  }
  return candidates[0].url;
}

async function findActiveIncidentPage(browser, pattern, allowedOrigins) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const matches = pages.filter((page) => incidentUrlMatches(page.url(), pattern, allowedOrigins));
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (await matches[index].evaluate(() => document.hasFocus()).catch(() => false)) return matches[index];
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error("Multiple open XSOAR incident tabs matched, but none was focused. Focus the intended incident and try again.");
  }
  throw new Error("No open XSOAR incident tab matched the configured Custom incident URL pattern.");
}

async function clearSearchProbe(page) {
  const networkProbe = searchNetworkProbes.get(page);
  if (networkProbe) {
    page.off("request", networkProbe.onRequest);
    page.off("response", networkProbe.onResponse);
    page.off("requestfinished", networkProbe.onFinished);
    page.off("requestfailed", networkProbe.onFailed);
    searchNetworkProbes.delete(page);
  }
  await page.evaluate(() => {
    const windowWithProbe = /** @type {Window & {__xsoarAssistantSearchProbe?: any}} */ (window);
    windowWithProbe.__xsoarAssistantSearchProbe?.observer?.disconnect();
    delete windowWithProbe.__xsoarAssistantSearchProbe;
  }).catch(() => {});
}

async function findVisibleTimeRangeControl(page, expectedLabel, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expected = cleanText(expectedLabel).toLowerCase();

  do {
    const controls = page.locator([
      ".filters-header-date-picker .range-header",
      "button",
      "a",
      "[role='button']",
      "[role='combobox']",
      "[aria-haspopup]",
      "[aria-label*='time range' i]",
      "[aria-label*='date range' i]",
      "[class*='range' i]",
      "[class*='date-picker' i]"
    ].join(","));
    const bestIndex = await controls.evaluateAll((elements, options) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      let selectedIndex = -1;
      let selectedScore = 0;
      for (let index = 0; index < Math.min(elements.length, 250); index += 1) {
        const element = elements[index];
        const style = getComputedStyle(element);
        const visible = style.display !== "none"
          && style.visibility !== "hidden"
          && style.visibility !== "collapse"
          && style.contentVisibility !== "hidden"
          && element.getClientRects().length > 0;
        if (!visible) continue;
        const normalizedText = normalize(element.textContent);
        const accessibleValues = [
          normalizedText,
          normalize(element.getAttribute("aria-label")),
          normalize(element.getAttribute("title"))
        ].filter(Boolean);
        const matchesExpected = accessibleValues.some((value) => value === options.expected || value.includes(options.expected));
        const metadata = normalize(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("class") || ""}`);
        let score = 0;
        if (element.matches(".filters-header-date-picker .range-header")) score += 200;
        if (matchesExpected) score += 100;
        if (/\b(?:time|date)[-_ ]?range\b/.test(metadata)) score += 60;
        if (/range-header|date-picker/.test(metadata)) score += 30;
        if (/^(?:last|past|previous)\s+\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)$/i.test(normalizedText)) score += 40;
        if (score === 0) continue;
        if (element.matches("button,a,[role='button'],[role='combobox'],[aria-haspopup]")) score += 10;
        if (score > selectedScore) {
          selectedIndex = index;
          selectedScore = score;
        }
      }
      return selectedIndex;
    }, { expected }).catch(() => -1);

    if (bestIndex >= 0) return controls.nth(bestIndex);
    const remaining = deadline - Date.now();
    if (remaining > 0) await page.waitForTimeout(Math.min(100, remaining));
  } while (Date.now() < deadline);

  throw new Error(`XSOAR did not expose a visible time-range control within ${timeoutMs} ms.`);
}

async function timeRangeControlMatches(control, expectedLabel) {
  const expected = cleanText(expectedLabel).toLowerCase();
  const values = await Promise.all([
    control.textContent().catch(() => ""),
    control.getAttribute("aria-label").catch(() => ""),
    control.getAttribute("title").catch(() => "")
  ]);
  return values
    .map((value) => cleanText(value).toLowerCase())
    .some((value) => value === expected || value.includes(expected));
}

async function collectTimeRangeDiagnostics(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const controls = Array.from(document.querySelectorAll([
      "button",
      "a",
      "[role='button']",
      "[role='combobox']",
      "[aria-haspopup]",
      "[class*='range' i]",
      "[class*='date-picker' i]"
    ].join(",")));
    const labels = [];
    for (const element of controls.slice(0, 500)) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || !element.getClientRects().length) continue;
      const text = normalize(element.textContent);
      const ariaLabel = normalize(element.getAttribute("aria-label"));
      const title = normalize(element.getAttribute("title"));
      const metadata = normalize(`${ariaLabel} ${title} ${element.getAttribute("class") || ""}`);
      const isRelevant = /\b(?:time|date)[-_ ]?range\b|range-header|date-picker/i.test(metadata)
        || /^(?:last|past|previous)\s+\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)$/i.test(text);
      if (!isRelevant) continue;
      const label = (ariaLabel || title || text).slice(0, 100);
      if (label && !labels.includes(label)) labels.push(label);
      if (labels.length >= 10) break;
    }
    return {
      path: `${location.pathname}${location.search}`.slice(0, 300),
      title: normalize(document.title).slice(0, 120),
      controls: labels
    };
  }).catch(() => ({ path: "<unavailable>", title: "<unavailable>", controls: [] }));
}

async function findIncidentSearchInput(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const inputs = page.locator('input[placeholder="Search in incidents" i]');

  do {
    const selection = await inputs.evaluateAll((elements) => {
      const candidates = [];
      for (let index = 0; index < Math.min(elements.length, 50); index += 1) {
        const element = elements[index];
        const style = getComputedStyle(element);
        const visible = style.display !== "none"
          && style.visibility !== "hidden"
          && style.visibility !== "collapse"
          && element.getClientRects().length > 0;
        if (!visible || element.disabled || element.readOnly) continue;

        let score = 0;
        let rejected = false;
        let current = element;
        while (current) {
          const id = String(current.id || "").toLowerCase();
          const className = String(current.className || "").toLowerCase();
          if (className.includes("header-search-input")
            || className.includes("xsoar-header-border-bottom")) {
            rejected = true;
            break;
          }
          if (id === "incidents-page") score += 100;
          if (className.split(/\s+/).includes("incidents-page")) score += 80;
          if (className.includes("details-view-search-content")) score += 60;
          if (className.includes("filters-header-search")) score += 50;
          if (className.includes("demisto-table-search-container")) score += 40;

          if (current.parentElement) {
            current = current.parentElement;
          } else {
            const root = current.getRootNode?.();
            current = root?.host || null;
          }
        }
        if (!rejected) candidates.push({ index, score });
      }

      const scoped = candidates.filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index);
      if (scoped.length) {
        if (scoped.length > 1 && scoped[0].score === scoped[1].score) {
          return { index: -1, error: "Multiple equally plausible Incidents table search inputs were visible." };
        }
        return { index: scoped[0].index, error: "" };
      }
      if (candidates.length === 1) return { index: candidates[0].index, error: "" };
      if (candidates.length > 1) {
        return { index: -1, error: "Multiple unscoped incident search inputs were visible." };
      }
      return { index: -1, error: "" };
    }).catch(() => ({ index: -1, error: "" }));

    if (selection.error) throw new Error(selection.error);
    if (selection.index >= 0) return inputs.nth(selection.index);
    const remaining = deadline - Date.now();
    if (remaining > 0) await page.waitForTimeout(Math.min(100, remaining));
  } while (Date.now() < deadline);

  throw new Error(
    `XSOAR did not expose a visible Incidents table search input within ${timeoutMs} ms.`
  );
}

async function ensureTimeRange(page, expectedLabel, timeoutMs, searchRequestUrlPattern = "") {
  const range = await findVisibleTimeRangeControl(page, expectedLabel, timeoutMs);
  if (await timeRangeControlMatches(range, expectedLabel)) return;

  try {
    await range.click();
    const option = page.getByText(expectedLabel, { exact: true }).last();
    await option.waitFor({ state: "visible", timeout: timeoutMs });
    await beginSearchProbe(page, [], searchRequestUrlPattern);
    await option.click();
    const selectedRange = await findVisibleTimeRangeControl(page, expectedLabel, timeoutMs);
    const selectionDeadline = Date.now() + timeoutMs;
    while (!(await timeRangeControlMatches(selectedRange, expectedLabel)) && Date.now() < selectionDeadline) {
      await page.waitForTimeout(Math.min(100, Math.max(1, selectionDeadline - Date.now())));
    }
    if (!(await timeRangeControlMatches(selectedRange, expectedLabel))) {
      throw new Error(`XSOAR's selected time range did not become "${expectedLabel}" within ${timeoutMs} ms.`);
    }
    await waitForSubmittedSearch(page, timeoutMs, "time-range refresh", {
      allowUnchangedAtDeadline: true
    });
  } catch (error) {
    await clearSearchProbe(page);
    throw error;
  }
}

async function waitForIncidentReady(page, timeoutMs, options = {}) {
  const started = Date.now();
  await page.locator(".header-inv-id").first().waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = started + timeoutMs;
  const requestedQuietPeriodMs = Number(options.quietPeriodMs ?? 500);
  const quietPeriodMs = Math.min(
    Number.isFinite(requestedQuietPeriodMs) && requestedQuietPeriodMs > 0
      ? requestedQuietPeriodMs
      : 500,
    timeoutMs
  );
  const completionDeadline = deadline + quietPeriodMs;
  const requiredFields = options.requiredFields || (options.requiredFieldLabels || []).map((labels) => ({ labels }));
  const requiredAnyFields = options.requiredAnyFields || [];
  const preferredFields = options.preferredFields || [];
  const requestedReadyQuietPeriodMs = Number(options.readyQuietPeriodMs ?? quietPeriodMs);
  const readyQuietPeriodMs = Math.min(
    Number.isFinite(requestedReadyQuietPeriodMs) && requestedReadyQuietPeriodMs > 0
      ? requestedReadyQuietPeriodMs
      : quietPeriodMs,
    quietPeriodMs
  );
  let previousFingerprint = "";
  let unchangedSince = Date.now();
  let lastState;

  while (Date.now() < completionDeadline) {
    const state = await page.evaluate(({ fieldRequirements, requiredAnyRequirements, preferredRequirements }) => {
      const isVisible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wrappers = Array.from(document.querySelectorAll(".field-wrapper"));
      const hasFieldValue = (wrapper) => {
        const root = wrapper.querySelector(".value-wrapper") || wrapper;
        const preferredSelectors = [
          ".text-field-display-value",
          ".date-display-value",
          ".single-select-field-wrapper__single-value",
          "[class*='singleValue']",
          ".markdown",
          ".preplacer"
        ];
        for (const selector of preferredSelectors) {
          const element = root.querySelector(selector);
          const value = normalize(element?.getAttribute("title") || element?.textContent);
          if (value && !/^(edit|clear|select)$/.test(value)) return true;
        }
        const clone = root.cloneNode(true);
        clone.querySelectorAll("label,button,input,textarea,select,svg,object,.resize-sensor,.xdr-sr-only")
          .forEach((element) => element.remove());
        const fallback = normalize(clone.getAttribute?.("title") || clone.textContent);
        return Boolean(fallback && !/^(edit|clear|select)$/.test(fallback));
      };
      const matchingWrappers = (requirement) => wrappers.filter((candidate) => {
        const label = candidate.querySelector("label");
        const actual = label
          ? [label.getAttribute("title"), label.textContent].map(normalize).filter(Boolean)
          : [];
        const exactLabels = (requirement.labels || []).map(normalize);
        const fragments = (requirement.includes || []).map(normalize);
        const requiredFragments = (requirement.includesAll || []).map(
          (group) => group.map(normalize)
        );
        const labelMatches = actual.some((candidateLabel) => exactLabels.includes(candidateLabel)
          || fragments.some((fragment) => candidateLabel.includes(fragment))
          || requiredFragments.some((group) => group.every((fragment) => candidateLabel.includes(fragment))));
        const unlabeledMatches = !label && (requirement.unlabeledSelectors || []).some(
          (selector) => candidate.matches(selector) || candidate.querySelector(selector)
        );
        return labelMatches || unlabeledMatches;
      });
      const evaluateRequirements = (requirements) => {
        const matched = [];
        let ready = true;
        for (const requirement of requirements) {
          const matches = matchingWrappers(requirement);
          matched.push(...matches);
          if (!matches.some(hasFieldValue)) ready = false;
        }
        return { matched, ready };
      };
      const required = evaluateRequirements(fieldRequirements);
      const requiredAny = evaluateRequirements(requiredAnyRequirements);
      requiredAny.ready = requiredAnyRequirements.length > 0
        && requiredAny.matched.some(hasFieldValue);
      const preferred = evaluateRequirements(preferredRequirements);
      const relevantWrappers = fieldRequirements.length || requiredAnyRequirements.length || preferredRequirements.length
        ? [...new Set([...required.matched, ...requiredAny.matched, ...preferred.matched])]
        : wrappers;
      const busySelector = ".loading-spinner,.spinner,[aria-busy='true']";
      return {
        busy: relevantWrappers.some((wrapper) => (wrapper.matches(busySelector) && isVisible(wrapper))
          || Array.from(wrapper.querySelectorAll(busySelector)).some(isVisible)),
        wrapperCount: wrappers.length,
        requiredReady: required.ready,
        requiredAnyReady: requiredAny.ready,
        preferredReady: preferredRequirements.length > 0 && preferred.ready,
        fingerprint: relevantWrappers
          .map((wrapper) => `${wrapper.querySelector("label")?.textContent || ""}|${wrapper.textContent || ""}`)
          .join("\n")
      };
    }, {
      fieldRequirements: requiredFields,
      requiredAnyRequirements: requiredAnyFields,
      preferredRequirements: preferredFields
    });
    lastState = state;
    if (state.fingerprint !== previousFingerprint) {
      previousFingerprint = state.fingerprint;
      unchangedSince = Date.now();
    }
    const hasRequiredFields = requiredFields.length > 0 || requiredAnyFields.length > 0;
    const requiredSatisfied = hasRequiredFields
      ? (!requiredFields.length || state.requiredReady)
        && (!requiredAnyFields.length || state.requiredAnyReady)
      : state.wrapperCount > 0;
    const targetQuietPeriodMs = state.preferredReady ? readyQuietPeriodMs : quietPeriodMs;
    if (!state.busy && requiredSatisfied && Date.now() - unchangedSince >= targetQuietPeriodMs) return;
    await page.waitForTimeout(100);
  }
  const finalQuietPeriodMs = lastState?.preferredReady ? readyQuietPeriodMs : quietPeriodMs;
  if (lastState?.busy || Date.now() - unchangedSince < finalQuietPeriodMs) {
    throw new Error(`XSOAR incident fields did not finish loading within ${timeoutMs} ms.`);
  }
  // The page is settled but required fields are genuinely absent; the caller
  // reports them as missing instead of treating a slow field as ready early.
}

function expectedSearchResult(payload, depth = 0) {
  if (!payload || typeof payload !== "object" || depth > 4) return null;
  if (Array.isArray(payload.data) && Number.isInteger(Number(payload.total)) && Number(payload.total) >= 0) {
    const ticketIds = payload.data.map((item) => cleanText(
      item?.id ?? item?.numericId ?? item?.investigationId
    )).filter(Boolean);
    if (ticketIds.length === payload.data.length) {
      return { total: Number(payload.total), ticketIds };
    }
  }
  for (const value of Object.values(payload)) {
    const result = expectedSearchResult(value, depth + 1);
    if (result) return result;
  }
  return null;
}

function resultStateMatchesResponse(state, expected, allowVisibleSubset = false) {
  if (!state || !expected || state.reportedTotal !== expected.total) return false;
  const actualIds = [...state.ticketIds].sort();
  const expectedIds = [...expected.ticketIds].sort();
  if (expected.total === 0) return actualIds.length === 0 && expectedIds.length === 0;
  if (allowVisibleSubset) {
    return actualIds.length > 0
      && actualIds.every((ticketId) => expectedIds.includes(ticketId));
  }
  return actualIds.length === expectedIds.length
    && actualIds.every((ticketId, index) => ticketId === expectedIds[index]);
}

async function beginSearchProbe(page, requestMarkers = [], requestUrlPattern = "") {
  await clearSearchProbe(page);
  const normalizedMarkers = requestMarkers.flatMap((marker) => {
    const value = String(marker);
    return [value, JSON.stringify(value).slice(1, -1)];
  }).map((marker) => marker.toLowerCase()).filter(Boolean);
  const networkProbe = {
    pendingCandidates: new Set(),
    attempts: new Map(),
    latestSettledCandidate: null,
    nextCandidateId: 1,
    sawMarkerRequest: false,
    requiresCandidate: Boolean(requestUrlPattern && normalizedMarkers.length)
  };
  const urlPattern = requestUrlPattern ? new RegExp(requestUrlPattern, "i") : null;
  const isTrackedRequest = (request) => ["fetch", "xhr"].includes(request.resourceType());
  const requestDetails = (request) => {
    let requestPath = request.url();
    try {
      const url = new URL(request.url());
      requestPath = `${url.pathname}${url.search}`;
    } catch {}
    const configuredPath = Boolean(urlPattern?.test(requestPath));
    if (!normalizedMarkers.length) return { configuredPath, marker: configuredPath, requestPath };
    const searchable = new Set();
    const visit = (value, depth = 0) => {
      if (depth > 4 || value === null || value === undefined) return;
      if (typeof value === "string") {
        if (searchable.has(value.toLowerCase())) return;
        searchable.add(value.toLowerCase());
        let decoded = value;
        try { decoded = decodeURIComponent(value); } catch {}
        if (decoded !== value) visit(decoded, depth + 1);
        try { visit(JSON.parse(value), depth + 1); } catch {}
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof value === "object") Object.values(value).forEach((item) => visit(item, depth + 1));
    };
    visit(request.url());
    visit(request.postData() || "");
    return {
      configuredPath,
      marker: normalizedMarkers.some((marker) => [...searchable].some((candidate) => candidate.includes(marker))),
      requestPath
    };
  };
  networkProbe.onRequest = (request) => {
    if (!isTrackedRequest(request)) return;
    const details = requestDetails(request);
    if (!details.marker) return;
    networkProbe.sawMarkerRequest = true;
    const semanticSearchPath = /(?:incident|investigation)[^?#/]*.*search|search.*(?:incident|investigation)/i
      .test(details.requestPath);
    networkProbe.attempts.set(request, {
      id: networkProbe.nextCandidateId,
      trustedPath: details.configuredPath || semanticSearchPath,
      responseAt: 0,
      responseOk: false,
      expectedResult: null
    });
    networkProbe.nextCandidateId += 1;
    networkProbe.pendingCandidates.add(request);
  };
  networkProbe.onResponse = (response) => {
    const attempt = networkProbe.attempts.get(response.request());
    if (!attempt) return;
    attempt.responseAt = Date.now();
    attempt.responseOk = response.ok();
  };
  networkProbe.onFinished = async (request) => {
    if (!networkProbe.pendingCandidates.has(request)) return;
    const attempt = networkProbe.attempts.get(request);
    if (!attempt) return;
    const response = await request.response().catch(() => null);
    if (!attempt.responseAt) {
      attempt.responseAt = Date.now();
      attempt.responseOk = Boolean(response?.ok());
    }
    if (attempt.responseOk) {
      const payload = await response?.json().catch(() => null);
      attempt.expectedResult = expectedSearchResult(payload);
    }
    networkProbe.pendingCandidates.delete(request);
    if (!attempt.trustedPath && !attempt.expectedResult) return;
    const settled = {
      id: attempt.id,
      ok: attempt.responseOk,
      responseAt: attempt.responseAt,
      settledAt: Date.now(),
      expectedResult: attempt.expectedResult
    };
    if (!networkProbe.latestSettledCandidate
      || settled.id > networkProbe.latestSettledCandidate.id) {
      networkProbe.latestSettledCandidate = settled;
    }
  };
  networkProbe.onFailed = (request) => {
    if (!networkProbe.pendingCandidates.delete(request)) return;
    const attempt = networkProbe.attempts.get(request);
    if (!attempt) return;
    if (!attempt.trustedPath) return;
    const settled = {
      id: attempt.id,
      ok: false,
      responseAt: Date.now(),
      settledAt: Date.now()
    };
    if (!networkProbe.latestSettledCandidate
      || settled.id > networkProbe.latestSettledCandidate.id) {
      networkProbe.latestSettledCandidate = settled;
    }
  };
  page.on("request", networkProbe.onRequest);
  page.on("response", networkProbe.onResponse);
  page.on("requestfinished", networkProbe.onFinished);
  page.on("requestfailed", networkProbe.onFailed);
  searchNetworkProbes.set(page, networkProbe);

  await page.evaluate(({ resultRootSelector, ticketLinkSelector }) => {
    const findResultRoot = () => document.querySelector(resultRootSelector)
      || document.querySelector(".table-paging-message")?.parentElement
      || document.querySelector("#incidents-page")
      || document.body;
    const fingerprint = () => JSON.stringify({
      empty: Array.from(document.querySelectorAll(".no-data,.empty-table,.no-results"))
        .map((element) => element.textContent?.trim() || ""),
      paging: document.querySelector(".table-paging-message")?.textContent?.trim() || "",
      tickets: Array.from(findResultRoot().querySelectorAll(ticketLinkSelector))
        .map((link) => `${link.getAttribute("href") || ""}|${link.textContent?.trim() || ""}`)
    });
    const probe = {
      findResultRoot,
      fingerprint,
      initialFingerprint: fingerprint(),
      resultMutations: 0,
      startedAt: performance.now(),
      lastResultMutationElapsedMs: 0,
      observer: null,
      sawBusy: false
    };
    probe.observer = new MutationObserver((records) => {
      const currentRoot = findResultRoot();
      if (records.some((record) => currentRoot.contains(record.target)
        || Array.from(record.addedNodes).some((node) => node.nodeType === 1
          && node instanceof Element
          && (node.matches(resultRootSelector) || node.querySelector(resultRootSelector))))) {
        probe.resultMutations += 1;
        probe.lastResultMutationElapsedMs = performance.now() - probe.startedAt;
      }
    });
    probe.observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    const windowWithProbe = /** @type {Window & {__xsoarAssistantSearchProbe?: typeof probe}} */ (window);
    windowWithProbe.__xsoarAssistantSearchProbe = probe;
  }, { resultRootSelector: RESULT_ROOT_SELECTOR, ticketLinkSelector: RESULT_TICKET_LINK_SELECTOR });
}

async function waitForSubmittedSearch(page, timeoutMs, operation = "submitted search", options = {}) {
  try {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const quietPeriodMs = options.quietPeriodMs ?? 500;
    const quietCheckDeadline = deadline + quietPeriodMs;
    const readState = () => page.evaluate((ticketLinkSelector) => {
        const windowWithProbe = /** @type {Window & {__xsoarAssistantSearchProbe?: any}} */ (window);
        const probe = windowWithProbe.__xsoarAssistantSearchProbe;
        if (!probe) return null;
        const isVisible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
        const resultRoot = probe.findResultRoot();
        const busySelector = ".loading-spinner,.spinner,.table-loader:not(:empty),[aria-busy='true']";
        const busy = (resultRoot.matches(busySelector) && isVisible(resultRoot))
          || Array.from(resultRoot.querySelectorAll(busySelector)).some(isVisible);
        if (busy) probe.sawBusy = true;
        const pagingText = document.querySelector(".table-paging-message")?.textContent?.trim() || "";
        const totalMatch = pagingText.match(/out of\s+([\d,]+)/i);
        const ticketIds = Array.from(resultRoot.querySelectorAll(ticketLinkSelector))
          .map((link) => (link.textContent || "").match(/\d+/)?.[0]
            || (link.getAttribute("href") || "").match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1])
          .filter(Boolean);
        const noResults = Boolean(document.querySelector(".no-data,.empty-table,.no-results"));
        const rangeMatch = pagingText.match(/showing incidents\s+([\d,]+)\s+to\s+([\d,]+)\s+out of\s+([\d,]+)/i);
        const firstDisplayed = Number(rangeMatch?.[1]?.replace(/,/g, ""));
        const lastDisplayed = Number(rangeMatch?.[2]?.replace(/,/g, ""));
        const displayedCount = Number.isFinite(firstDisplayed) && Number.isFinite(lastDisplayed)
          ? Math.max(0, lastDisplayed - firstDisplayed + 1)
          : null;
        const grid = resultRoot.matches("[role='grid'][aria-rowcount]")
          ? resultRoot
          : resultRoot.querySelector("[role='grid'][aria-rowcount]");
        const virtualized = resultRoot.matches(".fixedDataTableLayout_main")
          || Boolean(resultRoot.querySelector(".fixedDataTableLayout_rowsContainer"));
        const ariaDataRows = grid
          ? Math.max(0, Number(grid.getAttribute("aria-rowcount")) - 1)
          : 0;
        const renderedTicketCount = new Set(ticketIds).size;
        const complete = (noResults && Number(totalMatch?.[1]?.replace(/,/g, "")) === 0)
          || (displayedCount !== null && displayedCount > 0
            && (renderedTicketCount >= displayedCount
              || (virtualized && ariaDataRows >= displayedCount)));
        return {
          busy,
          changed: probe.fingerprint() !== probe.initialFingerprint,
          complete,
          lastResultMutationElapsedMs: probe.lastResultMutationElapsedMs,
          resultQuietMs: performance.now() - probe.startedAt - probe.lastResultMutationElapsedMs,
          resultMutations: probe.resultMutations,
          reportedTotal: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : (noResults ? 0 : null),
          ticketIds,
          sawBusy: probe.sawBusy,
          terminal: Boolean(document.querySelector(".table-paging-message,.no-data,.empty-table,.no-results")
            || resultRoot.querySelector(ticketLinkSelector))
        };
      }, RESULT_TICKET_LINK_SELECTOR);
    while (Date.now() < quietCheckDeadline) {
      const state = await readState();
      const networkProbe = searchNetworkProbes.get(page);
      const candidatePending = (networkProbe?.pendingCandidates.size || 0) > 0;
      const candidate = networkProbe?.latestSettledCandidate;
      const completeQuietPeriodMs = options.completeQuietPeriodMs ?? Math.min(300, quietPeriodMs);
      if (options.allowChangedDomFallbackAtDeadline && !networkProbe?.sawMarkerRequest
        && state?.changed && state.complete && state.terminal && !state.busy
        && state.resultQuietMs >= completeQuietPeriodMs) {
        return { expectedResult: null };
      }
      if (networkProbe?.requiresCandidate && candidate?.ok && !candidatePending
        && candidate.settledAt <= deadline && state?.terminal && !state.busy
        && resultStateMatchesResponse(state, candidate.expectedResult)
        && state.resultQuietMs >= quietPeriodMs
        && Date.now() - candidate.settledAt >= quietPeriodMs) {
        return { expectedResult: candidate.expectedResult };
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, quietCheckDeadline - Date.now())));
    }

    const state = await readState();
    const networkProbe = searchNetworkProbes.get(page);
    const candidatePending = (networkProbe?.pendingCandidates.size || 0) > 0;
    const candidate = networkProbe?.latestSettledCandidate;
    const requiresCandidate = Boolean(networkProbe?.requiresCandidate);
    const changedByDeadline = Boolean(state?.changed)
      && state.lastResultMutationElapsedMs <= timeoutMs;
    const candidateSucceededByDeadline = Boolean(candidate?.ok)
      && candidate.settledAt <= deadline;
    const changedDomFallback = Boolean(options.allowChangedDomFallbackAtDeadline)
      && !networkProbe?.sawMarkerRequest
      && changedByDeadline;
    const hasActionEvidence = requiresCandidate
      ? (candidateSucceededByDeadline && (candidate.expectedResult
          ? resultStateMatchesResponse(state, candidate.expectedResult, true)
          : changedByDeadline)) || changedDomFallback
      : changedByDeadline || options.allowUnchangedAtDeadline;
    const responseQuietMs = requiresCandidate && candidate?.ok
      ? Date.now() - candidate.settledAt
      : quietPeriodMs;
    if (!state || (requiresCandidate && candidatePending)
      || state.lastResultMutationElapsedMs > timeoutMs
      || !hasActionEvidence || !state.terminal || state.busy
      || state.resultQuietMs < quietPeriodMs || responseQuietMs < quietPeriodMs) {
      throw new Error("result update timed out");
    }
    return {
      expectedResult: requiresCandidate && candidateSucceededByDeadline
        ? candidate?.expectedResult || null
        : null
    };
  } catch (error) {
    throw new Error(`XSOAR did not confirm that the ${operation} updated the results within ${timeoutMs} ms.`, {
      cause: error
    });
  } finally {
    await clearSearchProbe(page);
  }
}

async function waitForSearchToSettle(page, timeoutMs) {
  await page.waitForFunction(({ resultRootSelector, ticketLinkSelector }) => {
    const isVisible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const resultRoot = document.querySelector(resultRootSelector)
      || document.querySelector(".table-paging-message")?.parentElement
      || document.querySelector("#incidents-page")
      || document.body;
    const busySelector = ".loading-spinner,.spinner,.table-loader:not(:empty),[aria-busy='true']";
    const spinner = (resultRoot.matches(busySelector) && isVisible(resultRoot))
      || Array.from(resultRoot.querySelectorAll(busySelector)).some(isVisible);
    const summary = document.querySelector(".table-paging-message");
    const empty = document.querySelector(".no-data,.empty-table,.no-results");
    return !spinner && Boolean(summary || empty || resultRoot.querySelector(ticketLinkSelector));
  }, { resultRootSelector: RESULT_ROOT_SELECTOR, ticketLinkSelector: RESULT_TICKET_LINK_SELECTOR }, { timeout: timeoutMs });

  let previous = "";
  let stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stable < 2) {
    const snapshot = await page.evaluate(({ resultRootSelector, ticketLinkSelector }) => {
      const root = document.querySelector(resultRootSelector)
        || document.querySelector(".table-paging-message")?.parentElement
        || document.querySelector("#incidents-page")
        || document.body;
      const summary = document.querySelector(".table-paging-message")?.textContent?.trim() || "";
      const tickets = Array.from(root.querySelectorAll(ticketLinkSelector))
        .map((link) => `${link.getAttribute("href") || ""}|${link.textContent?.trim() || ""}`)
        .join("\n");
      return `${summary}|${tickets}`;
    }, { resultRootSelector: RESULT_ROOT_SELECTOR, ticketLinkSelector: RESULT_TICKET_LINK_SELECTOR });
    if (snapshot === previous) stable += 1;
    else stable = 0;
    previous = snapshot;
    await page.waitForTimeout(250);
  }
  if (stable < 2) {
    throw new Error(`XSOAR search results did not stabilize within ${timeoutMs} ms.`);
  }
}

async function collectCurrentResultPage(
  page,
  timeoutMs,
  ticketLimit = Number.POSITIVE_INFINITY,
  excludedTicketId = ""
) {
  const tickets = new Map();
  const usableTicketCount = () => tickets.size - (excludedTicketId && tickets.has(excludedTicketId) ? 1 : 0);
  const grid = page.locator("[role='grid'][aria-rowcount]").first();
  const ariaRowCount = await grid.count()
    ? Number(await grid.getAttribute("aria-rowcount").catch(() => 0))
    : 0;
  const expectedRows = ariaRowCount > 0 ? Math.max(0, ariaRowCount - 1) : null;
  let resultRoot = grid;
  if (!(await resultRoot.count())) resultRoot = page.locator(".fixedDataTableLayout_main").first();
  if (!(await resultRoot.count())) {
    const summary = page.locator(".table-paging-message").first();
    if (await summary.count()) resultRoot = summary.locator("xpath=..");
  }
  const ticketLinks = await resultRoot.count()
    ? resultRoot.locator(RESULT_TICKET_LINK_SELECTOR)
    : page.locator("#incidents-page").locator(RESULT_TICKET_LINK_SELECTOR);
  const rowsContainer = await resultRoot.count()
    ? resultRoot.locator(".fixedDataTableLayout_rowsContainer").first()
    : page.locator(".fixedDataTableLayout_rowsContainer").first();
  let previousHighestIndex = 0;
  let stagnantScrolls = 0;
  const maxScrolls = expectedRows === null ? 1 : Math.max(3, expectedRows + 2);

  if (await rowsContainer.count() && await rowsContainer.isVisible().catch(() => false)) {
    await rowsContainer.evaluate((element) => { element.scrollTop = 0; });
    await rowsContainer.hover();
    await page.mouse.wheel(0, -100000);
    await page.waitForTimeout(100);
  }

  for (let attempt = 0; attempt < maxScrolls; attempt += 1) {
    const rows = await ticketLinks.evaluateAll((links) => links.map((link) => ({
      text: link.textContent || "",
      href: link.getAttribute("href") || ""
    })));
    for (const row of rows) {
      const ticketId = row.text.match(/\d+/)?.[0] || row.href.match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1];
      if (ticketId) tickets.set(ticketId, { ticketId, href: row.href });
      if (usableTicketCount() >= ticketLimit) break;
    }

    const visibleIndices = await resultRoot.locator(".public_fixedDataTable_bodyRow[aria-rowindex]")
      .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("aria-rowindex")) || 0));
    const highestIndex = Math.max(0, ...visibleIndices);
    if (usableTicketCount() >= ticketLimit
      || expectedRows === null
      || tickets.size >= expectedRows
      || highestIndex >= ariaRowCount) break;
    if (!(await rowsContainer.count()) || !(await rowsContainer.isVisible().catch(() => false))) break;

    await rowsContainer.hover();
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(({ priorIndex, resultRootSelector }) => {
      const root = document.querySelector(resultRootSelector) || document.body;
      const indices = Array.from(root.querySelectorAll(".public_fixedDataTable_bodyRow[aria-rowindex]"))
        .map((row) => Number(row.getAttribute("aria-rowindex")) || 0);
      return Math.max(0, ...indices) > priorIndex;
    }, { priorIndex: highestIndex, resultRootSelector: RESULT_ROOT_SELECTOR }, {
      timeout: Math.min(timeoutMs, 1500)
    }).catch(() => {});

    const nextHighestIndex = await resultRoot.locator(".public_fixedDataTable_bodyRow[aria-rowindex]")
      .evaluateAll((rows) => Math.max(0, ...rows.map((row) => Number(row.getAttribute("aria-rowindex")) || 0)));
    stagnantScrolls = nextHighestIndex <= previousHighestIndex ? stagnantScrolls + 1 : 0;
    previousHighestIndex = nextHighestIndex;
    if (stagnantScrolls >= 2) break;
  }

  return {
    expectedRows,
    complete: expectedRows === null || tickets.size >= expectedRows,
    tickets: Array.from(tickets.values())
  };
}

async function ensureNewestFirst(page, timeoutMs) {
  const resultRoot = page.locator(RESULT_ROOT_SELECTOR).first();
  const readSortState = async () => resultRoot.evaluate((root, ticketLinkSelector) => {
    const ticketIds = Array.from(root.querySelectorAll(ticketLinkSelector))
      .map((link) => (link.textContent || "").match(/\d+/)?.[0]
        || (link.getAttribute("href") || "").match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1])
      .filter(Boolean);
    const header = root.querySelector("[role='columnheader'] .header-label[title='ID']");
    const column = header?.closest("[role='columnheader']") || header;
    const headerState = [
      column?.getAttribute("aria-sort"),
      column?.getAttribute("class"),
      column?.getAttribute("title"),
      header?.getAttribute("class"),
      header?.getAttribute("title"),
      ...Array.from(column?.querySelectorAll("svg,i,[class*='sort' i],[class*='arrow' i]") || [])
        .flatMap((element) => [element.getAttribute("class"), element.getAttribute("title"), element.getAttribute("aria-label")])
    ].filter(Boolean).join(" ").toLowerCase();
    const direction = /(?:descending|desc\b|sort[-_ ]?down|arrow[-_ ]?down)/i.test(headerState)
      ? "descending"
      : (/(?:ascending|asc\b|sort[-_ ]?up|arrow[-_ ]?up)/i.test(headerState) ? "ascending" : "unknown");
    const uniqueIds = [...new Set(ticketIds)];
    return {
      ticketIds: uniqueIds,
      direction,
      fingerprint: JSON.stringify({ ticketIds: uniqueIds, headerState })
    };
  }, RESULT_TICKET_LINK_SELECTOR);
  const isDescending = (ticketIds) => ticketIds.length <= 1 || ticketIds.every(
    (ticketId, index) => index === 0 || BigInt(ticketIds[index - 1]) >= BigInt(ticketId)
  );

  const initialState = await readSortState();
  const summary = cleanText(await page.locator(".table-paging-message").first().textContent().catch(() => ""));
  const reportedTotal = Number(summary.match(/out of\s+([\d,]+)/i)?.[1]?.replace(/,/g, "") || 0);
  let sampledIds = initialState.ticketIds;
  let sampleComplete = sampledIds.length >= Math.min(reportedTotal, 5);
  if (reportedTotal > sampledIds.length && reportedTotal > 1) {
    const sample = await collectCurrentResultPage(page, timeoutMs, Math.min(reportedTotal, 5));
    sampledIds = sample.tickets.map((ticket) => ticket.ticketId);
    sampleComplete = sample.complete || sampledIds.length >= Math.min(reportedTotal, 5);
  }
  if (sampledIds.length > 1 && sampleComplete && isDescending(sampledIds)) return false;
  if (sampledIds.length <= 1 && reportedTotal <= 1) return false;

  const headers = resultRoot.locator("[role='columnheader'] .header-label[title='ID']");
  let idHeader = null;
  for (let index = 0; index < await headers.count(); index += 1) {
    const candidate = headers.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      idHeader = candidate;
      break;
    }
  }
  if (!idHeader) {
    throw new Error("XSOAR did not expose the visible ID column needed to select the newest incidents.");
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = await readSortState();
    await idHeader.click();
    const deadline = Date.now() + timeoutMs;
    const retryQuietPeriodMs = Math.min(700, Math.max(100, Math.floor(timeoutMs * 0.7)));
    const successQuietPeriodMs = Math.min(200, retryQuietPeriodMs);
    let latestFingerprint = before.fingerprint;
    let lastChangeAt = Date.now();
    let changed = false;

    while (Date.now() < deadline) {
      const state = await readSortState();
      if (state.fingerprint !== latestFingerprint) {
        latestFingerprint = state.fingerprint;
        lastChangeAt = Date.now();
        changed = true;
      }
      const quietForMs = Date.now() - lastChangeAt;
      if (changed && quietForMs >= successQuietPeriodMs) {
        if (state.ticketIds.length > 1 && isDescending(state.ticketIds)) return true;
        if (state.ticketIds.length <= 1 && reportedTotal > 1) {
          const sample = await collectCurrentResultPage(page, timeoutMs, Math.min(reportedTotal, 5));
          const sampleIds = sample.tickets.map((ticket) => ticket.ticketId);
          if (sampleIds.length > 1 && isDescending(sampleIds)) return true;
          if (sampleIds.length <= 1 && state.direction === "descending") return true;
        }
        if (quietForMs >= retryQuietPeriodMs) break;
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    if (!changed) {
      throw new Error(`XSOAR did not confirm that the ID sort action updated the results within ${timeoutMs} ms.`);
    }
  }

  throw new Error("XSOAR did not place incident IDs in newest-first order after sorting the ID column.");
}

async function collectSearchResults(
  page,
  currentTicketId,
  excludeCurrentTicket,
  timeoutMs,
  paginationTimeoutMs = timeoutMs,
  searchRequestUrlPattern = "",
  expectedInitialResult = null,
  maxHistoricalIncidents = Number.POSITIVE_INFINITY,
  initialResultsConfirmed = false
) {
  const ticketLimit = Number.isInteger(maxHistoricalIncidents) && maxHistoricalIncidents > 0
    ? maxHistoricalIncidents
    : Number.POSITIVE_INFINITY;
  const tickets = new Map();
  const rawTickets = new Map();
  let rawMatches = 0;
  let sawCurrentTicket = false;
  let pageGuard = 0;
  let resultsAlreadyConfirmed = Boolean(initialResultsConfirmed);
  let collectionIncomplete = false;

  while (pageGuard < 100) {
    pageGuard += 1;
    if (!resultsAlreadyConfirmed) await waitForSearchToSettle(page, timeoutMs);
    resultsAlreadyConfirmed = false;
    const summary = cleanText(await page.locator(".table-paging-message").first().textContent().catch(() => ""));
    const total = Number(summary.match(/out of\s+([\d,]+)/i)?.[1]?.replace(/,/g, "") || 0);
    rawMatches = Math.max(rawMatches, total);

    const remainingTicketLimit = Number.isFinite(ticketLimit)
      ? Math.max(0, ticketLimit - tickets.size)
      : Number.POSITIVE_INFINITY;
    const currentPage = await collectCurrentResultPage(
      page,
      timeoutMs,
      remainingTicketLimit,
      excludeCurrentTicket ? currentTicketId : ""
    );
    for (const row of currentPage.tickets) {
      rawTickets.set(row.ticketId, row.href);
      if (excludeCurrentTicket && row.ticketId === currentTicketId) {
        sawCurrentTicket = true;
        continue;
      }
      if (tickets.size < ticketLimit) tickets.set(row.ticketId, row.href);
    }

    const reachedTicketLimit = Number.isFinite(ticketLimit) && tickets.size >= ticketLimit;
    if (!currentPage.complete && !reachedTicketLimit) {
      if (Number.isFinite(ticketLimit)) {
        collectionIncomplete = true;
        break;
      }
      throw new Error(
        `XSOAR rendered only ${currentPage.tickets.length} of ${currentPage.expectedRows} result rows on the current page.`
      );
    }
    if (reachedTicketLimit) break;

    const next = page.locator(".paging-next:not(.disabled)").first();
    if (!(await next.count()) || !(await next.isVisible().catch(() => false))) break;
    if (pageGuard >= 100) throw new Error("Search pagination exceeded the 100-page safety limit.");
    await beginSearchProbe(page, [], searchRequestUrlPattern);
    try {
      await next.click();
      await waitForSubmittedSearch(page, paginationTimeoutMs, "pagination action", {
        quietPeriodMs: Math.min(100, Math.max(10, Math.floor(paginationTimeoutMs / 2)))
      });
      resultsAlreadyConfirmed = true;
    } catch (error) {
      await clearSearchProbe(page);
      throw error;
    }
  }

  if (!rawMatches) rawMatches = tickets.size + (excludeCurrentTicket && sawCurrentTicket ? 1 : 0);
  const matches = Math.max(0, rawMatches - (excludeCurrentTicket && sawCurrentTicket ? 1 : 0));
  const collectionLimited = tickets.size < matches && tickets.size >= Math.min(matches, ticketLimit);
  if (expectedInitialResult) {
    const expectedTicketIds = new Set(expectedInitialResult.ticketIds);
    const unexpectedCollectedIds = Array.from(rawTickets.keys())
      .filter((ticketId) => !expectedTicketIds.has(ticketId));
    const missingExpectedIds = collectionLimited || collectionIncomplete
      ? []
      : expectedInitialResult.ticketIds.filter((ticketId) => !rawTickets.has(ticketId));
    if (rawMatches !== expectedInitialResult.total
      || unexpectedCollectedIds.length
      || missingExpectedIds.length) {
      throw new Error(
        `XSOAR's search response did not match the collected ticket IDs/count.`
      );
    }
  }
  const requiredTicketCount = Math.min(matches, ticketLimit);
  if (!Number.isFinite(ticketLimit) && tickets.size !== requiredTicketCount) {
    throw new Error(
      `XSOAR reported ${matches} matches, but ${tickets.size} of the required ${requiredTicketCount} ticket IDs were collected.`
    );
  }
  collectionIncomplete ||= tickets.size < requiredTicketCount;
  return {
    rawMatches,
    matches,
    collectionLimited,
    collectionIncomplete,
    tickets: Array.from(tickets, ([ticketId, href]) => ({ ticketId, href }))
  };
}

async function openForegroundPage(context, url, timeoutMs, expectedOrigin = "") {
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.bringToFront();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (expectedOrigin && new URL(page.url()).origin !== expectedOrigin) {
      throw new Error("Navigation left the selected XSOAR origin.");
    }
    return page;
  } catch (error) {
    if (typeof page.close === "function") {
      await settleWithin(() => page.close(), Math.min(timeoutMs, 3000));
    }
    throw error;
  }
}

async function searchSimilarIncidents(
  context,
  incidentPage,
  incident,
  config,
  reportProgress = async (_stage, _detail) => {}
) {
  let searchPage;

  try {
    await reportProgress("discovering_incidents_route", "Finding the rendered Incidents navigation link.");
    const searchUrl = await discoverIncidentsUrl(incidentPage, config.incidentsPath);
    await reportProgress(
      "opening_search",
      "Switching to the temporary Incidents tab so XSOAR can render it."
    );
    searchPage = await openForegroundPage(
      context,
      searchUrl,
      config.navigationTimeoutMs,
      new URL(incidentPage.url()).origin
    );
    const loadedPath = new URL(searchPage.url()).pathname;
    await reportProgress("setting_time_range", `Loaded ${loadedPath}; selecting ${config.timeRangeLabel}.`);
    try {
      await ensureTimeRange(
        searchPage,
        config.timeRangeLabel,
        config.resultsTimeoutMs,
        config.searchRequestUrlPattern
      );
    } catch (error) {
      const diagnostic = await collectTimeRangeDiagnostics(searchPage);
      const controls = diagnostic.controls.length ? diagnostic.controls.join(" | ") : "<none>";
      const message = [
        error instanceof Error ? error.message : String(error),
        `Page: ${diagnostic.path}.`,
        `Title: ${diagnostic.title || "<empty>"}.`,
        `Visible date controls: ${controls}.`
      ].join(" ");
      await reportProgress("time_range_failed", message);
      throw new Error(message, { cause: error });
    }
    await reportProgress("finding_search_box", "Waiting for the Incidents table search box.");
    const input = await findIncidentSearchInput(searchPage, config.navigationTimeoutMs);
    const query = buildSearchQuery(incident.ruleName, incident.caseType);
    await reportProgress("submitting_search", "Submitting the similar-incident query.");
    let confirmation;
    const activeQuery = cleanText(await input.inputValue().catch(() => ""));
    if (activeQuery === cleanText(query)) {
      await reportProgress("waiting_for_search", "The query is already active; validating its settled results.");
      await waitForSearchToSettle(searchPage, config.resultsTimeoutMs);
      confirmation = { expectedResult: null };
    } else {
      await beginSearchProbe(searchPage, [query], config.searchRequestUrlPattern);
      try {
        await input.fill(query);
        await input.press("Enter");
        await reportProgress("waiting_for_search", "Waiting for XSOAR to confirm the submitted query.");
        confirmation = await waitForSubmittedSearch(searchPage, config.resultsTimeoutMs, "submitted search", {
          allowChangedDomFallbackAtDeadline: true
        });
      } catch (error) {
        await clearSearchProbe(searchPage);
        throw error;
      }
    }
    let sorted = false;
    if (Number.isInteger(config.maxHistoricalIncidents) && config.maxHistoricalIncidents > 0) {
      await reportProgress("sorting_results", "Sorting matching incidents newest-first by ticket ID.");
      sorted = await ensureNewestFirst(
        searchPage,
        config.resultsTimeoutMs
      );
    }
    await reportProgress("collecting_results", "Collecting and validating matching incident IDs.");
    const completeExpectedResult = confirmation.expectedResult
      && confirmation.expectedResult.ticketIds.length === confirmation.expectedResult.total
      ? confirmation.expectedResult
      : null;
    const result = await collectSearchResults(
      searchPage,
      incident.ticketId,
      config.excludeCurrentTicket,
      config.resultsTimeoutMs,
      config.paginationTimeoutMs,
      config.searchRequestUrlPattern,
      sorted ? completeExpectedResult : confirmation.expectedResult,
      config.maxHistoricalIncidents,
      true
    );
    await reportProgress(
      "search_complete",
      `Found ${result.matches} similar incident(s); selected ${result.tickets.length} for historical review.`
    );
    return {
      searchPage,
      ...result
    };
  } catch (error) {
    if (searchPage) await settleWithin(() => searchPage.close(), 3000);
    await settleWithin(() => incidentPage.bringToFront(), 3000);
    throw error;
  }
}

function buildHistoricalIncidentUrl(currentIncidentUrl, ticketId) {
  const url = new URL(currentIncidentUrl);
  if (!/\/\d+\/?$/.test(url.pathname)) {
    throw new Error("The current incident URL does not end with a numeric ticket ID.");
  }
  url.pathname = url.pathname.replace(/\/\d+\/?$/, `/${ticketId}`);
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function collectHistoricalDetails(
  context,
  currentIncidentUrl,
  tickets,
  config,
  reportProgress = async (_stage, _detail) => {}
) {
  const configuredFieldLabels = resolveFieldLabels(config.fieldLabels ?? {});
  const historical = new Array(tickets.length);
  let completed = 0;
  const configuredConcurrency = Number(config.historicalConcurrency ?? 2);
  if (!Number.isInteger(configuredConcurrency) || configuredConcurrency < 1) {
    throw new Error("historicalConcurrency must be a positive integer.");
  }
  const historicalFieldsTimeoutMs = Number(config.historicalFieldsTimeoutMs ?? 5000);
  if (!Number.isFinite(historicalFieldsTimeoutMs) || historicalFieldsTimeoutMs <= 0) {
    throw new Error("historicalFieldsTimeoutMs must be a positive number.");
  }
  const concurrency = Math.min(configuredConcurrency, tickets.length || 1);
  const historicalRecommendationFields = [
    { labels: configuredFieldLabels.closeNotes },
    { labels: configuredFieldLabels.incidentOutcome },
    {
      labels: configuredFieldLabels.descriptionLong.labels,
      unlabeledSelectors: configuredFieldLabels.descriptionLong.unlabeledSelectors
    },
    {
      labels: config.historicalSummaryLabels || [],
      includesAll: (config.historicalSummaryLabels || []).length
        ? []
        : [["historical", "summary"]]
    },
    {
      labels: config.historicalRecommendationLabels || [],
      includesAll: (config.historicalRecommendationLabels || []).length
        ? []
        : [
          ["historical", "recommendation"],
          ["customer", "recommendation"]
        ]
    }
  ];

  async function beginPreload(ticket, index) {
    const url = buildHistoricalIncidentUrl(currentIncidentUrl, ticket.ticketId);
    const page = await context.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs);
    try {
      await page.bringToFront();
      const navigation = page.goto(url, { waitUntil: "domcontentloaded" })
        .then(() => {
          if (new URL(page.url()).origin !== new URL(currentIncidentUrl).origin) {
            return new Error("Historical navigation left the selected XSOAR origin.");
          }
          return null;
        }, (error) => error);
      return { index, ticket, url, page, navigation };
    } catch (error) {
      await settleWithin(() => page.close(), 3000);
      throw error;
    }
  }

  for (let batchStart = 0; batchStart < tickets.length; batchStart += concurrency) {
    const batch = tickets.slice(batchStart, batchStart + concurrency);
    /** @type {Array<{index: number, ticket: any, url?: string, page?: import("playwright-core").Page, navigation?: Promise<Error | null>, error?: unknown}>} */
    const preloads = [];
    for (let offset = 0; offset < batch.length; offset += 1) {
      const index = batchStart + offset;
      const ticket = batch[offset];
      try {
        await reportProgress(
          "reading_history",
          `Preloading historical incident ${index + 1} of ${tickets.length}.`
        );
        preloads.push(await beginPreload(ticket, index));
      } catch (error) {
        preloads.push({ index, ticket, error });
      }
    }

    for (const preload of preloads) {
      const { index, ticket } = preload;
      const page = preload.page;
      try {
        if (preload.error) throw preload.error;
        if (!page || !preload.url || !preload.navigation) {
          throw new Error("Historical incident preload did not return a usable page.");
        }
        await reportProgress(
          "reading_history",
          `Reading historical incident ${index + 1} of ${tickets.length} in the foreground.`
        );
        await page.bringToFront();
        const preloadError = await preload.navigation;
        if (preloadError) {
          await reportProgress(
            "reading_history",
            `Retrying historical incident ${index + 1} of ${tickets.length} in the foreground.`
          );
          await page.goto(preload.url, { waitUntil: "domcontentloaded" });
          if (new URL(page.url()).origin !== new URL(currentIncidentUrl).origin) {
            throw new Error("Historical navigation left the selected XSOAR origin.");
          }
        }
        await waitForIncidentReady(page, Math.min(config.navigationTimeoutMs, historicalFieldsTimeoutMs), {
          quietPeriodMs: Math.min(1500, historicalFieldsTimeoutMs),
          readyQuietPeriodMs: Math.min(300, historicalFieldsTimeoutMs),
          preferredFields: [{ labels: configuredFieldLabels.classification }],
          requiredAnyFields: historicalRecommendationFields
        });
        const details = await extractIncident(page, config);
        if (details.ticketId !== ticket.ticketId) {
          throw new Error(`Expected historical incident ${ticket.ticketId}, but XSOAR opened ${details.ticketId || "an unknown ticket"}.`);
        }
        const missingFields = [
          ["Close Notes", details.closeNotes],
          ["Description Long", details.descriptionLong],
          ["Historical Summary", details.historicalSummary],
          ["Historical Recommendations", details.historicalRecommendations]
        ].filter(([, value]) => !value).map(([label]) => label);
        historical[index] = { ...details, missingFields };
      } catch (error) {
        const reason = cleanText(error instanceof Error ? error.message : String(error))
          .replace(/\u001b\[[0-9;]*m/g, "")
          .slice(0, 500);
        let finalPath = "<unavailable>";
        if (page) {
          try {
            const finalUrl = new URL(page.url());
            finalPath = `${finalUrl.pathname}${finalUrl.search}`;
          } catch {}
        }
        const contextualError = `${reason} Page: ${finalPath}.`;
        historical[index] = { ticketId: ticket.ticketId, error: contextualError };
        await reportProgress("history_failed", `Historical ticket #${ticket.ticketId}: ${contextualError}`);
      } finally {
        if (page) await settleWithin(() => page.close(), 3000);
        completed += 1;
        await reportProgress(
          "reading_history",
          `Read ${completed} of ${tickets.length} historical incident(s).`
        );
      }
    }
  }
  return historical;
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

function assessHistoricalResults(historical) {
  const failed = historical.filter((item) => item?.error).length;
  if (historical.length && failed === historical.length) {
    const details = historical
      .filter((item) => item?.error)
      .slice(0, 3)
      .map((item) => `#${item.ticketId || "unknown"}: ${cleanText(item.error).slice(0, 300)}`)
      .join(" | ");
    return `All ${failed} historical incidents could not be read. ${details}`;
  }
  const withoutRecommendation = historical.filter(
    (item) => item && !item.error && !selectHistoricalRecommendation(item)
  );
  return [
    failed ? `${failed} historical incident(s) could not be read.` : "",
    withoutRecommendation.length
      ? `${withoutRecommendation.length} historical incident(s) have no usable recommendation: ${withoutRecommendation.map((item) => `#${item.ticketId || "unknown"}`).join(", ")}.`
      : ""
  ].filter(Boolean).join(" ");
}

function buildTemplate(output, templateConfig = {}) {
  const template = resolveTemplateConfig(templateConfig);
  const customerName = firstAvailable(output.customerName) || "n/a";
  const historical = (output.historical || []).filter((item) => item && !item.error);
  const pastRatings = historical.map((item) => cleanText(item.classification)).filter(isAvailableValue);
  const pastRatingLine = pastRatings.length ? `Past rating: ${pastRatings.join(", ")}\n` : "";
  const subjectIdentity = firstAvailable(
    output.deviceHostname,
    output.sourceHostname,
    output.clientHostname,
    output.sourceUsername,
    output.clientUserName
  ) || "n/a";
  const source = firstAvailable(output.sourceIp, output.sourceUsername, output.clientUserName) || "n/a";
  const userIdentity = firstAvailable(output.sourceUsername, output.clientUserName) || "n/a";
  const clientHostname = firstAvailable(output.clientHostname, output.deviceHostname) || "n/a";
  const recommendations = historical.flatMap((item) => {
    const recommendation = selectHistoricalRecommendation(item);
    return recommendation ? [{ ticketId: item.ticketId, recommendation }] : [];
  }).map((item, index) => `${index + 1}. #${item.ticketId || "unknown"}: ${item.recommendation}`);

  const signature = [
    template.signOff,
    template.analystName,
    template.analystName ? template.analystTitle : ""
  ].filter(Boolean).join("\n");

  return `${template.greeting} ${customerName},
${pastRatingLine}We have detected ${firstAvailable(output.incidentName) || "n/a"} for ${subjectIdentity}.
-----------------------------------------------------------------

Event info breakdown is as follows:

Time Stamp: ${firstAvailable(output.occurred) || "n/a"}
User: ${userIdentity}
Source: ${source}
Destination: ${firstAvailable(output.destinationIp) || "n/a"}
Client Hostname: ${clientHostname}
Event Detail: ${firstAvailable(output.eventName) || "n/a"}
Event Record URL: ${firstAvailable(output.detectionUrl) || "n/a"}
Error / Service Message: ${firstAvailable(output.serviceMessage, output.eventInfo, output.errorMessage) || "n/a"}
----------------------------------------------------------

Investigation Summary
x x x
-----

Related Activity
x x x
-----

${template.recommendationsHeading}
${recommendations.length ? recommendations.join("\n") : "x x x"}
-----------------------------------------------

Vendor Guidance
x x x
-----

${template.contactText}${signature ? `\n\n${signature}` : ""}`;
}

function assertTrustedIncidentUrl(url, pattern, allowedOrigins, operation = "Incident navigation") {
  if (!incidentUrlMatches(url, pattern, allowedOrigins)) {
    throw new Error(`${operation} left the trusted XSOAR incident scope.`);
  }
  return url;
}

/** @type {Record<string, string>} */
const SAFE_PROGRESS_DETAILS = Object.freeze({
  connecting_chrome: "Connecting to the browser.",
  finding_incident_tab: "Finding the active XSOAR incident tab.",
  copying_browser_session: "Preparing the temporary browser session.",
  waiting_for_incident: "Waiting for XSOAR to finish rendering.",
  reading_incident: "Reading the incident fields.",
  reading_incident_view: "Reading an additional incident view.",
  discovering_incidents_route: "Finding the Incidents page.",
  opening_search: "Opening the temporary Incidents search tab.",
  setting_time_range: "Selecting the configured time range.",
  time_range_failed: "The time range could not be selected.",
  finding_search_box: "Finding the Incidents search box.",
  submitting_search: "Submitting the similar-incident search.",
  waiting_for_search: "Waiting for search results.",
  sorting_results: "Sorting the search results.",
  collecting_results: "Collecting the matching incident IDs.",
  search_complete: "The similar-incident search is complete.",
  reading_history: "Reading historical incident details.",
  history_failed: "A historical incident could not be read.",
  building_template: "Building the Notepad++ template.",
  closing_search_tab: "Closing the temporary search tab.",
  restoring_incident_tab: "Returning to the original incident tab.",
  closing_headless_browser: "Closing the temporary browser session.",
  disconnecting_browser: "Disconnecting from the browser.",
  browser_complete: "Browser work finished.",
  failed: "The browser helper failed.",
  working: "Working."
});

function createProgressReporter(enabled, emit = (_record) => {}) {
  let sequence = 0;

  return async (stage) => {
    if (!enabled) return;
    sequence += 1;
    const requestedStage = String(stage || "working").trim();
    const safeStage = Object.hasOwn(SAFE_PROGRESS_DETAILS, requestedStage)
      ? requestedStage
      : "working";
    await emit({
      type: "progress",
      stage: safeStage,
      detail: SAFE_PROGRESS_DETAILS[safeStage],
      sequence
    });
  };
}

async function settleWithin(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ completed: false, error: null }), timeoutMs);
  });
  const execution = Promise.resolve()
    .then(operation)
    .then(
      () => ({ completed: true, error: null }),
      (error) => ({ completed: true, error })
    );
  try {
    return await Promise.race([execution, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  FIELD_LABELS,
  assertTrustedIncidentUrl,
  assessHistoricalResults,
  buildSearchQuery,
  buildTemplate,
  cleanText,
  collectSearchResults,
  createProgressReporter,
  ensureNewestFirst,
  ensureTimeRange,
  extractIncident,
  extractIncidentAcrossTabs,
  findActiveIncidentPage,
  findIncidentSearchInput,
  headlessBrowserChannelForProduct,
  openForegroundPage,
  incidentUrlMatches,
  resolveTemplateConfig,
  resolveFieldLabels,
  validateConfig,
  waitForIncidentReady,
  searchSimilarIncidents,
  settleWithin,
  collectHistoricalDetails
};
