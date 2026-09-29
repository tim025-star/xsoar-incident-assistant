import {
  assertIncidentUrl,
  buildDraft,
  buildHistoricalIncidentUrl,
  buildIncidentUrlFromId,
  buildIncidentSearchUrl,
  cleanText,
  incidentTicketIdFromUrl,
  mergeIncidentDetails,
  resolveSettings
} from "./domain.js";
import { LAYA_MAPPER_TARGETS } from "./laya-mapper.js";
import { renderHistoricQuery } from "./historic-query.js";

const HISTORIC_SEARCH_SAFETY_LIMIT = 1000;

function isSameTenantAndAlertName(current, candidate, row) {
  const normalize = (value) => cleanText(value).toLowerCase();
  const tenantName = normalize(current.tenantName);
  const incidentName = normalize(current.incidentName);
  const candidateTenant = normalize(candidate.tenantName);
  const candidateName = normalize(candidate.incidentName);
  return Boolean(tenantName && incidentName
    && normalize(row?.tenantName || candidate.tenantName) === tenantName
    && normalize(row?.name || candidate.incidentName) === incidentName
    && (!candidateTenant || candidateTenant === tenantName)
    && (!candidateName || candidateName === incidentName));
}

function hasHistoricResolution(candidate) {
  return Boolean(cleanText(candidate?.historicalRecommendations)
    || cleanText(candidate?.closeNotes)
    || cleanText(candidate?.incidentOutcome));
}

function nonEmptyMappedFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => cleanText(value)));
}

async function applyLayaMapping(incident, mapIncident, targets = LAYA_MAPPER_TARGETS) {
  if (!mapIncident) return { incident, warning: "", mapped: false, fields: [], tentativeFields: [] };
  if (incident.alertJsonComplete !== true || !Array.isArray(incident.alertJson) || !incident.alertJson.length) {
    return { incident, warning: "Complete alert JSON was not available for Laya-mapper; configured source-field mappings were used.", mapped: false, fields: [], tentativeFields: [] };
  }
  try {
    const result = await mapIncident({ incident, targets });
    const complete = result?.complete === true && result?.sourceComplete === true && result?.processingComplete === true;
    const selected = complete
      ? Object.fromEntries(Object.entries(result.fields || {}).filter(([key]) => targets.includes(key) && result.statuses?.[key] === "selected"))
      : {};
    const fields = nonEmptyMappedFields(selected);
    const tentativeFields = targets.filter((key) => result.statuses?.[key] === "tentative");
    return {
      incident: { ...incident, ...fields },
      warning: [!complete ? "Laya-mapper did not complete on full alert JSON; configured source-field mappings were used." : "", tentativeFields.length ? `Tentative Laya matches were not applied: ${tentativeFields.join(", ")}.` : "", cleanText(result?.warning)].filter(Boolean).join(" "),
      mapped: Object.keys(fields).length > 0,
      fields: Object.keys(fields).map((key) => ({ key, pointer: result.paths?.[key] || "" })),
      tentativeFields
    };
  } catch {
    return {
      incident,
      warning: "Laya-mapper could not map this alert; configured source-field mappings were used.",
      mapped: false,
      fields: [],
      tentativeFields: []
    };
  }
}

function ticketIdFromIncidentUrl(value, settings, description) {
  return incidentTicketIdFromUrl(value, settings, description);
}

