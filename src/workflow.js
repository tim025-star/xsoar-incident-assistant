import {
  assertIncidentUrl,
  assertSearchUrl,
  buildDraft,
  buildHistoricalIncidentUrl,
  buildIncidentUrlFromId,
  buildIncidentSearchUrl,
  buildSearchQuery,
  cleanText,
  mergeIncidentDetails,
  resolveSettings
} from "./domain.js";

const HISTORIC_LOOKBACK_QUERY = 'created:>="3 months ago"';
const HISTORIC_READ_CONCURRENCY = 2;
const HISTORIC_SEARCH_SAFETY_LIMIT = 1000;

function isSameClientAndAlertType(current, candidate) {
  const normalize = (value) => cleanText(value).toLowerCase();
  return Boolean(
    normalize(current.customerName)
    && normalize(current.ruleName)
    && normalize(current.caseType)
    && normalize(candidate.customerName) === normalize(current.customerName)
    && normalize(candidate.ruleName) === normalize(current.ruleName)
    && normalize(candidate.caseType) === normalize(current.caseType)
  );
}

function hasHistoricResolution(candidate) {
  return Boolean(cleanText(candidate?.historicalRecommendations)
    || cleanText(candidate?.closeNotes)
    || cleanText(candidate?.incidentOutcome));
}

function ticketIdFromIncidentUrl(value, settings, description) {
  return assertIncidentUrl(value, settings, description).pathname.match(/\/(\d+)\/?$/)?.[1] || "";
}

async function extractIncidentViews({
  adapter,
  settings,
  primaryTab,
  primaryUrl,
  temporaryTabs,
  initialDetail,
  requiredFields = [],
  onView = async () => {}
}) {
  const expectedTicketId = ticketIdFromIncidentUrl(primaryUrl, settings, "Incident view extraction");
  const initial = initialDetail || await adapter.extractIncident(primaryTab.id, { ...settings, requiredFields });
  const views = [initial];
  for (const url of uniqueTrustedTabUrls(initial, settings)) {
    if (url === primaryUrl) continue;
    await onView();
    const tab = await adapter.openTab(url);
    temporaryTabs.add(tab);
    try {
      const finalUrl = await adapter.getTabUrl(tab.id);
      const finalTicketId = ticketIdFromIncidentUrl(finalUrl, settings, "Incident view navigation");
      if (finalTicketId !== expectedTicketId) throw new Error("XSOAR opened a different incident view than requested.");
      views.push(await adapter.extractIncident(tab.id, { ...settings, requiredFields: [] }));
    } finally {
      await adapter.closeTab(tab.id).catch(() => {});
      temporaryTabs.delete(tab);
    }
  }
  return mergeIncidentDetails(...views);
}

async function readHistoricCandidate({ adapter, settings, incident, originalTab, temporaryTabs, ticketId }) {
  let tab;
  try {
    const requestedUrl = buildHistoricalIncidentUrl(originalTab.url, ticketId, settings);
    tab = await adapter.openTab(requestedUrl);
    temporaryTabs.add(tab);
    const finalUrl = assertIncidentUrl(await adapter.getTabUrl(tab.id), settings, "Historic incident navigation");
    const finalTicketId = finalUrl.pathname.match(/\/(\d+)\/?$/)?.[1];
    if (finalTicketId !== String(ticketId)) throw new Error("XSOAR opened a different historic incident than requested.");
    const detail = await extractIncidentViews({
      adapter,
      settings,
      primaryTab: tab,
      primaryUrl: finalUrl.toString(),
      temporaryTabs,
      requiredFields: ["customerName", "ruleName", "caseType"]
    });
    if (String(detail.ticketId) !== String(ticketId)) {
      throw new Error("XSOAR opened a different historic incident than requested.");
    }
    if (!isSameClientAndAlertType(incident, detail)) return { unrelated: true };
    const candidate = {
      ticketId: detail.ticketId,
      historicalRecommendations: detail.historicalRecommendations,
      closeNotes: detail.closeNotes,
      incidentOutcome: detail.incidentOutcome
    };
    return hasHistoricResolution(candidate) ? candidate : { unresolved: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tab) {
      await adapter.closeTab(tab.id).catch(() => {});
      temporaryTabs.delete(tab);
    }
  }
}

