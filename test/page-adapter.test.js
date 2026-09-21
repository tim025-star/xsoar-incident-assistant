import test from "node:test";
import assert from "node:assert/strict";

import { extractIncidentFromPage, extractSearchResultsFromPage } from "../src/page-adapter.js";

const visible = { offsetWidth: 1, offsetHeight: 1, getClientRects: () => [1] };

function tableCell(value) {
  return { ...visible, value: undefined, innerText: String(value), textContent: String(value) };
}

function keyValueTable(entries) {
  const rows = entries.map(([key, value]) => {
    const cells = [tableCell(key), tableCell(value)];
    return { ...visible, cells, querySelectorAll: (selector) => selector === "td" ? cells : [] };
  });
  return { ...visible, rows, querySelectorAll: (selector) => selector === "tr" ? rows : [] };
}

function sectionHeading(label, table) {
  return {
    ...visible,
    innerText: label,
    textContent: label,
    parentElement: { querySelector: (selector) => selector === "table" ? table : null }
  };
}

function incidentPage({ headings = () => [], extraJsonCells = [], tabLinks = [] } = {}) {
  const ruleValue = {
    ...visible,
    getAttribute: () => null,
    innerText: "Synthetic Rule",
    textContent: "Synthetic Rule"
  };
  const valueRoot = {
    ...visible,
    querySelectorAll: (selector) => selector === ".text-field-display-value" ? [ruleValue] : [],
    cloneNode: () => ({
      querySelectorAll: () => [],
      innerText: "Synthetic Rule",
      textContent: "Synthetic Rule"
    })
  };
  const fieldWrapper = {
    ...visible,
    matches: (selector) => selector === ".field-wrapper",
    querySelector: (selector) => selector === ".value-wrapper" ? valueRoot : null
  };
  const allRows = () => headings().flatMap((heading) => heading.parentElement.querySelector("table")?.rows || []);
  const allCells = () => [...allRows().flatMap((row) => row.cells), ...extraJsonCells];
  return {
    querySelector(selector) {
      if (selector === ".header-inv-id") return { textContent: "4200" };
      if (selector === ".header-inv-title") return { getAttribute: () => "Synthetic incident" };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".field-wrapper" || selector === ".fieldId-rulename") return [fieldWrapper];
      if (selector === "h3") return headings();
      if (selector === "a[role='tab'][href]") return tabLinks;
      if (selector === "tr") return allRows();
      if (selector.includes(",td")) return allCells();
      return [];
    }
  };
}

function incidentSettings(overrides = {}) {
  return {
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
    pageReadyTimeoutMs: 1500,
    fieldLabels: { ruleName: ["Rule Name"] },
    incidentInfoTabLabel: "Incident Info",
    investigationTabLabel: "Investigation",
    ...overrides
  };
}