async function extractIncidentViews({
  adapter,
  settings,
  primaryTab,
  primaryUrl,
  temporaryTabs,
  initialDetail,
  requiredFields = [],
  requiredAnyFields = [],
  requireAlertJson = false,
  focusOpenedTabs = false,
  onView = async () => {}
}) {
  const expectedTicketId = ticketIdFromIncidentUrl(primaryUrl, settings, "Incident view extraction");
  const initial = initialDetail || await adapter.extractIncident(primaryTab.id, {
    ...settings,
    requiredFields,
    requiredAnyFields,
    requireAlertJson,
    allowTabDiscovery: true,
    allowPartialForTabDiscovery: true
  });
  const views = [initial];
  for (const url of uniqueTrustedTabUrls(initial, settings)) {
    if (url === primaryUrl) continue;
    await onView();
    const tab = await adapter.openTab(url, { focusBeforeNavigation: focusOpenedTabs });
    temporaryTabs.add(tab);
    try {
      if (focusOpenedTabs) await adapter.focusTab(tab.id);
      const finalUrl = await adapter.getTabUrl(tab.id);
      const finalTicketId = ticketIdFromIncidentUrl(finalUrl, settings, "Incident view navigation");
      if (finalTicketId !== expectedTicketId) throw new Error("XSOAR opened a different incident view than requested.");
      const merged = mergeIncidentDetails(...views);
      const remainingRequiredFields = requiredFields.filter((key) => !cleanText(merged[key]));
      const remainingAnyFields = requiredAnyFields.some((key) => cleanText(merged[key]))
        ? []
        : requiredAnyFields;
      const stillRequiresAlertJson = requireAlertJson
        && !(merged.alertJsonComplete && Array.isArray(merged.alertJson) && merged.alertJson.length > 0);
      views.push(await adapter.extractIncident(tab.id, {
        ...settings,
        requiredFields: remainingRequiredFields,
        requiredAnyFields: remainingAnyFields,
        requireAlertJson: stillRequiresAlertJson,
        allowTabDiscovery: false
      }));
    } finally {
      await adapter.closeTab(tab.id).catch(() => {});
      temporaryTabs.delete(tab);
    }
  }
  const merged = mergeIncidentDetails(...views);
  const missingRequiredFields = requiredFields.filter((key) => !cleanText(merged[key]));
  if (missingRequiredFields.length) {
    throw new Error(`Required incident fields did not become ready: ${missingRequiredFields.join(", ")}.`);
  }
  if (requiredAnyFields.length && !requiredAnyFields.some((key) => cleanText(merged[key]))) {
    throw new Error("Required historic resolution fields did not become ready.");
  }
  return merged;
}

function safeHistoricFailure(error) {
  return String(error instanceof Error ? error.message : error)
    .split(/\r?\n/, 1)[0]
    .replace(/^page\.evaluate:\s*(?:Error:\s*)?/i, "")
    .trim()
    .slice(0, 300) || "Unknown browser error.";
}

async function readHistoricCandidate({
  adapter,
  settings,
  incident,
  originalTab,
  temporaryTabs,
  ticketId,
  ticketUrl,
  ticketRow,
  onProgress = async () => {}
}) {
  let tab;
  try {
    const requestedUrl = ticketUrl
      ? assertIncidentUrl(ticketUrl, settings, "Historic result navigation").toString()
      : buildHistoricalIncidentUrl(originalTab.url, ticketId, settings);
    if (ticketIdFromIncidentUrl(requestedUrl, settings, "Historic result navigation") !== String(ticketId)) {
      throw new Error("XSOAR result link did not match the historic incident ID.");
    }
    tab = await adapter.openTab(requestedUrl, { focusBeforeNavigation: true });
    temporaryTabs.add(tab);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt) {
          await onProgress(`Retrying historic incident #${ticketId} in the foreground.`);
          await adapter.focusTab(tab.id);
          await adapter.reloadTab(tab.id, requestedUrl, { focusBeforeNavigation: true });
        }
        await adapter.focusTab(tab.id);
        const finalUrl = assertIncidentUrl(await adapter.getTabUrl(tab.id), settings, "Historic incident navigation");
        const finalTicketId = ticketIdFromIncidentUrl(finalUrl, settings, "Historic incident navigation");
        if (finalTicketId !== String(ticketId)) throw new Error("XSOAR opened a different historic incident than requested.");
        const hasRowIdentity = Boolean(ticketRow?.tenantName && ticketRow?.name);
        const detail = await extractIncidentViews({
          adapter,
          settings,
          primaryTab: tab,
          primaryUrl: finalUrl.toString(),
          temporaryTabs,
          requiredFields: hasRowIdentity ? [] : ["tenantName", "incidentName"],
          requiredAnyFields: ["historicalRecommendations", "closeNotes", "incidentOutcome"],
          requireAlertJson: false,
          focusOpenedTabs: true
        });
        if (String(detail.ticketId) !== String(ticketId)) {
          throw new Error("XSOAR opened a different historic incident than requested.");
        }
        if (!hasRowIdentity) {
          const missingIdentity = ["tenantName", "incidentName"].filter((key) => !cleanText(detail[key]));
          if (missingIdentity.length) throw new Error(`Required incident fields did not become ready: ${missingIdentity.join(", ")}.`);
        }
        if (!isSameTenantAndAlertName(incident, detail, ticketRow)) return { unrelated: true, ticketId: String(ticketId) };
        const candidate = {
          ticketId: detail.ticketId,
          historicalRecommendations: detail.historicalRecommendations,
          closeNotes: detail.closeNotes,
          incidentOutcome: detail.incidentOutcome
        };
        if (!hasHistoricResolution(candidate)) {
          throw new Error("Required historic resolution fields did not become ready.");
        }
        return candidate;
      } catch (error) {
        lastError = error;
        if (attempt === 1) throw error;
      }
    }
    throw lastError;
  } catch (error) {
    return { ticketId: String(ticketId), error: safeHistoricFailure(error) };
  } finally {
    if (tab) {
      await adapter.closeTab(tab.id).catch(() => {});
      temporaryTabs.delete(tab);
    }
  }
}

