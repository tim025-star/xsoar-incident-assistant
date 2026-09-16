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
  const normalizeJsonPath = (value) => normalize(value).toLowerCase()
    .replace(/\[(?:\d+|\*)\]/g, ".")
    .split(/[^a-z0-9]+/)
    .filter((part) => part && !/^\d+$/.test(part))
    .join(".");
  const collectJsonPairs = () => {
    const pairs = [];
    const seen = new Set();
    let visitedNodes = 0;
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
    const candidates = Array.from(document.querySelectorAll(
      "pre,code,textarea,.preplacer,.value-wrapper,.markdown,[data-testid*='json' i],[class*='json' i],td"
    )).filter(isVisible).slice(0, 100);
    for (const element of candidates) {
      const raw = String(element.value ?? element.textContent ?? "").trim();
      if (!raw || raw.length > 256 * 1024 || seen.has(raw)
        || !((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]")))) continue;
      seen.add(raw);
      try {
        visit(JSON.parse(raw), [], 0);
      } catch {}
    }
    return pairs;
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
    const jsonPairs = collectJsonPairs();
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
      tabUrls: [...new Set(tabUrls)]
    };
  };

  const deadline = Date.now() + Math.min(Number(settings.pageReadyTimeoutMs) || 20000, 10000);
  let previous = "";
  let stableSince = Date.now();
  let result = read();
  while (Date.now() < deadline) {
    const signature = JSON.stringify(result);
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 500
      && result.ruleName && result.caseType) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = read();
  }
  return result;
}

export async function extractSearchResultsFromPage(options) {
  const normalizedPath = (value) => value.length > 1 ? value.replace(/\/+$/, "") : value;
  const assertCurrentUrl = () => {
    const currentUrl = new URL(location.href);
    if (currentUrl.origin !== options.expectedOrigin
      || normalizedPath(currentUrl.pathname) !== normalizedPath(options.expectedPath)
      || currentUrl.searchParams.get(options.queryParameter)?.trim() !== String(options.expectedQuery || "").trim()) {
      throw new Error("Search extraction refused an unexpected page URL.");
    }
  };
  assertCurrentUrl();
  const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden"
      && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  };
  const ticketPattern = /\/(?:incident|investigation)\/(\d+)\/?(?:[?#].*)?$/i;
  const ticketIds = new Set();
  const collect = () => {
    assertCurrentUrl();
    const root = document.querySelector("[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page")
      || document.body;
    for (const link of root.querySelectorAll("a[href]")) {
      if (!isVisible(link)) continue;
      let url;
      try {
        url = new URL(link.getAttribute("href"), location.href);
      } catch {
        continue;
      }
      const ticketId = url.pathname.match(ticketPattern)?.[1];
      if (ticketId && url.origin === location.origin) ticketIds.add(ticketId);
    }
    const paging = normalize(document.querySelector(".table-paging-message")?.textContent);
    const empty = Array.from(document.querySelectorAll(".no-data,.empty-table,.no-results"))
      .some(isVisible);
    const busy = Array.from(root.querySelectorAll("[aria-busy='true'],.loading,.spinner"))
      .some(isVisible);
    return { root, paging, empty, busy };
  };

  const deadline = Date.now() + Math.min(Number(options.timeoutMs) || 20000, 120000);
  let previous = "";
  let stableSince = Date.now();
  let state = collect();
  while (Date.now() < deadline) {
    const signature = `${state.paging}|${state.empty}|${[...ticketIds].join(",")}`;
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    } else if (!state.busy && (state.empty || ticketIds.size > 0 || state.paging)
      && Date.now() - stableSince >= 750) {
      break;
    }
    const scrollHost = state.root.querySelector(".fixedDataTableLayout_rowsContainer,[role='rowgroup']") || state.root;
    if ("scrollTop" in scrollHost) scrollHost.scrollTop += Math.max(300, scrollHost.clientHeight || 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    state = collect();
  }
  if (!state.empty && !ticketIds.size && !state.paging) {
    throw new Error("XSOAR search results did not become ready before the timeout.");
  }
  const sortedTicketIds = [...ticketIds]
    .sort((left, right) => Number(right) - Number(left))
    .slice(0, Math.max(1, Number(options.maxResults) || 5));
  assertCurrentUrl();
  return { ticketIds: sortedTicketIds };
}