test("incident extraction reconstructs only the named XSOAR event tables", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const jsonEvents = keyValueTable([
    ["event_type", "authentication"],
    ["nested", JSON.stringify({ code: 7 })]
  ]);
  const sourceEvents = keyValueTable([
    ["source.ip", "192.0.2.10"],
    ["enabled", "true"]
  ]);
  const headings = [
    sectionHeading("JSON Events", jsonEvents),
    sectionHeading("Source Events", sourceEvents)
  ];
  const unrelated = tableCell(JSON.stringify({ unrelated: "must not be collected" }));

  globalThis.location = new URL("https://xsoar.example.test/Custom/GenericLayout/4200");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = incidentPage({ headings: () => headings, extraJsonCells: [unrelated] });

  try {
    const result = await extractIncidentFromPage(incidentSettings({ requireAlertJson: true }));
    assert.equal(result.ruleName, "Synthetic Rule");
    assert.deepEqual(result.alertJson, [
      { event_type: "authentication", nested: { code: 7 } },
      { "source.ip": "192.0.2.10", enabled: "true" }
    ]);
    assert.equal(result.alertJsonComplete, true);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("incident extraction does not let tab discovery bypass required alert JSON", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const started = Date.now();
  const headings = [
    sectionHeading("JSON Events", keyValueTable([["event_type", "authentication"]])),
    sectionHeading("Source Events", keyValueTable([["source.ip", "192.0.2.10"]]))
  ];
  const tabLink = {
    ...visible,
    textContent: "Investigation",
    getAttribute: () => "/Custom/GenericLayout/4200/investigation",
    querySelector: () => ({ textContent: "Investigation" })
  };

  globalThis.location = new URL("https://xsoar.example.test/Custom/GenericLayout/4200");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = incidentPage({
    headings: () => Date.now() - started >= 700 ? headings : [],
    tabLinks: [tabLink]
  });

  try {
    const result = await extractIncidentFromPage(incidentSettings({
      requireAlertJson: true,
      allowTabDiscovery: true
    }));
    assert.deepEqual(result.alertJson, [
      { event_type: "authentication" },
      { "source.ip": "192.0.2.10" }
    ]);
    assert.ok(Date.now() - started >= 700);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("incident extraction marks a missing event section incomplete", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const table = keyValueTable([["event_type", "authentication"]]);

  globalThis.location = new URL("https://xsoar.example.test/Custom/GenericLayout/4200");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = incidentPage({ headings: () => [sectionHeading("JSON Events", table)] });

  try {
    const result = await extractIncidentFromPage(incidentSettings());
    assert.equal(result.alertJsonComplete, false);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("incident extraction marks unsupported event-table rows incomplete", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const table = keyValueTable([["event_type", "authentication"]]);
  const unsupportedCells = [tableCell("unsupported")];
  table.rows.push({ ...visible, cells: unsupportedCells, querySelectorAll: () => unsupportedCells });
  const sourceTable = keyValueTable([["source.ip", "192.0.2.10"]]);

  globalThis.location = new URL("https://xsoar.example.test/Custom/GenericLayout/4200");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = incidentPage({ headings: () => [
    sectionHeading("JSON Events", table),
    sectionHeading("Source Events", sourceTable)
  ] });

  try {
    const result = await extractIncidentFromPage(incidentSettings());
    assert.equal(result.alertJsonComplete, false);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("incident extraction waits for required alert tables after mapped fields render", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const started = Date.now();
  const headings = [
    sectionHeading("JSON Events", keyValueTable([["event_type", "authentication"]])),
    sectionHeading("Source Events", keyValueTable([["source.ip", "192.0.2.10"]]))
  ];

  globalThis.location = new URL("https://xsoar.example.test/Custom/GenericLayout/4200");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = incidentPage({ headings: () => Date.now() - started >= 700 ? headings : [] });

  try {
    const result = await extractIncidentFromPage(incidentSettings({ requireAlertJson: true }));
    assert.deepEqual(result.alertJson, [
      { event_type: "authentication" },
      { "source.ip": "192.0.2.10" }
    ]);
    assert.ok(Date.now() - started >= 700);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search discards rows rendered before the filter finishes loading", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const started = Date.now();
  const visible = { offsetWidth: 1, offsetHeight: 1, getClientRects: () => [1] };
  const link = (ticketId) => ({ ...visible, getAttribute: () => `/incident/${ticketId}` });
  const root = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [link(Date.now() - started < 75 ? "9001" : "4199")];
      if (selector.includes("aria-busy")) return Date.now() - started < 75 ? [{ ...visible }] : [];
      return [];
    }
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector(selector) {
      if (selector === "[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page") return root;
      if (selector === ".table-paging-message") return { textContent: "1-1 of 1" };
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      maxResults: 5,
      timeoutMs: 2000
    });
    assert.deepEqual(result.ticketIds, ["4199"]);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search preserves collected rows across pagination loading", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const visible = { offsetWidth: 1, offsetHeight: 1, getClientRects: () => [1] };
  const link = (ticketId) => ({ ...visible, getAttribute: () => `/incident/${ticketId}` });
  let paginationStarted = 0;
  let scrollTop = 0;
  const root = {
    ...visible,
    clientHeight: 500,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) {
      scrollTop = value;
      if (!paginationStarted) paginationStarted = Date.now();
    },
    querySelector: () => null,
    querySelectorAll(selector) {
      const paginationAge = paginationStarted ? Date.now() - paginationStarted : 0;
      if (selector === "a[href]") return [link(paginationStarted && paginationAge >= 300 ? "4198" : "4199")];
      if (selector.includes("aria-busy")) return paginationStarted && paginationAge < 300 ? [{ ...visible }] : [];
      return [];
    }
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector(selector) {
      if (selector === "[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page") return root;
      if (selector === ".table-paging-message") return { textContent: "1-2 of 2" };
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      maxResults: 5,
      timeoutMs: 2500
    });
    assert.deepEqual(result.ticketIds, ["4199", "4198"]);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search recognises links that use the configured custom incident route", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const visible = { offsetWidth: 1, offsetHeight: 1, getClientRects: () => [1] };
  const link = { ...visible, getAttribute: () => "/Custom/GenericLayout/4199" };
  const root = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [link];
      return [];
    }
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector(selector) {
      if (selector === "[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page") return root;
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
      maxResults: 5,
      timeoutMs: 1000
    });
    assert.deepEqual(result.ticketIds, ["4199"]);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search recognises current XSOAR overview links without requiring URL query state", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const link = { ...visible, getAttribute: () => "/incident123/4199/overview" };
  const table = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "a[href]" ? [link] : []
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: table,
    querySelector(selector) {
      if (selector === ".regular-table") return table;
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
      maxResults: 5,
      timeoutMs: 1000
    });
    assert.deepEqual(result.ticketIds, ["4199"]);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search discards stale rows when loading starts after extraction", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const started = Date.now();
  const link = (ticketId) => ({ ...visible, getAttribute: () => `/incident/${ticketId}` });
  const root = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll(selector) {
      const age = Date.now() - started;
      if (selector === "a[href]") return [link(age < 250 ? "9001" : "4199")];
      if (selector.includes("aria-busy")) return age >= 100 && age < 250 ? [{ ...visible }] : [];
      return [];
    }
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector: (selector) => selector.includes("#incidents-page")
      ? root
      : selector === ".table-paging-message" ? { textContent: "1-1 of 1" } : null,
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      maxResults: 5,
      timeoutMs: 2000
    });
    assert.deepEqual(result.ticketIds, ["4199"]);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search reports truncation when paging proves more rows exist", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const link = { ...visible, getAttribute: () => "/incident/4199" };
  const root = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "a[href]" ? [link] : []
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector(selector) {
      if (selector === "[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page") return root;
      if (selector === ".table-paging-message") return { textContent: "1-1 of 2" };
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      maxResults: 5,
      timeoutMs: 1000
    });
    assert.deepEqual(result.ticketIds, ["4199"]);
    assert.equal(result.truncated, true);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});

test("historic search treats unrecognised paging text as truncated", async () => {
  const original = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const link = { ...visible, getAttribute: () => "/incident/4199" };
  const root = {
    ...visible,
    clientHeight: 500,
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "a[href]" ? [link] : []
  };

  globalThis.location = new URL("https://xsoar.example.test/incidents?query=expected");
  globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  globalThis.document = {
    body: root,
    querySelector(selector) {
      if (selector.includes("#incidents-page")) return root;
      if (selector === ".table-paging-message") return { textContent: "Page 1 of many" };
      return null;
    },
    querySelectorAll: () => []
  };

  try {
    const result = await extractSearchResultsFromPage({
      expectedOrigin: "https://xsoar.example.test",
      expectedPath: "/incidents",
      queryParameter: "query",
      expectedQuery: "expected",
      maxResults: 5,
      timeoutMs: 1000
    });
    assert.equal(result.truncated, true);
  } finally {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
});
