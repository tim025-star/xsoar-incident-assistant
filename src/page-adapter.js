export async function extractIncidentFromPage(settings) {
  const currentUrl = new URL(location.href);
  if (currentUrl.protocol !== "https:" || currentUrl.origin !== settings.allowedOrigin
    || !new RegExp(settings.incidentUrlPattern).test(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`)) {
    throw new Error("Incident extraction refused an untrusted page URL.");
  }
  const normalize = (value) => String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  const normalizeLabel = (value) => normalize(value).toLowerCase().replace(/\s+/g, " ");
  const available = (value) => Boolean(normalize(value)
    && !/^(?:n\/?a|none|null|undefined|-)$/i.test(normalize(value)));
  const first = (...values) => values.map(normalize).find(available) || "";
  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden"
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  };
  const extractValue = (root) => {
    if (!root) return "";
    for (const selector of [
      ".text-field-display-value",
      ".date-display-value",
      ".single-select-field-wrapper__single-value",
      "[class*='singleValue']",
      ".markdown",
      ".preplacer"
    ]) {
      const element = Array.from(root.querySelectorAll(selector)).find(isVisible);
      const value = normalize(element?.getAttribute("title") || element?.innerText || element?.textContent);
      if (value && !/^(?:edit|clear|select)$/i.test(value)) return value;
    }
    const titled = Array.from(root.querySelectorAll("[title]"))
      .filter((element) => isVisible(element) && !element.closest("label,button,input,textarea,select"))
      .map((element) => normalize(element.getAttribute("title")))
      .filter((value) => value && !/^(?:edit|clear|select|open)$/i.test(value));
    if (titled.length) return titled.sort((a, b) => b.length - a.length)[0];
    const copy = root.cloneNode(true);
    copy.querySelectorAll("label,button,input,textarea,select,svg,object,.resize-sensor,.xdr-sr-only")
      .forEach((element) => element.remove());
    return normalize(copy.innerText || copy.textContent);
  };
  const incidentFieldsBusy = () => {
    const busySelector = ".loading-spinner,.spinner,[aria-busy='true']";
    return Array.from(document.querySelectorAll(".field-wrapper")).filter(isVisible).some((wrapper) =>
      (wrapper.matches?.(busySelector) && isVisible(wrapper))
      || Array.from(wrapper.querySelectorAll?.(busySelector) || []).some(isVisible));
  };
  const normalizeJsonPath = (value) => normalize(value).toLowerCase()
    .replace(/\[(?:\d+|\*)\]/g, ".")
    .split(/[^a-z0-9]+/)
    .filter((part) => part && !/^\d+$/.test(part))
    .join(".");
  const collectJsonEvidence = () => {
    const maximumDocumentCharacters = 96 * 1024;
    const maximumCandidates = 100;
    const maximumTableRows = 1000;
    const pairs = [];
    const documents = [];
    const seen = new Set();
    let visitedNodes = 0;
    let documentCharacters = 0;
    let complete = true;
    const visit = (value, path, depth) => {
      if (depth > 10 || visitedNodes >= 5000) return;
      visitedNodes += 1;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) visit(item, path, depth + 1);
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value).slice(0, 200)) {
          visit(item, [...path, key], depth + 1);
        }
        return;
      }
      const jsonPath = normalizeJsonPath(path.join("."));
      const text = normalize(typeof value === "string" ? value : String(value));
      if (jsonPath && available(text)) pairs.push([jsonPath, text]);
    };
    const appendDocument = (value, serialized = "") => {
      let raw = serialized;
      try { raw ||= JSON.stringify(value); } catch {
        complete = false;
        return;
      }
      if (!raw || seen.has(raw)) return;
      seen.add(raw);
      if (raw.length > maximumDocumentCharacters
        || documentCharacters + raw.length > maximumDocumentCharacters) {
        complete = false;
        return;
      }
      documents.push(value);
      documentCharacters += raw.length;
      visit(value, [], 0);
    };
    const parseNestedValue = (raw) => {
      if (!((raw.startsWith("{") && raw.endsWith("}"))
        || (raw.startsWith("[") && raw.endsWith("]")))) return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    };

    const sectionLabels = new Set(["json events", "source events"]);
    const observedSectionLabels = new Set();
    for (const heading of Array.from(document.querySelectorAll("h3")).filter(isVisible)) {
      const sectionLabel = normalizeLabel(heading.innerText || heading.textContent);
      if (!sectionLabels.has(sectionLabel)) continue;
      observedSectionLabels.add(sectionLabel);
      const table = heading.parentElement?.querySelector("table");
      if (!table || !isVisible(table)) {
        complete = false;
        continue;
      }
      const rows = Array.from(table.querySelectorAll("tr")).filter(isVisible);
      if (rows.length > maximumTableRows) complete = false;
      const document = {};
      let retainedRows = 0;
      for (const row of rows.slice(0, maximumTableRows)) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (!cells.length) continue;
        if (cells.length !== 2) {
          complete = false;
          continue;
        }
        const key = normalize(cells[0].innerText || cells[0].textContent);
        if (!key) {
          complete = false;
          continue;
        }
        const rawValue = String(cells[1].innerText ?? cells[1].textContent ?? "").trim();
        const value = parseNestedValue(rawValue);
        if (Object.hasOwn(document, key)) {
          document[key] = Array.isArray(document[key])
            ? [...document[key], value]
            : [document[key], value];
        } else document[key] = value;
        retainedRows += 1;
      }
      if (!retainedRows) {
        complete = false;
        continue;
      }
      appendDocument(document);
    }
    if (observedSectionLabels.size
      && [...sectionLabels].some((label) => !observedSectionLabels.has(label))) complete = false;

    const rawCandidates = Array.from(document.querySelectorAll(
      "[data-testid*='json' i],[class*='json' i],.field-wrapper pre,.field-wrapper code,.field-wrapper textarea,.field-wrapper .preplacer,.field-wrapper .value-wrapper,.field-wrapper .markdown"
    )).filter(isVisible).map((element) => String(element.value ?? element.textContent ?? "").trim())
      .filter((raw) => (raw.startsWith("{") && raw.endsWith("}"))
        || (raw.startsWith("[") && raw.endsWith("]")));
    if (rawCandidates.length > maximumCandidates) complete = false;
    for (const raw of rawCandidates.slice(0, maximumCandidates)) {
      if (seen.has(raw)) continue;
      if (raw.length > maximumDocumentCharacters) {
        complete = false;
        continue;
      }
      try { appendDocument(JSON.parse(raw), raw); } catch { complete = false; }
    }
    return { pairs, documents, complete };
  };

  const read = () => {
    const wrappers = Array.from(document.querySelectorAll(".field-wrapper")).filter(isVisible);
    const fields = {};
    for (const [key, configuredLabels] of Object.entries(settings.fieldLabels || {})) {
      const labels = Array.isArray(configuredLabels) ? configuredLabels : [];
      const accepted = labels.map(normalizeLabel);
      const fieldId = normalize(key).toLowerCase().replace(/[^a-z0-9]+/g, "");
      let value = "";
      for (const candidate of document.querySelectorAll(`.fieldId-${fieldId}`)) {
        if (!isVisible(candidate)) continue;
        const wrapper = candidate.matches(".field-wrapper") ? candidate : candidate.querySelector(".field-wrapper");
        const root = wrapper?.querySelector(".value-wrapper") || wrapper || candidate;
        value = extractValue(root);
        if (available(value)) break;
      }
      if (!available(value)) {
        for (const wrapper of wrappers) {
          const label = wrapper.querySelector("label");
          const actual = [
            normalizeLabel(label?.getAttribute("title")),
            normalizeLabel(label?.innerText || label?.textContent)
          ].filter(Boolean);
          if (!actual.some((entry) => accepted.includes(entry))) continue;
          value = extractValue(wrapper.querySelector(".value-wrapper") || wrapper);
          if (available(value)) break;
        }
      }
      fields[key] = available(value) ? normalize(value) : "";
    }
    const { pairs: jsonPairs, documents: alertJson, complete: alertJsonComplete } = collectJsonEvidence();
    const findJsonValue = (candidates = []) => {
      for (const candidate of candidates.map(normalizeJsonPath).filter(Boolean)) {
        const exact = jsonPairs.find(([path, value]) => path === candidate && available(value));
        if (exact) return exact[1];
        const suffix = jsonPairs.find(([path, value]) => path.endsWith(`.${candidate}`) && available(value));
        if (suffix) return suffix[1];
      }
      return "";
    };

    const semanticFields = {
      historicalSummary: settings.historicalSummaryLabels?.length
        ? settings.historicalSummaryLabels
        : ["Historical Summary"],
      historicalRecommendations: settings.historicalRecommendationLabels?.length
        ? settings.historicalRecommendationLabels
        : ["Historical Recommendations", "Customer Recommendations"]
    };
    for (const [key, labels] of Object.entries(semanticFields)) {
      fields[key] = "";
      const accepted = labels.map(normalizeLabel);
      for (const wrapper of wrappers) {
        const label = wrapper.querySelector("label");
        const actual = normalizeLabel(label?.getAttribute("title") || label?.innerText || label?.textContent);
        if (!accepted.includes(actual)) continue;
        const value = extractValue(wrapper.querySelector(".value-wrapper") || wrapper);
        if (available(value)) {
          fields[key] = normalize(value);
          break;
        }
      }
      if (!available(fields[key])) fields[key] = findJsonValue(labels);
    }

    const aliases = settings.fieldLabels || {};
    const normalizeKey = (value) => normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const pairs = [];
    for (const row of document.querySelectorAll("tr")) {
      if (!isVisible(row)) continue;
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) pairs.push([
        normalizeKey(cells[0].innerText || cells[0].textContent),
        normalize(cells[1].innerText || cells[1].textContent)
      ]);
    }
    const embedded = {};
    const jsonFields = {};
    for (const [key, candidates] of Object.entries(aliases)) {
      embedded[key] = "";
      jsonFields[key] = findJsonValue(candidates);
      for (const candidate of candidates.map(normalizeKey)) {
        const match = pairs.find(([label, value]) => label === candidate && available(value));
        if (match) {
          embedded[key] = match[1];
          break;
        }
      }
    }
    const combinedFields = Object.fromEntries(
      Object.keys(fields).map((key) => [key, first(fields[key], jsonFields[key], embedded[key])])
    );

    const headerTicket = normalize(document.querySelector(".header-inv-id")?.textContent);
    const urlTicket = location.href.match(/\/(\d+)\/?(?:[?#].*)?$/)?.[1] || "";
    let incidentName = normalize(
      document.querySelector(".header-inv-title")?.getAttribute("title")
      || document.querySelector(".header-inv-title")?.textContent
    );
    const activeTab = normalize(document.querySelector("[role='tab'][aria-selected='true'] .tab-label")?.textContent);
    if (activeTab && incidentName.toLowerCase().endsWith(` - ${activeTab}`.toLowerCase())) {
      incidentName = incidentName.slice(0, -(activeTab.length + 3)).trim();
    }

    const tabUrls = [];
    const wantedTabs = new Set([
      normalizeLabel(settings.incidentInfoTabLabel),
      normalizeLabel(settings.investigationTabLabel)
    ]);
    for (const link of document.querySelectorAll("a[role='tab'][href]")) {
      const label = normalizeLabel(link.querySelector(".tab-label")?.textContent || link.textContent);
      if (!wantedTabs.has(label)) continue;
      try {
        tabUrls.push(new URL(link.getAttribute("href"), location.href).toString());
      } catch {}
    }

    return {
      ticketId: headerTicket.match(/\d+/)?.[0] || urlTicket,
      incidentName,
      ...combinedFields,
      sourceIp: first(combinedFields.sourceIp, combinedFields.clientIp),
      sourceUsername: first(combinedFields.sourceUsername, combinedFields.clientUserName),
      alertJson,
      alertJsonComplete,
      tabUrls: [...new Set(tabUrls)]
    };
  };

  const deadline = Date.now() + Math.min(Number(settings.pageReadyTimeoutMs) || 20000, 120000);
  let previous = "";
  let stableSince = Date.now();
  let result = read();
  while (Date.now() < deadline) {
    const signature = JSON.stringify(result);
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 500 && result.ticketId && !incidentFieldsBusy()) {
      const requiredFields = Array.isArray(settings.requiredFields) ? settings.requiredFields : [];
      const requiredAnyFields = Array.isArray(settings.requiredAnyFields) ? settings.requiredAnyFields : [];
      const hasRequirements = requiredFields.length || requiredAnyFields.length || settings.requireAlertJson;
      const allFieldsReady = requiredFields.every((key) => available(result[key]));
      const anyFieldReady = !requiredAnyFields.length
        || requiredAnyFields.some((key) => available(result[key]));
      const alertJsonReady = !settings.requireAlertJson
        || (result.alertJsonComplete && result.alertJson.length > 0);
      const defaultReady = Object.entries(result).some(([key, value]) =>
          !["ticketId", "tabUrls", "alertJson", "alertJsonComplete", "incidentName"].includes(key) && available(value));
      const requiredReady = allFieldsReady && anyFieldReady && alertJsonReady;
      const readyForViewDiscovery = settings.allowPartialForTabDiscovery
        && settings.allowTabDiscovery && result.tabUrls.length > 0;
      if (hasRequirements ? requiredReady || readyForViewDiscovery
        : defaultReady || (settings.allowTabDiscovery && result.tabUrls.length > 0)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = read();
  }
  const partialViewDiscovery = settings.allowPartialForTabDiscovery
    && settings.allowTabDiscovery && result.tabUrls.length > 0;
  if (incidentFieldsBusy() && !partialViewDiscovery) {
    throw new Error("XSOAR incident fields did not finish loading before the timeout.");
  }
  const missingRequiredFields = (Array.isArray(settings.requiredFields) ? settings.requiredFields : [])
    .filter((key) => !available(result[key]));
  if (missingRequiredFields.length && !partialViewDiscovery) {
    throw new Error(`Required incident fields did not become ready: ${missingRequiredFields.join(", ")}.`);
  }
  const requiredAnyFields = Array.isArray(settings.requiredAnyFields) ? settings.requiredAnyFields : [];
  if (requiredAnyFields.length && !requiredAnyFields.some((key) => available(result[key])) && !partialViewDiscovery) {
    throw new Error("Required historic resolution fields did not become ready.");
  }
  return result;
}

export async function extractSearchResultsFromPage(options) {
  const normalizedPath = (value) => value.length > 1 ? value.replace(/\/+$/, "") : value;
  const assertCurrentPage = () => {
    const currentUrl = new URL(location.href);
    if (currentUrl.origin !== options.expectedOrigin
      || normalizedPath(currentUrl.pathname) !== normalizedPath(options.expectedPath)) {
      throw new Error("Historic search extraction refused an unexpected page URL.");
    }
  };
  assertCurrentPage();
  const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden"
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  };
  const ticketPattern = /\/(?:incident|investigation)\/(\d+)\/?$/i;
  const incidentOverviewPattern = /\/incident\d+\/(\d+)\/overview\/?$/i;
  let configuredIncidentPattern;
  try {
    configuredIncidentPattern = options.incidentUrlPattern
      ? new RegExp(options.incidentUrlPattern)
      : null;
  } catch {
    throw new Error("Historic search extraction received an invalid incident URL pattern.");
  }
  const ticketIds = new Set();
  let initialLoadFinished = false;
  let initialBusyObserved = false;
  const initialSettleDeadline = Date.now() + 500;
  const collect = () => {
    assertCurrentPage();
    const root = document.querySelector("[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page")
      || document.body;
    const busy = Array.from(root.querySelectorAll("[aria-busy='true'],.loading,.spinner"))
      .some(isVisible);
    if (!initialLoadFinished) {
      if (busy) {
        ticketIds.clear();
        initialBusyObserved = true;
      } else if (initialBusyObserved || Date.now() >= initialSettleDeadline) {
        initialLoadFinished = true;
      }
    }
    if (initialLoadFinished && !busy) {
      for (const link of root.querySelectorAll("a[href]")) {
        if (!isVisible(link)) continue;
        let url;
        try { url = new URL(link.getAttribute("href"), location.href); } catch { continue; }
        const configuredTicketId = configuredIncidentPattern?.test(`${url.pathname}${url.search}${url.hash}`)
          ? url.pathname.match(/\/(\d+)\/?$/)?.[1]
          : "";
        const visibleTicketId = link.closest?.("tr,[role='row'],.row")
          ? normalize(link.textContent).match(/^#(\d+)$/)?.[1]
          : "";
        const ticketId = url.pathname.match(ticketPattern)?.[1]
          || url.pathname.match(incidentOverviewPattern)?.[1]
          || configuredTicketId
          || visibleTicketId;
        if (ticketId && url.origin === location.origin) ticketIds.add(ticketId);
      }
    }
    const paging = normalize(document.querySelector(".table-paging-message")?.textContent);
    const pagingMatch = paging.match(/([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+)/i);
    const pagingEnd = pagingMatch ? Number(pagingMatch[2].replace(/,/g, "")) : 0;
    const pagingTotal = pagingMatch ? Number(pagingMatch[3].replace(/,/g, "")) : 0;
    const pagingComplete = Boolean(pagingTotal && pagingEnd >= pagingTotal);
    const pagingUnknown = Boolean(paging && !pagingMatch);
    const empty = Array.from(document.querySelectorAll(".no-data,.empty-table,.no-results"))
      .some(isVisible);
    return { root, paging, pagingComplete, pagingEnd, pagingTotal, pagingUnknown, empty, busy };
  };

  const deadline = Date.now() + Math.min(Number(options.timeoutMs) || 20000, 120000);
  let previous = "";
  let stableSince = Date.now();
  let state = collect();
  while (Date.now() < deadline) {
    const signature = `${initialLoadFinished}|${state.paging}|${state.empty}|${[...ticketIds].join(",")}`;
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    } else if (initialLoadFinished && !state.busy
      && (state.empty || state.pagingComplete || state.pagingUnknown || (!state.paging && ticketIds.size > 0))
      && Date.now() - stableSince >= 750) {
      break;
    }
    if (initialLoadFinished) {
      const scrollHost = state.root.querySelector(".fixedDataTableLayout_rowsContainer,[role='rowgroup']") || state.root;
      if ("scrollTop" in scrollHost) scrollHost.scrollTop += Math.max(300, scrollHost.clientHeight || 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    state = collect();
  }
  if (!state.empty && !ticketIds.size && !state.paging) {
    throw new Error("XSOAR historic search results did not become ready before the timeout.");
  }
  const maxResults = Math.max(1, Number(options.maxResults) || 5);
  const allTicketIds = [...ticketIds].sort((left, right) => Number(right) - Number(left));
  const sortedTicketIds = allTicketIds.slice(0, maxResults);
  assertCurrentPage();
  return {
    ticketIds: sortedTicketIds,
    truncated: allTicketIds.length > maxResults
      || Boolean(state.pagingTotal && state.pagingEnd < state.pagingTotal)
      || state.pagingUnknown
  };
}
