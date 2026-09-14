import {
  assertIncidentUrl,
  assertSearchUrl,
  buildDraft,
  buildHistoricalIncidentUrl,
  buildIncidentSearchUrl,
  buildSearchQuery,
  mergeIncidentDetails,
  resolveSettings
} from "./domain.js";

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

export async function runIncidentDraft({ adapter, settings: inputSettings, onProgress = async () => {} }) {
  if (!adapter) throw new Error("A browser adapter is required.");
  const settings = resolveSettings(inputSettings);
  const originalTab = await adapter.getActiveTab();
  assertIncidentUrl(originalTab.url, settings, "The active tab");
  let searchTab;
  const temporaryTabs = [];

  try {
    await onProgress("reading_incident", "Reading the active XSOAR incident.");
    const initial = await adapter.extractIncident(originalTab.id, settings);
    const views = [initial];
    for (const url of uniqueTrustedTabUrls(initial, settings)) {
      if (url === originalTab.url) continue;
      await onProgress("reading_incident", "Reading an additional incident view.");
      const tab = await adapter.openTab(url, { active: true });
      temporaryTabs.push(tab);
      await adapter.waitUntilReady(tab.id, settings.pageReadyTimeoutMs);
      const finalUrl = await adapter.getTabUrl(tab.id);
      assertIncidentUrl(finalUrl, settings, "Incident view navigation");
      views.push(await adapter.extractIncident(tab.id, settings));
      await adapter.closeTab(tab.id);
      temporaryTabs.splice(temporaryTabs.indexOf(tab), 1);
    }

    const incident = mergeIncidentDetails(...views);
    const query = buildSearchQuery(incident.ruleName, incident.caseType, settings.lookbackQuery);
    const searchUrl = buildIncidentSearchUrl(settings, query);
    await onProgress("searching", "Opening the matching-incidents query URL.");
    searchTab = await adapter.openTab(searchUrl, { active: true });
    temporaryTabs.push(searchTab);
    await adapter.waitUntilReady(searchTab.id, settings.pageReadyTimeoutMs);
    const finalSearchUrl = await adapter.getTabUrl(searchTab.id);
    assertSearchUrl(finalSearchUrl, settings, query);
    const searchResult = await adapter.extractSearchResults(searchTab.id, {
      expectedQuery: query,
      // The current incident can appear in the result set, so collect one
      // extra candidate before excluding it below.
      maxResults: settings.maxHistoricalIncidents + 1,
      timeoutMs: settings.pageReadyTimeoutMs
    });

    const historical = [];
    for (const ticket of searchResult.tickets
      .filter((item) => String(item.ticketId) !== String(incident.ticketId))
      .slice(0, settings.maxHistoricalIncidents)) {
      let historyTab;
      try {
        await onProgress("reading_history", "Reading a matching historical incident.");
        const historicalUrl = buildHistoricalIncidentUrl(originalTab.url, ticket.ticketId, settings);
        historyTab = await adapter.openTab(historicalUrl, { active: true });
        temporaryTabs.push(historyTab);
        await adapter.waitUntilReady(historyTab.id, settings.pageReadyTimeoutMs);
        const finalUrl = await adapter.getTabUrl(historyTab.id);
        assertIncidentUrl(finalUrl, settings, "Historical incident navigation");
        const detail = await adapter.extractIncident(historyTab.id, settings);
        if (String(detail.ticketId) !== String(ticket.ticketId)) {
          throw new Error("XSOAR opened a different historical incident than requested.");
        }
        historical.push(detail);
      } catch (error) {
        historical.push({
          ticketId: String(ticket.ticketId),
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (historyTab) {
          await adapter.closeTab(historyTab.id).catch(() => {});
          const index = temporaryTabs.indexOf(historyTab);
          if (index >= 0) temporaryTabs.splice(index, 1);
        }
      }
    }

    const output = { ...incident, searchQuery: query, historical };
    await onProgress("building_draft", "Preparing the incident-response draft.");
    return {
      ok: true,
      draft: buildDraft(output, settings.template),
      warning: historicalWarning(historical),
      matches: searchResult.total,
      reviewed: historical.filter((item) => !item.error).length
    };
  } finally {
    for (const tab of temporaryTabs.reverse()) {
      await adapter.closeTab(tab.id).catch(() => {});
    }
    await adapter.focusTab(originalTab.id).catch(() => {});
  }
}