async function collectHistoric({ adapter, settings, incident, originalTab, temporaryTabs }) {
  try {
    const query = buildSearchQuery(incident.incidentName, incident.caseType, HISTORIC_LOOKBACK_QUERY);
    const searchTab = await adapter.openTab(buildIncidentSearchUrl(settings, query));
    temporaryTabs.add(searchTab);
    assertSearchUrl(await adapter.getTabUrl(searchTab.id), settings, query);
    const result = await adapter.extractSearchResults(searchTab.id, {
      expectedQuery: query,
      maxResults: HISTORIC_SEARCH_SAFETY_LIMIT,
      timeoutMs: settings.pageReadyTimeoutMs
    });
    const ticketIds = result.ticketIds.filter((ticketId) => String(ticketId) !== String(incident.ticketId));
    const items = [];
    let failed = 0;
    for (let index = 0; index < ticketIds.length && items.length < settings.maxHistoricalIncidents; index += HISTORIC_READ_CONCURRENCY) {
      const batch = ticketIds.slice(index, index + HISTORIC_READ_CONCURRENCY);
      const candidates = await Promise.all(batch.map((ticketId) => readHistoricCandidate({
        adapter, settings, incident, originalTab, temporaryTabs, ticketId
      })));
      failed += candidates.filter((item) => item?.error).length;
      for (const candidate of candidates) {
        if (candidate && !candidate.error && !candidate.unrelated && !candidate.unresolved) items.push(candidate);
        if (items.length >= settings.maxHistoricalIncidents) break;
      }
    }
    const warnings = [];
    if (failed) warnings.push(`Could not read ${failed} historic incident(s).`);
    if (result.truncated) warnings.push("Historic search reached its 1,000-result safety limit; older matches may be omitted.");
    return {
      items,
      warning: warnings.join(" ")
    };
  } catch (error) {
    return {
      items: [],
      warning: `Historic incident lookup was unavailable: ${error instanceof Error ? error.message : String(error)}`
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

export async function runIncidentDraft({ adapter, settings: inputSettings, incidentId = "", onProgress = async () => {}, enrichDraft }) {
  if (!adapter) throw new Error("A browser adapter is required.");
  const settings = resolveSettings(inputSettings);
  const temporaryTabs = new Set();
  const requestedIncidentId = String(incidentId).trim();
  let originalTab;
  let openedRequestedIncident = false;

  try {
    if (requestedIncidentId) {
      await onProgress(`Opening XSOAR incident ${requestedIncidentId}.`);
      originalTab = await adapter.openTab(buildIncidentUrlFromId(requestedIncidentId, settings));
      temporaryTabs.add(originalTab);
      openedRequestedIncident = true;
      const finalUrl = await adapter.getTabUrl(originalTab.id);
      const finalIncidentUrl = assertIncidentUrl(finalUrl, settings, "Requested incident navigation");
      const finalTicketId = finalIncidentUrl.pathname.match(/\/(\d+)\/?$/)?.[1];
      if (finalTicketId !== requestedIncidentId) {
        throw new Error("XSOAR opened a different incident than the requested Incident ID.");
      }
      originalTab.url = finalIncidentUrl.toString();
    } else {
      originalTab = await adapter.getActiveTab();
      assertIncidentUrl(originalTab.url, settings, "The active tab");
    }

    await onProgress(requestedIncidentId ? `Collecting evidence from incident ${requestedIncidentId}.` : "Collecting evidence from the open XSOAR incident.");
    const initial = await adapter.extractIncident(originalTab.id, settings);
    if (requestedIncidentId && String(initial.ticketId) !== requestedIncidentId) {
      throw new Error("XSOAR opened a different incident than the requested Incident ID.");
    }
    const incident = await extractIncidentViews({
      adapter,
      settings,
      primaryTab: originalTab,
      primaryUrl: originalTab.url,
      temporaryTabs,
      initialDetail: initial,
      onView: () => onProgress("Collecting evidence from another incident view.")
    });
    await onProgress("Processing the selected alert and searching three months of history.");
    const enrichmentPromise = (async () => {
      if (!enrichDraft) return { enrichment: null, warning: "", aiEnriched: false };
      try {
        const enrichment = await enrichDraft({ incident });
        const hasProcessedFacts = cleanText(enrichment?.eventSummary)
          || (Array.isArray(enrichment?.observedFacts)
            && enrichment.observedFacts.some((item) => cleanText(item)));
        if (!hasProcessedFacts) throw new Error("Local AI returned no processed facts.");
        return { enrichment, warning: "", aiEnriched: true };
      } catch {
        return { enrichment: null, warning: "Local AI did not return valid processed fields. The source-field response is ready.", aiEnriched: false };
      }
    })();
    const historicPromise = collectHistoric({ adapter, settings, incident, originalTab, temporaryTabs });
    const [processed, historic] = await Promise.all([enrichmentPromise, historicPromise]);
    const draft = buildDraft({ ...incident, historical: historic.items }, settings.template, processed.enrichment);
    return {
      draft,
      warning: [processed.warning, historic.warning].filter(Boolean).join(" "),
      reviewed: historic.items.length,
      aiEnriched: processed.aiEnriched
    };
  } finally {
    for (const tab of [...temporaryTabs].reverse()) {
      await adapter.closeTab(tab.id).catch(() => {});
    }
    if (originalTab && !openedRequestedIncident) await adapter.focusTab(originalTab.id).catch(() => {});
  }
}