async function collectHistoric({ adapter, settings, incident, originalTab, temporaryTabs, onProgress = async () => {} }) {
  try {
    const query = await renderHistoricQuery(settings, incident);
    const searchTab = await adapter.openTab(buildIncidentSearchUrl(settings, ""), { focusBeforeNavigation: true });
    temporaryTabs.add(searchTab);
    await adapter.focusTab(searchTab.id);
    const result = await adapter.extractSearchResults(searchTab.id, {
      expectedQuery: query,
      maxResults: HISTORIC_SEARCH_SAFETY_LIMIT,
      timeoutMs: settings.pageReadyTimeoutMs
    });
    const ticketIds = result.ticketIds.filter((ticketId) => String(ticketId) !== String(incident.ticketId));
    const items = [];
    const failures = [];
    const warnings = [];
    await onProgress(`Found ${ticketIds.length} historic incident candidate(s).`);
    for (const [index, ticketId] of ticketIds.entries()) {
      if (items.length >= settings.maxHistoricalIncidents) break;
      await onProgress(`Reviewing historic incident #${ticketId} (${index + 1} of ${ticketIds.length}).`);
      const candidate = await readHistoricCandidate({
        adapter, settings, incident, originalTab, temporaryTabs, ticketId,
        ticketUrl: result.ticketUrls?.[ticketId], ticketRow: result.ticketRows?.[ticketId], onProgress
      });
      if (candidate?.error) {
        const warning = `Historic incident #${candidate.ticketId} could not be read: ${candidate.error}`;
        failures.push(warning);
        await onProgress(warning);
      } else if (candidate?.unrelated) {
        await onProgress(`Skipped historic incident #${candidate.ticketId} because its tenant or incident name did not match.`);
      } else if (candidate) {
        items.push(candidate);
      }
    }
    warnings.push(...failures);
    if (result.truncated) warnings.push("Historic search results were incomplete; older matches may be omitted.");
    return {
      items,
      warning: [...new Set(warnings)].join(" ")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message.includes("XSOAR historic search results did not become ready before the timeout")
      ? "XSOAR historic search results did not become ready before the timeout."
      : message.split(/\r?\n/)[0];
    return {
      items: [],
      warning: `Historic incident lookup was unavailable: ${safeMessage}`
    };
  }
}

function uniqueTrustedTabUrls(details, settings) {
  const urls = new Set();
  for (const value of details?.tabUrls || []) {
    try {
      urls.add(assertIncidentUrl(value, settings, "Incident view discovery").toString());
    } catch {
      // Ignore links that do not stay within the configured incident scope.
    }
  }
  return [...urls];
}

export async function runIncidentDraft({
  adapter,
  settings: inputSettings,
  incidentId = "",
  onProgress = async () => {},
  mapIncident,
  enrichDraft
}) {
  if (!adapter) throw new Error("A browser adapter is required.");
  const settings = resolveSettings(inputSettings);
  const temporaryTabs = new Set();
  const requestedIncidentId = String(incidentId).trim();
  let originalTab;
  let openedRequestedIncident = false;

  try {
    if (requestedIncidentId) {
      await onProgress(`Opening XSOAR incident ${requestedIncidentId}.`);
      originalTab = await adapter.openTab(buildIncidentUrlFromId(requestedIncidentId, settings), { focusBeforeNavigation: true });
      temporaryTabs.add(originalTab);
      openedRequestedIncident = true;
      const finalUrl = await adapter.getTabUrl(originalTab.id);
      const finalIncidentUrl = assertIncidentUrl(finalUrl, settings, "Requested incident navigation");
      const finalTicketId = ticketIdFromIncidentUrl(finalIncidentUrl, settings, "Requested incident navigation");
      if (finalTicketId !== requestedIncidentId) {
        throw new Error("XSOAR opened a different incident than the requested Incident ID.");
      }
      originalTab.url = finalIncidentUrl.toString();
    } else {
      originalTab = await adapter.getActiveTab();
      assertIncidentUrl(originalTab.url, settings, "The active tab");
    }

    await onProgress(requestedIncidentId ? `Collecting evidence from incident ${requestedIncidentId}.` : "Collecting evidence from the open XSOAR incident.");
    const initial = await adapter.extractIncident(originalTab.id, {
      ...settings,
      requireAlertJson: Boolean(enrichDraft),
      allowTabDiscovery: true
    });
    if (requestedIncidentId && String(initial.ticketId) !== requestedIncidentId) {
      throw new Error("XSOAR opened a different incident than the requested Incident ID.");
    }
    const extractedIncident = await extractIncidentViews({
      adapter,
      settings,
      primaryTab: originalTab,
      primaryUrl: originalTab.url,
      temporaryTabs,
      initialDetail: initial,
      requireAlertJson: Boolean(enrichDraft),
      onView: () => onProgress("Collecting evidence from another incident view.")
    });
    if (mapIncident) await onProgress("Mapping source fields with local Laya-mapper.");
    const mapped = await applyLayaMapping(extractedIncident, mapIncident);
    const incident = mapped.incident;
    await onProgress("Processing the selected alert and searching incident history.");
    const enrichmentPromise = (async () => {
      if (!enrichDraft) return { enrichment: null, warning: "", aiEnriched: false };
      try {
        const enrichment = await enrichDraft({ incident });
        const hasProcessedFacts = cleanText(enrichment?.eventSummary)
          || (Array.isArray(enrichment?.observedFacts)
            && enrichment.observedFacts.some((item) => cleanText(item)));
        if (!hasProcessedFacts) throw new Error("Local AI returned no processed facts.");
        return { enrichment, warning: "", aiEnriched: true };
      } catch (error) {
        const message = cleanText(error instanceof Error ? error.message : "");
        const safeDetail = /^The (?:complete )?detailed alert JSON (?:was not available|exceeds|could not be serialized|is too complex)/.test(message)
          ? ` ${message}`
          : "";
        return {
          enrichment: null,
          warning: `Local AI did not return valid processed fields.${safeDetail} The source-field response is ready.`,
          aiEnriched: false
        };
      }
    })();
    const historicPromise = collectHistoric({
      adapter, settings, incident: extractedIncident, originalTab, temporaryTabs, onProgress
    });
    const [processed, historic] = await Promise.all([enrichmentPromise, historicPromise]);
    const draft = buildDraft({ ...incident, historical: historic.items }, settings.template, processed.enrichment);
    const processingMode = mapped.mapped
      ? (processed.aiEnriched ? "Laya mapping + Qwen enrichment" : "Laya mapping")
      : (processed.aiEnriched ? "Deterministic extraction + Qwen enrichment" : "Deterministic extraction");
    return {
      draft,
      warning: [mapped.warning, processed.warning, historic.warning].filter(Boolean).join(" "),
      reviewed: historic.items.length,
      aiEnriched: processed.aiEnriched,
      layaMapped: mapped.mapped,
      layaFields: mapped.fields,
      layaTentativeFields: mapped.tentativeFields,
      processingMode
    };
  } finally {
    for (const tab of [...temporaryTabs].reverse()) {
      await adapter.closeTab(tab.id).catch(() => {});
    }
    if (originalTab && !openedRequestedIncident) await adapter.focusTab(originalTab.id).catch(() => {});
  }
}
