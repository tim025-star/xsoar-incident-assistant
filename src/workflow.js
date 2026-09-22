import {
  assertIncidentUrl,
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
  onProgress = async () => {}
}) {
  let tab;
  try {
    const requestedUrl = buildHistoricalIncidentUrl(originalTab.url, ticketId, settings);
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
        const finalTicketId = finalUrl.pathname.match(/\/(\d+)\/?$/)?.[1];
        if (finalTicketId !== String(ticketId)) throw new Error("XSOAR opened a different historic incident than requested.");
        const detail = await extractIncidentViews({
          adapter,
          settings,
          primaryTab: tab,
          primaryUrl: finalUrl.toString(),
          temporaryTabs,
          requiredFields: ["customerName", "ruleName", "caseType"],
          requiredAnyFields: ["historicalRecommendations", "closeNotes", "incidentOutcome"],
          focusOpenedTabs: true
        });
        if (String(detail.ticketId) !== String(ticketId)) {
          throw new Error("XSOAR opened a different historic incident than requested.");
        }
        if (!isSameClientAndAlertType(incident, detail)) return { unrelated: true, ticketId: String(ticketId) };
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
    const query = buildSearchQuery(incident.ruleName, incident.caseType, HISTORIC_LOOKBACK_QUERY);
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
    await onProgress(`Found ${ticketIds.length} historic incident candidate(s).`);
    for (const [index, ticketId] of ticketIds.entries()) {
      if (items.length >= settings.maxHistoricalIncidents) break;
      await onProgress(`Reviewing historic incident #${ticketId} (${index + 1} of ${ticketIds.length}).`);
      const candidate = await readHistoricCandidate({
        adapter, settings, incident, originalTab, temporaryTabs, ticketId, onProgress
      });
      if (candidate?.error) {
        const warning = `Historic incident #${candidate.ticketId} could not be read: ${candidate.error}`;
        failures.push(warning);
        await onProgress(warning);
      } else if (candidate?.unrelated) {
        await onProgress(`Skipped historic incident #${candidate.ticketId} because its client or alert type did not match.`);
      } else if (candidate) {
        items.push(candidate);
      }
    }
    const warnings = [];
    warnings.push(...failures);
    if (result.truncated) warnings.push("Historic search results were incomplete; older matches may be omitted.");
    return {
      items,
      warning: warnings.join(" ")
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
      originalTab = await adapter.openTab(buildIncidentUrlFromId(requestedIncidentId, settings), { focusBeforeNavigation: true });
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
    const initial = await adapter.extractIncident(originalTab.id, {
      ...settings,
      requireAlertJson: Boolean(enrichDraft),
      allowTabDiscovery: true
    });
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
      requireAlertJson: Boolean(enrichDraft),
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
      adapter, settings, incident, originalTab, temporaryTabs, onProgress
    });
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
