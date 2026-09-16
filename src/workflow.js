import {
  assertIncidentUrl,
  assertSearchUrl,
  buildDraft,
  buildHistoricalIncidentUrl,
  buildIncidentUrlFromId,
  buildIncidentSearchUrl,
  buildSearchQuery,
  mergeIncidentDetails,
  resolveSettings
} from "./domain.js";

const HISTORICAL_READ_CONCURRENCY = 2;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker()
  ));
  return results;
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

function historicalWarning(items) {
  const failed = items.filter((item) => item?.error).length;
  return failed ? `${failed} historical incident(s) could not be read.` : "";
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

    await onProgress(requestedIncidentId ? `Reading XSOAR incident ${requestedIncidentId}.` : "Reading the active XSOAR incident.");
    const initial = await adapter.extractIncident(originalTab.id, settings);
    if (requestedIncidentId && String(initial.ticketId) !== requestedIncidentId) {
      throw new Error("XSOAR opened a different incident than the requested Incident ID.");
    }
    const views = [initial];
    for (const url of uniqueTrustedTabUrls(initial, settings)) {
      if (url === originalTab.url) continue;
      await onProgress("Reading an additional incident view.");
      const tab = await adapter.openTab(url);
      temporaryTabs.add(tab);
      const finalUrl = await adapter.getTabUrl(tab.id);
      assertIncidentUrl(finalUrl, settings, "Incident view navigation");
      views.push(await adapter.extractIncident(tab.id, settings));
      await adapter.closeTab(tab.id);
      temporaryTabs.delete(tab);
    }

    const incident = mergeIncidentDetails(...views);
    const query = buildSearchQuery(incident.ruleName, incident.caseType, settings.lookbackQuery);
    const searchUrl = buildIncidentSearchUrl(settings, query);
    await onProgress("Opening the matching-incidents query URL.");
    const searchTab = await adapter.openTab(searchUrl);
    temporaryTabs.add(searchTab);
    const finalSearchUrl = await adapter.getTabUrl(searchTab.id);
    assertSearchUrl(finalSearchUrl, settings, query);
    const searchResult = await adapter.extractSearchResults(searchTab.id, {
      expectedQuery: query,
      // The current incident can appear in the result set, so collect one
      // extra candidate before excluding it below.
      maxResults: settings.maxHistoricalIncidents + 1,
      timeoutMs: settings.pageReadyTimeoutMs
    });

    const historicalTicketIds = searchResult.ticketIds
      .filter((ticketId) => String(ticketId) !== String(incident.ticketId))
      .slice(0, settings.maxHistoricalIncidents);
    const historical = await mapWithConcurrency(
      historicalTicketIds,
      HISTORICAL_READ_CONCURRENCY,
      async (ticketId) => {
        let historyTab;
        try {
          await onProgress("Reading a matching historical incident.");
          const historicalUrl = buildHistoricalIncidentUrl(originalTab.url, ticketId, settings);
          historyTab = await adapter.openTab(historicalUrl);
          temporaryTabs.add(historyTab);
          const finalUrl = await adapter.getTabUrl(historyTab.id);
          assertIncidentUrl(finalUrl, settings, "Historical incident navigation");
          const detail = await adapter.extractIncident(historyTab.id, settings);
          if (String(detail.ticketId) !== String(ticketId)) {
            throw new Error("XSOAR opened a different historical incident than requested.");
          }
          return detail;
        } catch (error) {
          return {
            ticketId: String(ticketId),
            error: error instanceof Error ? error.message : String(error)
          };
        } finally {
          if (historyTab) {
            await adapter.closeTab(historyTab.id).catch(() => {});
            temporaryTabs.delete(historyTab);
          }
        }
      }
    );

    const output = { ...incident, historical };
    await onProgress("Preparing the incident-response draft.");
    let draft = buildDraft(output, settings.template);
    let enrichmentWarning = "";
    let aiEnriched = false;
    if (enrichDraft) {
      await onProgress("Optionally enriching the deterministic draft with local Ollama.");
      try {
        const enrichment = await enrichDraft({ incident, historical, draft });
        draft = buildDraft(output, settings.template, enrichment);
        aiEnriched = true;
      } catch {
        enrichmentWarning = "Local AI enrichment was unavailable; the deterministic draft was provided.";
      }
    }
    return {
      draft,
      warning: [historicalWarning(historical), enrichmentWarning].filter(Boolean).join(" "),
      reviewed: historical.filter((item) => !item.error).length,
      aiEnriched
    };
  } finally {
    for (const tab of [...temporaryTabs].reverse()) {
      await adapter.closeTab(tab.id).catch(() => {});
    }
    if (originalTab && !openedRequestedIncident) await adapter.focusTab(originalTab.id).catch(() => {});
  }
}
