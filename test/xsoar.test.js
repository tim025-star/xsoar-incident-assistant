"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const {
  FIELD_LABELS,
  assertTrustedIncidentUrl,
  assessHistoricalResults,
  buildSearchQuery,
  buildTemplate,
  collectHistoricalDetails,
  collectSearchResults,
  createProgressReporter,
  ensureTimeRange,
  ensureNewestFirst,
  extractIncident,
  extractIncidentAcrossTabs,
  findActiveIncidentPage,
  findIncidentSearchInput,
  headlessBrowserChannelForProduct,
  openForegroundPage,
  searchSimilarIncidents,
  settleWithin,
  validateConfig,
  waitForIncidentReady
} = require("../lib/xsoar");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("AutoHotkey decodes JSON paths and escapes without corruption", (context) => {
  const candidates = [
    process.env.XSOAR_ASSISTANT_AHK_EXE,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "AutoHotkey", "v2", "AutoHotkey64.exe")
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    context.skip("Set XSOAR_ASSISTANT_AHK_EXE to an AutoHotkey v2 executable to run this integration check.");
    return;
  }
  const result = spawnSync(executable, [
    "/ErrorStdOut",
    path.join(__dirname, "ahk-json-regression.ahk")
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects non-positive and invalid primary timeouts", () => {
  const base = {
    cdpEndpoint: "http://127.0.0.1:9222",
    allowedXsoarOrigins: ["https://example.test"],
    notepadPlusPlusPath: "C:\\Tools\\Notepad++\\notepad++.exe",
    incidentUrlPattern: "\\/Custom\\/[^/]+\\/\\d+$",
    searchRequestUrlPattern: "^/api/search$",
    incidentsPath: "/Incidents",
    timeRangeLabel: "Last 7 days",
    navigationTimeoutMs: 1000,
    resultsTimeoutMs: 1000,
    excludeCurrentTicket: true,
    collectHistoricalDetails: true,
    historicalConcurrency: 2,
    historicalSummaryLabels: [],
    historicalRecommendationLabels: []
  };
  for (const [key, value] of [
    ["navigationTimeoutMs", 0],
    ["navigationTimeoutMs", "1000"],
    ["resultsTimeoutMs", "invalid"],
    ["paginationTimeoutMs", -1],
    ["historicalFieldsTimeoutMs", null]
  ]) {
    assert.throws(() => validateConfig({ ...base, [key]: value }), new RegExp(key));
  }
  assert.deepEqual(validateConfig({ ...base }), {
    ...base,
    paginationTimeoutMs: 1000,
    historicalFieldsTimeoutMs: 5000,
    debugMode: false,
    headless: false,
    headlessBrowserChannel: "auto",
    maxHistoricalIncidents: 5,
    incidentInfoTabLabel: "Incident Info",
    investigationTabLabel: "Investigation",
    fieldLabels: FIELD_LABELS,
    template: {
      greeting: "Hello",
      recommendationsHeading: "Recommended Actions",
      contactText: "If you require more information or would like to discuss this incident, contact your security operations team and quote the incident ID.",
      signOff: "Kind regards,",
      analystName: "",
      analystTitle: "Security Analyst"
    }
  });
});

test("rejects type-invalid configuration before browser automation starts", () => {
  const base = {
    cdpEndpoint: "http://127.0.0.1:9222",
    allowedXsoarOrigins: ["https://example.test"],
    notepadPlusPlusPath: "C:\\Tools\\Notepad++\\notepad++.exe",
    incidentUrlPattern: "\\/Custom\\/[^/]+\\/\\d+$",
    searchRequestUrlPattern: "^/api/search$",
    incidentsPath: "/Incidents",
    timeRangeLabel: "Last 7 days",
    navigationTimeoutMs: 1000,
    resultsTimeoutMs: 1000,
    excludeCurrentTicket: true,
    collectHistoricalDetails: true,
    historicalConcurrency: 2,
    historicalSummaryLabels: [],
    historicalRecommendationLabels: []
  };
  for (const [key, value] of [
    ["debugMode", "true"],
    ["headless", "true"],
    ["headlessBrowserChannel", "firefox"],
    ["headlessExecutablePath", ""],
    ["excludeCurrentTicket", "false"],
    ["collectHistoricalDetails", 1],
    ["historicalConcurrency", "2"],
    ["historicalConcurrency", 1.5],
    ["maxHistoricalIncidents", "5"],
    ["maxHistoricalIncidents", 0],
    ["historicalSummaryLabels", "Custom Summary"],
    ["historicalRecommendationLabels", ["valid", 4]],
    ["incidentsPath", ""],
    ["cdpEndpoint", "not a URL"],
    ["cdpEndpoint", "https://remote.example"],
    ["incidentUrlPattern", "["],
    ["searchRequestUrlPattern", "["],
    ["allowedXsoarOrigins", []],
    ["allowedXsoarOrigins", ["https://example.test/path"]],
    ["incidentInfoTabLabel", ""],
    ["investigationTabLabel", 5],
    ["fieldLabels", { unknownField: ["Unknown"] }],
    ["fieldLabels", { customerName: [] }]
  ]) {
    assert.throws(() => validateConfig({ ...base, [key]: value }), new RegExp(key));
  }
});

test("defaults debug mode off and accepts an explicit boolean", () => {
  const base = {
    cdpEndpoint: "http://127.0.0.1:9222",
    allowedXsoarOrigins: ["https://example.test"],
    notepadPlusPlusPath: "C:\\Tools\\Notepad++\\notepad++.exe",
    incidentUrlPattern: "\\/Custom\\/[^/]+\\/\\d+$",
    searchRequestUrlPattern: "^/api/search$",
    incidentsPath: "/incidents",
    timeRangeLabel: "Last 7 days",
    navigationTimeoutMs: 1000,
    resultsTimeoutMs: 1000,
    excludeCurrentTicket: true,
    collectHistoricalDetails: true,
    historicalConcurrency: 2,
    historicalSummaryLabels: [],
    historicalRecommendationLabels: []
  };
  assert.equal(validateConfig({ ...base }).debugMode, false);
  assert.equal(validateConfig({ ...base, debugMode: true }).debugMode, true);
  assert.equal(validateConfig({ ...base }).headless, false);
  assert.equal(validateConfig({ ...base, headless: true, headlessBrowserChannel: "msedge" }).headlessBrowserChannel, "msedge");
});

test("progress reporter emits only generic in-memory frames", async () => {
  const records = [];
  const report = createProgressReporter(true, (record) => records.push(record));

  await report("connecting_chrome", "ticket=4242 customer=Sensitive Customer");
  await report("collecting_results", ` ${"customer and ticket data ".repeat(50)} `);
  await report("unexpected_stage", "This detail must never leave the process.");

  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    type: "progress",
    stage: "connecting_chrome",
    detail: "Connecting to the browser.",
    sequence: 1
  });
  assert.equal(records[1].stage, "collecting_results");
  assert.equal(records[1].detail, "Collecting the matching incident IDs.");
  assert.equal(records[2].stage, "working");
  assert.doesNotMatch(JSON.stringify(records), /4242|Sensitive Customer|customer and ticket data/i);
});

test("maps Edge's CDP product identifier to the Playwright Edge channel", () => {
  assert.equal(headlessBrowserChannelForProduct("Edg/140.0.3485.94"), "msedge");
  assert.equal(headlessBrowserChannelForProduct("Microsoft Edge/140.0.3485.94"), "msedge");
  assert.equal(headlessBrowserChannelForProduct("Chrome/140.0.7339.81"), "chrome");
});

test("bounds a cleanup operation that never settles", async () => {
  const startedAt = Date.now();
  const result = await settleWithin(() => new Promise(() => {}), 30);
  assert.equal(result.completed, false);
  assert.equal(result.error, null);
  assert.ok(Date.now() - startedAt < 500);
});

test("one-shot helper exits only after bounded browser cleanup", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "search-xsoar.js"), "utf8");
  const ignore = fs.readFileSync(path.resolve(__dirname, "..", ".gitignore"), "utf8");
  assert.match(source, /settleWithin\(\(\)\s*=>\s*searchPage\.close\(\)/);
  assert.match(source, /settleWithin\(\(\)\s*=>\s*sourceIncidentPage\.bringToFront\(\)/);
  assert.match(source, /main\(\)\.catch\(/);
  assert.doesNotMatch(source, /process\.exit\(/);
  assert.ok(source.indexOf('"closing_search_tab"') < source.indexOf('"browser_complete"'));
  assert.doesNotMatch(source, /output\.json|template\.txt|progress\.json|appendLog|writeJsonAtomic|writeFile|appendFile|logs[\\/]/i);
  for (const legacyArtifact of ["output.json", "template.txt", "progress.json", "logs/"]) {
    assert.match(ignore, new RegExp(`^${legacyArtifact.replace(".", "\\.")}$`, "m"));
  }
  assert.match(ignore, /^\*-cdp-session\.txt$/m);
});

async function withBrowser(callback) {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    return await callback(browser);
  } finally {
    await browser.close();
  }
}

test("extracts a normal incident using label semantics", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="investigation-header">
        <span class="header-inv-id">#4242</span>
        <i class="demisto-icon icon-severity-high-24-r severity-color high"></i>
      </div>
      <div class="field-wrapper"><label title="The rule">Rule Name</label><div class="value-wrapper"><div class="text-field-display-value" title="rule &quot;one&quot;">rule "one"</div></div></div>
      <div class="field-wrapper"><label title="Type">Type</label><div class="value-wrapper"><div class="single-select-field-wrapper__single-value">EXAMPLE-TENANT</div></div></div>
      <div class="field-wrapper"><label title="Customer Name">Customer Name</label><div class="value-wrapper"><div class="text-field-display-value">Example Organization</div></div></div>
      <div class="field-wrapper"><label title="Description">Description</label><div class="value-wrapper"><div class="text-field-display-value">Observed a high severity event.</div><button>Edit</button></div></div>
    `);
    const incident = await extractIncident(page, {});
    assert.equal(incident.ticketId, "4242");
    assert.equal(incident.ruleName, 'rule "one"');
    assert.equal(incident.caseType, "EXAMPLE-TENANT");
    assert.equal(incident.customerName, "Example Organization");
    assert.equal(incident.severity, "high");
    assert.equal(incident.description, "Observed a high severity event.");
  });
});

test("prefers visible XSOAR fieldId anchors and ignores hidden duplicates", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#4242</span>
      <div class="section-item fieldId-rulename">
        <div class="field-wrapper"><label title="Rule Name">Rule Name</label>
          <div class="value-wrapper"><div class="text-field-display-value">visible-rule</div></div>
        </div>
      </div>
      <div class="section-item fieldId-rulename" style="display:none">
        <div class="field-wrapper"><label title="Rule Name">Rule Name</label>
          <div class="value-wrapper"><div class="text-field-display-value">hidden-rule</div></div>
        </div>
      </div>
      <div class="field-wrapper"><label title="Type">Type</label>
        <div class="value-wrapper"><div class="text-field-display-value">EXAMPLE-TENANT</div></div>
      </div>`);
    const incident = await extractIncident(page, {});
    assert.equal(incident.ruleName, "visible-rule");
    assert.equal(incident.caseType, "EXAMPLE-TENANT");
  });
});

test("ignores hidden values inside a visible XSOAR field anchor", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#4242</span>
      <div class="section-item fieldId-rulename">
        <div class="field-wrapper"><label title="Rule Name">Rule Name</label>
          <div class="value-wrapper">
            <div class="text-field-display-value" style="display:none">stale-rule</div>
            <div class="text-field-display-value">current-rule</div>
          </div>
        </div>
      </div>`);
    const incident = await extractIncident(page, {});
    assert.equal(incident.ruleName, "current-rule");
  });
});

test("extracts event details from rendered XSOAR fields and drilldown facts", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="investigation-header">
        <span class="header-inv-id">#424242</span>
        <span class="header-inv-title" title="Example Suspicious Export - Investigation">Example Suspicious Export - Investigation</span>
      </div>
      <a role="tab" aria-selected="true"><span class="tab-label">Investigation</span></a>
      <div class="field-wrapper"><label>Source IP</label><div class="value-wrapper"><div class="text-field-display-value">N/A</div></div></div>
      <div class="field-wrapper"><label>Destination IP</label><div class="value-wrapper"><div class="text-field-display-value">N/A</div></div></div>
      <span class="table-cell-data">
        <em><strong>Client IP address</strong></em>: 192.0.2.47 <a>(⭷)</a>
        <em><strong>Client principal name</strong></em>: EXAMPLE\\analyst <a>(⭷)</a>
        <em><strong>CompromisedEntity</strong></em>: example-host-01 <a>(⭷)</a>
      </span>
      <table>
        <tr><td>display_name</td><td>Synthetic event display name</td></tr>
        <tr><td>incident_web_url</td><td>https://security.example/incidents/example-event-001</td></tr>
        <tr><td>description</td><td>Synthetic service message.</td></tr>
      </table>`);
    const incident = await extractIncident(page, {});
    assert.equal(incident.ticketId, "424242");
    assert.equal(incident.incidentName, "Example Suspicious Export");
    assert.equal(incident.sourceIp, "192.0.2.47");
    assert.equal(incident.sourceUsername, "EXAMPLE\\analyst");
    assert.equal(incident.deviceHostname, "example-host-01");
    assert.equal(incident.destinationIp, "");
    assert.equal(incident.eventName, "Synthetic event display name");
    assert.equal(incident.detectionUrl, "https://security.example/incidents/example-event-001");
    assert.equal(incident.serviceMessage, "Synthetic service message.");
  });
});

test("uses a later usable alias when an earlier XSOAR field is N/A", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Device Hostname</label><div class="value-wrapper"><div class="text-field-display-value">N/A</div></div></div>
      <div class="field-wrapper"><label>Device Host Hostname</label><div class="value-wrapper"><div class="text-field-display-value">host-usable</div></div></div>`);
    const incident = await extractIncident(page, {});
    assert.equal(incident.deviceHostname, "host-usable");
  });
});

test("recognizes Device Name as a device identity", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Device Name</label><div class="value-wrapper"><div class="text-field-display-value">device-from-xsoar</div></div></div>`);
    const incident = await extractIncident(page, {});
    assert.equal(incident.deviceHostname, "device-from-xsoar");
  });
});

test("combines Incident Info and Investigation views without changing the working tab", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://xsoar.test/**", async (route) => {
      const investigation = new URL(route.request().url()).pathname.includes("/investigation/");
      const activeLabel = investigation ? "Analysis" : "Overview";
      await route.fulfill({ contentType: "text/html", body: `
        <div class="investigation-header">
          <span class="header-inv-id">#42</span>
          <span class="header-inv-title">Example incident - ${activeLabel}</span>
        </div>
        <a role="tab" aria-selected="${!investigation}" href="/Custom/info/42"><span class="tab-label">Overview</span></a>
        <a role="tab" aria-selected="${investigation}" href="/Custom/investigation/42"><span class="tab-label">Analysis</span></a>
        ${investigation ? `
          <div class="field-wrapper"><label>Occurred</label><div class="value-wrapper"><div class="date-display-value">Sep 3rd 2026 11:28:53</div></div></div>
          <div class="field-wrapper"><label>Event Name</label><div class="value-wrapper"><div class="text-field-display-value">Suspicious event</div></div></div>` : `
          <div class="field-wrapper"><label>Customer Name</label><div class="value-wrapper"><div class="text-field-display-value">Sample Customer</div></div></div>
          <div class="field-wrapper"><label>Rule Name</label><div class="value-wrapper"><div class="text-field-display-value">sample_rule</div></div></div>
          <div class="field-wrapper"><label>Type</label><div class="value-wrapper"><div class="text-field-display-value">EXAMPLE-TENANT</div></div></div>`}
      ` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://xsoar.test/Custom/info/42");
    const result = await extractIncidentAcrossTabs(context, incidentPage, {
      navigationTimeoutMs: 2000,
      incidentInfoTabLabel: "Overview",
      investigationTabLabel: "Analysis",
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    });
    assert.equal(result.incident.customerName, "Sample Customer");
    assert.equal(result.incident.ruleName, "sample_rule");
    assert.equal(result.incident.eventName, "Suspicious event");
    assert.equal(result.incident.occurred, "Sep 3rd 2026 11:28:53");
    assert.equal(result.incidentInfoUrl, "https://xsoar.test/Custom/info/42");
    assert.equal(incidentPage.url(), "https://xsoar.test/Custom/info/42");
    assert.equal(context.pages().length, 1);
    await context.close();
  });
});

test("waits for template-critical fields in a delayed Incident Info view", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://delayed.test/**", async (route) => {
      const investigation = new URL(route.request().url()).pathname.includes("/investigation/");
      await route.fulfill({ contentType: "text/html", body: investigation ? `
        <span class="header-inv-id">#42</span>
        <a role="tab" aria-selected="false" href="/Custom/info/42"><span class="tab-label">Incident Info</span></a>
        <a role="tab" aria-selected="true" href="/Custom/investigation/42"><span class="tab-label">Investigation</span></a>
        <div class="field-wrapper"><label>Occurred</label><div class="value-wrapper"><div class="date-display-value">Sep 3rd 2026 11:28:53</div></div></div>
        <div class="field-wrapper"><label>Event Name</label><div class="value-wrapper"><div class="text-field-display-value">Event</div></div></div>` : `
        <span class="header-inv-id">#42</span>
        <a role="tab" aria-selected="true" href="/Custom/info/42"><span class="tab-label">Incident Info</span></a>
        <a role="tab" aria-selected="false" href="/Custom/investigation/42"><span class="tab-label">Investigation</span></a>
        <div class="field-wrapper"><label>Customer Name</label><div class="value-wrapper"><div class="text-field-display-value">Customer</div></div></div>
        <div id="late"></div>
        <script>setTimeout(() => {
          document.querySelector('#late').innerHTML =
            '<div class="field-wrapper"><label>Rule Name</label><div class="value-wrapper"><div class="text-field-display-value">late_rule</div></div></div>' +
            '<div class="field-wrapper"><label>Type</label><div class="value-wrapper"><div class="text-field-display-value">TEST-TENANT</div></div></div>';
        }, 900);</script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://delayed.test/Custom/info/42");
    await waitForIncidentReady(incidentPage, 2000);
    const result = await extractIncidentAcrossTabs(context, incidentPage, {
      navigationTimeoutMs: 2000,
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    });
    assert.equal(result.incident.ruleName, "late_rule");
    assert.equal(result.incident.caseType, "TEST-TENANT");
    await context.close();
  });
});

test("extracts the supplied XSOAR incident fixture when available", async (context) => {
  const fixturePath = process.env.XSOAR_ASSISTANT_INCIDENT_FIXTURE;
  if (!fixturePath) {
    context.skip("Set XSOAR_ASSISTANT_INCIDENT_FIXTURE to run the local integration fixture.");
    return;
  }

  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(require("node:fs").readFileSync(fixturePath, "utf8"), { waitUntil: "domcontentloaded" });
    const incident = await extractIncident(page, {
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    });
    assert.equal(incident.ticketId, "4242");
    assert.ok(incident.ruleName, "Rule Name should be extracted");
    assert.ok(incident.caseType, "Type should be extracted");
    assert.ok(incident.customerName, "Customer Name should be extracted");
    assert.ok(incident.descriptionLong, "Description Long should be extracted");
  });
});

test("collects the supplied XSOAR search fixture when available", async (context) => {
  const fixturePath = process.env.XSOAR_ASSISTANT_SEARCH_FIXTURE;
  if (!fixturePath) {
    context.skip("Set XSOAR_ASSISTANT_SEARCH_FIXTURE to run the local integration fixture.");
    return;
  }

  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(require("node:fs").readFileSync(fixturePath, "utf8"), { waitUntil: "domcontentloaded" });
    const result = await collectSearchResults(page, "4242", true, 1000);
    assert.equal(result.matches, 5);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), [
      "99831", "99822", "99813", "99803", "99795"
    ]);
  });
});

test("discovers the rendered same-origin incidents route instead of assuming path casing", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    const navigatedPaths = [];
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().isNavigationRequest()) navigatedPaths.push(url.pathname);
      if (url.pathname === "/Custom/tab/999") {
        await route.fulfill({
          contentType: "text/html",
          body: `
            <a href="/Incidents" style="display:none">Incidents</a>
            <a href="https://outside.test/incidents">Incidents</a>
            <a href="/incidents">Incidents</a>`
        });
        return;
      }
      if (url.pathname === "/incidents") {
        await route.fulfill({
          contentType: "text/html",
          body: `
            <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
            <input placeholder="Search in incidents">
            <div id="results">
              <a class="investigation-id" href="/incident/100">#100</a>
              <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>
            </div>
            <script>
              document.querySelector('input').addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                setTimeout(() => {
                  document.querySelector('#results').innerHTML =
                    '<a href="/incident/200">#200</a>' +
                    '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
                }, 25);
              });
            </script>`
        });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: "<main>Wrong route</main>" });
    });

    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999",
      ruleName: "sample_rule",
      caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents",
      timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 500,
      resultsTimeoutMs: 1000,
      paginationTimeoutMs: 500,
      searchRequestUrlPattern: "",
      excludeCurrentTicket: true
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
      assert.ok(navigatedPaths.includes("/incidents"));
      assert.ok(!navigatedPaths.includes("/Incidents"));
    } finally {
      await result.searchPage.close();
    }
  });
});

test("finds the selected time range semantically when XSOAR classes change", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(200);
    await page.setContent('<button aria-label="Time range">Last 7 days</button>');
    await ensureTimeRange(page, "Last 7 days", 200);
  });
});

test("does not mistake an unrelated visible button for the time-range control", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(300);
    await page.setContent('<button id="unrelated">Refresh</button>');
    await page.locator("#unrelated").evaluate((button) => {
      button.addEventListener("click", () => { document.body.dataset.unrelatedClicked = "yes"; });
    });

    await assert.rejects(
      ensureTimeRange(page, "Last 7 days", 100),
      /did not expose a visible time-range control/i
    );
    assert.equal(await page.locator("body").getAttribute("data-unrelated-clicked"), null);
  });
});

test("rejects a time-range click that leaves the selected control unchanged", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="filters-header-date-picker"><button class="range-header">Last 30 days</button></div>
      <button id="range-option">Last 7 days</button>
      <div class="fixedDataTableLayout_main"><a class="investigation-id" href="/incident/1">#1</a></div>
      <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>`);
    await assert.rejects(
      () => ensureTimeRange(page, "Last 7 days", 400),
      /selected time range.*Last 7 days/i
    );
  });
});

test("selects the Incidents table search instead of the global header search", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <header class="xsoar-header-border-bottom">
        <input id="global-search" autocomplete="off" placeholder="Search in Incidents"
          class="xsoar-input header-search-input prompt focused">
      </header>
      <main class="incidents-page" id="incidents-page">
        <div class="details-view-search-content">
          <div class="filters-header-search">
            <div class="demisto-table-search-container">
              <input id="table-search" placeholder="Search in incidents"
                class="xsoar-input ellipsis" value="-status:closed -category:job">
            </div>
          </div>
        </div>
      </main>`);

    const input = await findIncidentSearchInput(page, 300);
    assert.equal(await input.getAttribute("id"), "table-search");
  });
});

test("activates the temporary search tab before navigating it", async () => {
  const calls = [];
  const page = {
    setDefaultTimeout(timeoutMs) { calls.push(["timeout", timeoutMs]); },
    async bringToFront() { calls.push(["front"]); },
    async goto(url, options) { calls.push(["goto", url, options]); }
  };
  const context = {
    async newPage() { calls.push(["newPage"]); return page; }
  };

  assert.equal(await openForegroundPage(context, "/Incidents", 1500), page);
  assert.deepEqual(calls, [
    ["newPage"],
    ["timeout", 1500],
    ["front"],
    ["goto", "/Incidents", { waitUntil: "domcontentloaded" }]
  ]);
});

test("rejects a navigation that redirects away from the trusted XSOAR origin", async () => {
  let finalUrl = "about:blank";
  let closed = false;
  const page = {
    setDefaultTimeout() {},
    async bringToFront() {},
    async goto() { finalUrl = "https://attacker.example/final"; },
    url() { return finalUrl; },
    async close() { closed = true; }
  };
  const context = { async newPage() { return page; } };
  await assert.rejects(
    () => openForegroundPage(
      context,
      "https://example.test/redirect",
      1500,
      "https://example.test"
    ),
    /left the selected XSOAR origin/i
  );
  assert.equal(closed, true);
});

test("rejects a headless incident URL after a cross-origin redirect", () => {
  assert.throws(
    () => assertTrustedIncidentUrl(
      "https://attacker.example/Custom/tab/999",
      "\\/Custom\\/[^/]+\\/\\d+$",
      ["https://example.test"],
      "Headless navigation"
    ),
    /headless navigation left the trusted XSOAR incident scope/i
  );
});

test("waits for results produced by the submitted query", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/Incidents") {
        await route.fulfill({
          contentType: "text/html",
          body: `
            <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
            <input placeholder="Search in incidents">
            <div id="results">
              <a class="investigation-id" href="/incident/100">#100</a>
              <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>
            </div>
            <script>
              document.querySelector('input').addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                setTimeout(() => {
                  document.querySelector('#results').innerHTML =
                    '<a class="investigation-id" href="/incident/200">#200</a>' +
                    '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
                }, 1800);
              });
            </script>`
        });
      } else {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
      }
    });

    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999",
      ruleName: "sample_rule",
      caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents",
      timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 5000,
      resultsTimeoutMs: 5000,
      excludeCurrentTicket: true
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("detects a submitted search when the whole result host is replaced", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/incidents/search-v2") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "200" }], total: 1 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results-host"><div class="fixedDataTableLayout_main">
          <a class="investigation-id" href="/incident/100">#100</a>
          <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>
        </div></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            setTimeout(() => {
              const replacement = document.createElement('div');
              replacement.id = 'results-host';
              replacement.innerHTML = '<div class="fixedDataTableLayout_main">' +
                '<a class="investigation-id" href="/incident/200">#200</a>' +
                '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>';
              document.querySelector('#results-host').replaceWith(replacement);
            }, 200);
          });
        </script>` });
    });

    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 1500, resultsTimeoutMs: 1500, excludeCurrentTicket: true
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("does not confuse a time-range refresh with the submitted query", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `
          <div class="filters-header-date-picker"><button class="range-header">Last 30 days</button></div>
          <button id="range-option">Last 7 days</button>
          <input placeholder="Search in incidents">
          <div id="results">
            <a class="investigation-id" href="/incident/100">#100</a>
            <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>
          </div>
          <script>
            const results = document.querySelector('#results');
            document.querySelector('#range-option').addEventListener('click', () => {
              document.querySelector('.range-header').textContent = 'Last 7 days';
              setTimeout(() => {
                results.innerHTML = '<a class="investigation-id" href="/incident/200">#200</a>' +
                  '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
              }, 250);
            });
            document.querySelector('input').addEventListener('keydown', (event) => {
              if (event.key !== 'Enter') return;
              setTimeout(() => {
                results.innerHTML = '<a class="investigation-id" href="/incident/300">#300</a>' +
                  '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
              }, 1800);
            });
          </script>`
      });
    });

    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999",
      ruleName: "sample_rule",
      caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents",
      timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 5000,
      resultsTimeoutMs: 5000,
      excludeCurrentTicket: true
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["300"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("waits through an intermediate search render", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            await fetch('/api/incidents/search-v2', {
              method: 'POST',
              body: JSON.stringify({ query: event.currentTarget.value })
            });
            setTimeout(() => document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/200">#200</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>', 200);
            setTimeout(() => document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/300">#300</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>', 1600);
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 5000, resultsTimeoutMs: 5000, excludeCurrentTicket: true
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["300"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("does not let an early network response finalize an intermediate render", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "300" }], total: 1 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            fetch('/api/search', { method: 'POST', body: JSON.stringify({ query: event.currentTarget.value }) });
            setTimeout(() => document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/200">#200</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>', 200);
            setTimeout(() => document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/300">#300</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>', 2400);
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 4000, resultsTimeoutMs: 4000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["300"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("accepts changed submitted-query results when XSOAR changes its request endpoint", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            setTimeout(() => document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/200">#200</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>', 100);
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/old-search-endpoint$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("accepts a changed cached result when no search request is emitted", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            setTimeout(() => document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/200">#200</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>', 100);
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("captures results that XSOAR updates while the search input is being filled", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    const stageTimes = new Map();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="2">
          <div role="columnheader" aria-sort="descending"><span class="header-label" title="ID">ID</span></div>
          <div id="rows"><a class="investigation-id" href="/incident/999">#999</a></div>
        </div>
        <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>
        <script>
          document.querySelector('input').addEventListener('input', () => {
            const ids = Array.from({ length: 25 }, (_, index) => 7036 - index);
            document.querySelector('#rows').innerHTML = ids.map((id) =>
              '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a>'
            ).join('');
            document.querySelector('[role=grid]').setAttribute('aria-rowcount', '26');
            document.querySelector('.table-paging-message').textContent =
              'Showing incidents 1 to 25 out of 25';
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, paginationTimeoutMs: 500,
      excludeCurrentTicket: true, maxHistoricalIncidents: 5,
      searchRequestUrlPattern: "^/api/search$"
    }, async (stage) => { stageTimes.set(stage, performance.now()); });
    try {
      assert.deepEqual(
        result.tickets.map((ticket) => ticket.ticketId),
        ["7036", "7035", "7034", "7033", "7032"]
      );
      assert.ok(
        stageTimes.get("collecting_results") - stageTimes.get("waiting_for_search") < 1000,
        "a complete result grid should confirm before the fallback timeout"
      );
      assert.ok(
        stageTimes.get("search_complete") - stageTimes.get("collecting_results") < 650,
        "confirmed results should not be settled a second time"
      );
    } finally {
      await result.searchPage.close();
    }
  });
});

test("accepts an already-active identical query with settled results", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    const query = buildSearchQuery("sample_rule", "EXAMPLE-TENANT");
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents" value='${query}'>
        <div id="results"><a class="investigation-id" href="/incident/200">#200</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("accepts an authoritative search response from an unrecognised endpoint", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/graphql") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "200" }], total: 1 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            await fetch('/api/graphql', {
              method: 'POST', body: JSON.stringify({ query: event.currentTarget.value })
            });
            document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/200">#200</a>' +
              '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("waits for every authoritative response row during progressive rendering", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "100" }, { id: "200" }], total: 2 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results" role="grid" aria-rowcount="2"><a class="investigation-id" href="/incident/9">#9</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            fetch('/api/search', { method: 'POST', body: JSON.stringify({ query: event.currentTarget.value }) });
            setTimeout(() => {
              document.querySelector('#results').setAttribute('aria-rowcount', '3');
              document.querySelector('#results').innerHTML =
                '<a class="investigation-id" href="/incident/100">#100</a>' +
                '<span class="table-paging-message">Showing incidents 1 to 2 out of 2</span>';
            }, 100);
            setTimeout(() => {
              document.querySelector('#results').innerHTML =
                '<a class="investigation-id" href="/incident/100">#100</a>' +
                '<a class="investigation-id" href="/incident/200">#200</a>' +
                '<span class="table-paging-message">Showing incidents 1 to 2 out of 2</span>';
            }, 1200);
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 3000, resultsTimeoutMs: 3000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["100", "200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("keeps complete authoritative membership validation after sorting", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "1" }, { id: "2" }, { id: "3" }], total: 3 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="4">
          <div role="columnheader"><span class="header-label" title="ID">ID</span></div>
          <div id="rows"><a class="investigation-id" href="/incident/100">#100</a></div>
        </div>
        <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>
        <script>
          const rows = document.querySelector('#rows');
          const paging = document.querySelector('.table-paging-message');
          document.querySelector('input').addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            await fetch('/api/search', { method: 'POST', body: JSON.stringify({ query: event.currentTarget.value }) });
            rows.innerHTML = [1, 2, 3].map(id => '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a>').join('');
            paging.textContent = 'Showing incidents 1 to 3 out of 3';
          });
          document.querySelector('.header-label').addEventListener('click', () => {
            rows.innerHTML = [9, 8, 7].map(id => '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a>').join('');
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    await assert.rejects(
      () => searchSimilarIncidents(context, incidentPage, {
        ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
      }, {
        incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
        navigationTimeoutMs: 2000, resultsTimeoutMs: 2000, paginationTimeoutMs: 1000,
        excludeCurrentTicket: true, maxHistoricalIncidents: 3,
        searchRequestUrlPattern: "^/api/search$"
      }),
      /search response did not match/i
    );
  });
});

test("accepts a successful retry and changed results after a matching request fails", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search-failed") {
        await route.abort("failed");
        return;
      }
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "200" }], total: 1 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            const query = event.currentTarget.value;
            fetch('/api/search-failed', {
              method: 'POST', body: JSON.stringify({ query })
            }).catch(() => {});
            setTimeout(async () => {
              await fetch('/api/search', {
                method: 'POST',
                body: JSON.stringify({ envelope: JSON.stringify({ query }) })
              });
              document.querySelector('#results').innerHTML =
                '<a class="investigation-id" href="/incident/200">#200</a>' +
                '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
            }, 700);
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 2000, resultsTimeoutMs: 2000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search(?:-failed)?$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["200"]);
    } finally {
      await result.searchPage.close();
    }
  });
});

test("does not treat query-bearing telemetry as an unchanged search", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/telemetry") {
        await route.fulfill({ contentType: "application/json", body: "{}" });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          setInterval(() => fetch('/api/telemetry', {
            method: 'POST',
            body: JSON.stringify({ query: document.querySelector('input').value })
          }), 100);
          setTimeout(() => {
            document.querySelector('#results').innerHTML =
              '<a class="investigation-id" href="/incident/200">#200</a>' +
              '<span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>';
          }, 800);
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    await assert.rejects(
      () => searchSimilarIncidents(context, incidentPage, {
        ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
      }, {
        incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
        navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
        searchRequestUrlPattern: "^/api/search$"
      }),
      /did not confirm/i
    );
  });
});

test("accepts an authoritative successful search whose no-match result is unchanged", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [], total: 0 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><div class="no-results">No incidents found</div><span class="table-paging-message">Showing incidents 0 to 0 out of 0</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key === 'Enter') fetch('/api/search', {
              method: 'POST', body: JSON.stringify({ query: event.currentTarget.value })
            });
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const startedAt = Date.now();
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 5000, resultsTimeoutMs: 5000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.equal(result.matches, 0);
      assert.ok(Date.now() - startedAt < 2500, "authoritative unchanged search should finish early");
    } finally {
      await result.searchPage.close();
    }
  });
});

test("accepts an authoritative response matching unchanged incident rows", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "100" }], total: 1 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key === 'Enter') fetch('/api/search', {
              method: 'POST', body: JSON.stringify({ query: event.currentTarget.value })
            });
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    const startedAt = Date.now();
    const result = await searchSimilarIncidents(context, incidentPage, {
      ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
    }, {
      incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
      navigationTimeoutMs: 5000, resultsTimeoutMs: 5000, excludeCurrentTicket: true,
      searchRequestUrlPattern: "^/api/search$"
    });
    try {
      assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["100"]);
      assert.ok(Date.now() - startedAt < 2500, "matching unchanged search should finish early");
    } finally {
      await result.searchPage.close();
    }
  });
});

test("rejects an authoritative response that contradicts stale incident rows", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/search") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ data: [{ id: "300" }], total: 1 })
        });
        return;
      }
      if (url.pathname !== "/Incidents") {
        await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `
        <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
        <input placeholder="Search in incidents">
        <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
        <script>
          document.querySelector('input').addEventListener('keydown', (event) => {
            if (event.key === 'Enter') fetch('/api/search', {
              method: 'POST', body: JSON.stringify({ query: event.currentTarget.value })
            });
          });
        </script>` });
    });
    const incidentPage = await context.newPage();
    await incidentPage.goto("https://example.test/Custom/tab/999");
    await assert.rejects(
      () => searchSimilarIncidents(context, incidentPage, {
        ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
      }, {
        incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
        navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
        searchRequestUrlPattern: "^/api/search$"
      }),
      /did not confirm/i
    );
  });
});

test("does not accept unchanged results after the submitted request fails", async () => {
  await withBrowser(async (browser) => {
    for (const failureMode of ["abort", "http-500"]) {
      const context = await browser.newContext();
      try {
        await context.route("https://example.test/**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/api/search") {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (failureMode === "abort") await route.abort("failed");
            else await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
            return;
          }
          if (url.pathname !== "/Incidents") {
            await route.fulfill({ contentType: "text/html", body: "<title>Incident</title>" });
            return;
          }
          await route.fulfill({ contentType: "text/html", body: `
            <div class="filters-header-date-picker"><span class="range-header">Last 7 days</span></div>
            <input placeholder="Search in incidents">
            <div class="spinner" hidden>Loading</div>
            <div id="results"><a class="investigation-id" href="/incident/100">#100</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
            <script>
              document.querySelector('input').addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                const spinner = document.querySelector('.spinner');
                spinner.hidden = false;
                fetch('/api/search', {
                  method: 'POST',
                  body: JSON.stringify({ query: event.currentTarget.value })
                }).catch(() => {}).finally(() => { spinner.hidden = true; });
              });
            </script>` });
        });
        const incidentPage = await context.newPage();
        await incidentPage.goto("https://example.test/Custom/tab/999");
        await assert.rejects(
          () => searchSimilarIncidents(context, incidentPage, {
            ticketId: "999", ruleName: "sample_rule", caseType: "EXAMPLE-TENANT"
          }, {
            incidentsPath: "/Incidents", timeRangeLabel: "Last 7 days",
            navigationTimeoutMs: 1000, resultsTimeoutMs: 1000, excludeCurrentTicket: true,
            searchRequestUrlPattern: "^/api/search$"
          }),
          /did not confirm/i,
          failureMode
        );
      } finally {
        await context.close();
      }
    }
  });
});

test("materializes every row in a virtualized result table", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="6">
        <div class="fixedDataTableLayout_rowsContainer" style="width:400px;height:120px"></div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 5 out of 5</span>
      <script>
        const chunks = [[1, 2], [3, 4], [5]];
        let chunk = 0;
        const container = document.querySelector('.fixedDataTableLayout_rowsContainer');
        function render() {
          container.innerHTML = chunks[chunk].map((id) =>
            '<div class="public_fixedDataTable_bodyRow" role="row" aria-rowindex="' + (id + 1) + '">' +
            '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a></div>'
          ).join('');
        }
        container.addEventListener('wheel', (event) => {
          event.preventDefault();
          if (event.deltaY > 0 && chunk < chunks.length - 1) chunk += 1;
          if (event.deltaY < 0) chunk = 0;
          render();
        });
        render();
      </script>`);

    const result = await collectSearchResults(page, "999", true, 3000);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["1", "2", "3", "4", "5"]);
    assert.equal(result.collectionIncomplete, false);
  });
});

test("limits historical review without requiring every reported XSOAR row to render", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="21">
        ${[101, 102, 103, 104, 105].map((id) => `
          <div class="public_fixedDataTable_bodyRow" role="row">
            <a class="investigation-id" href="/incident/${id}">#${id}</a>
          </div>`).join("")}
      </div>
      <span class="table-paging-message">Showing incidents 1 to 20 out of 20</span>`);

    const expectedResult = {
      total: 20,
      ticketIds: Array.from({ length: 20 }, (_, index) => String(101 + index))
    };
    const result = await collectSearchResults(page, "999", true, 1000, 500, "", expectedResult, 5);
    assert.equal(result.matches, 20);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["101", "102", "103", "104", "105"]);
    assert.equal(result.collectionLimited, true);
    assert.equal(result.collectionIncomplete, false);
  });
});

test("uses fewer than five historical incidents when XSOAR exposes only those rows", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="21">
        ${[105, 104, 103].map((id) => `<a class="investigation-id" href="/incident/${id}">#${id}</a>`).join("")}
      </div>
      <span class="table-paging-message">Showing incidents 1 to 20 out of 20</span>`);
    const result = await collectSearchResults(page, "999", true, 1000, 500, "", null, 5);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["105", "104", "103"]);
    assert.equal(result.collectionIncomplete, true);
  });
});

test("forces incident IDs into newest-first order before applying the history limit", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <aside role="grid">
        <div role="columnheader"><span class="header-label" title="ID">ID</span></div>
      </aside>
      <div id="results-grid" role="grid" aria-rowcount="4">
        <div role="columnheader"><span class="header-label" title="ID">ID</span></div>
        <div id="rows"></div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 3 out of 3</span>
      <script>
        const orders = [[1, 2, 3], [3, 2, 1]];
        let clicks = 0;
        const rows = document.querySelector('#rows');
        const render = (ids) => {
          rows.innerHTML = ids.map((id) => '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a>').join('');
        };
        render([2, 1, 3]);
        document.querySelector('#results-grid .header-label').addEventListener('click', () => {
          render(orders[Math.min(clicks, orders.length - 1)]);
          clicks += 1;
        });
        window.sortClicks = () => clicks;
        document.querySelector('aside .header-label').addEventListener('click', () => {
          window.decoySortClicks = (window.decoySortClicks || 0) + 1;
        });
      </script>`);
    await ensureNewestFirst(page, 2000);
    const ids = await page.locator("a.investigation-id").allTextContents();
    assert.deepEqual(ids, ["#3", "#2", "#1"]);
    assert.equal(await page.evaluate(() => window.sortClicks()), 2);
    assert.equal(await page.evaluate(() => window.decoySortClicks || 0), 0);
  });
});

test("accepts a verified descending sort when XSOAR only updates the column state", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="grid" aria-rowcount="4">
        <div role="columnheader"><span class="header-label" title="ID">ID</span></div>
        <div id="rows">
          <a class="investigation-id" href="/incident/3">#3</a>
          <a class="investigation-id" href="/incident/2">#2</a>
          <a class="investigation-id" href="/incident/1">#1</a>
        </div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 3 out of 3</span>
      <script>
        let clicks = 0;
        document.querySelector('.header-label').addEventListener('click', (event) => {
          clicks += 1;
          event.currentTarget.classList.add('sorted-descending');
        });
        window.sortClicks = () => clicks;
      </script>`);
    await ensureNewestFirst(page, 1000);
    assert.equal(await page.evaluate(() => window.sortClicks()), 0);
    assert.deepEqual(await page.locator("a.investigation-id").allTextContents(), ["#3", "#2", "#1"]);
  });
});

test("waits for sorted rows instead of accepting an earlier header mutation", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="grid" aria-rowcount="4">
        <div role="columnheader"><span class="header-label" title="ID">ID</span></div>
        <div id="rows"><a class="investigation-id" href="/incident/2">#2</a><a class="investigation-id" href="/incident/3">#3</a><a class="investigation-id" href="/incident/1">#1</a></div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 3 out of 3</span>
      <script>
        let clicks = 0;
        const header = document.querySelector('.header-label');
        header.addEventListener('click', () => {
          clicks += 1;
          header.classList.add('sort-requested');
          setTimeout(() => document.querySelector('#rows').innerHTML =
            '<a class="investigation-id" href="/incident/3">#3</a><a class="investigation-id" href="/incident/2">#2</a><a class="investigation-id" href="/incident/1">#1</a>', 500);
        });
        window.sortClicks = () => clicks;
      </script>`);
    await ensureNewestFirst(page, 2000);
    assert.equal(await page.evaluate(() => window.sortClicks()), 1);
    assert.deepEqual(await page.locator("a.investigation-id").allTextContents(), ["#3", "#2", "#1"]);
  });
});

test("ignores an unrelated page spinner while confirming the result-grid sort", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="spinner">Unrelated widget loading</div>
      <div role="grid" aria-rowcount="4">
        <div role="columnheader"><span class="header-label" title="ID">ID</span></div>
        <div id="rows"><a class="investigation-id" href="/incident/1">#1</a><a class="investigation-id" href="/incident/3">#3</a><a class="investigation-id" href="/incident/2">#2</a></div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 3 out of 3</span>
      <script>document.querySelector('.header-label').onclick = () => document.querySelector('#rows').innerHTML =
        '<a class="investigation-id" href="/incident/3">#3</a><a class="investigation-id" href="/incident/2">#2</a><a class="investigation-id" href="/incident/1">#1</a>';</script>`);
    await ensureNewestFirst(page, 1000);
    assert.deepEqual(await page.locator("a.investigation-id").allTextContents(), ["#3", "#2", "#1"]);
  });
});

test("sorts a virtualized result whose initial viewport exposes one row", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="4">
        <div role="columnheader" aria-sort="none"><span class="header-label" title="ID">ID</span></div>
        <div class="fixedDataTableLayout_rowsContainer" style="height:80px"></div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 3 out of 3</span>
      <script>
        let order = [1, 2, 3];
        let index = 0;
        let clicks = 0;
        const rows = document.querySelector('.fixedDataTableLayout_rowsContainer');
        const render = () => rows.innerHTML = '<div class="public_fixedDataTable_bodyRow" aria-rowindex="' + (index + 2) + '"><a class="investigation-id" href="/incident/' + order[index] + '">#' + order[index] + '</a></div>';
        rows.addEventListener('wheel', (event) => { event.preventDefault(); index = event.deltaY > 0 ? Math.min(index + 1, 2) : 0; render(); });
        document.querySelector('.header-label').addEventListener('click', () => {
          clicks += 1;
          order = [3, 2, 1];
          index = 0;
          document.querySelector('[role=columnheader]').setAttribute('aria-sort', 'descending');
          render();
        });
        window.sortClicks = () => clicks;
        render();
      </script>`);
    await ensureNewestFirst(page, 2000);
    assert.equal(await page.evaluate(() => window.sortClicks()), 1);
  });
});

test("collects incident links only from the results grid", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <aside><a class="investigation-id" href="/incident/777">#777</a></aside>
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="2">
        <div class="fixedDataTableLayout_rowsContainer">
          <div class="public_fixedDataTable_bodyRow" role="row" aria-rowindex="2">
            <a class="investigation-id" href="/incident/100">#100</a>
          </div>
        </div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 1 out of 1</span>`);
    const result = await collectSearchResults(page, "999", true, 1000);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["100"]);
  });
});

test("rejects stale IDs discovered while materializing a virtualized response", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="4">
        <div class="fixedDataTableLayout_rowsContainer" style="height:100px"></div>
      </div>
      <span class="table-paging-message">Showing incidents 1 to 3 out of 3</span>
      <script>
        const chunks = [100, 400, 500];
        let chunk = 0;
        const root = document.querySelector('.fixedDataTableLayout_rowsContainer');
        function render() {
          const id = chunks[chunk];
          root.innerHTML = '<div class="public_fixedDataTable_bodyRow" aria-rowindex="' + (chunk + 2) + '">' +
            '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a></div>';
        }
        root.addEventListener('wheel', (event) => {
          event.preventDefault();
          if (event.deltaY > 0 && chunk < chunks.length - 1) chunk += 1;
          if (event.deltaY < 0) chunk = 0;
          render();
        });
        render();
      </script>`);
    await assert.rejects(
      () => collectSearchResults(page, "999", true, 2000, 2000, "", {
        total: 3,
        ticketIds: ["100", "200", "300"]
      }),
      /search response did not match/i
    );
  });
});

test("accepts a complete result containing exactly 100 pages", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="2">
        <div class="fixedDataTableLayout_rowsContainer">
          <div class="public_fixedDataTable_bodyRow" role="row" aria-rowindex="2">
            <a class="investigation-id" href="/incident/1">#1</a>
          </div>
        </div>
      </div>
      <div class="paging"><span class="page-number">1/100</span><span class="paging-next"> &gt;</span></div>
      <div class="spinner" hidden>Loading</div>
      <span class="table-paging-message">Showing incidents 1 to 1 out of 100</span>
      <script>
        let pageNumber = 1;
        document.querySelector('.paging-next').addEventListener('click', () => {
          const spinner = document.querySelector('.spinner');
          spinner.hidden = false;
          pageNumber += 1;
          document.querySelector('.page-number').textContent = pageNumber + '/100';
          document.querySelector('.investigation-id').href = '/incident/' + pageNumber;
          document.querySelector('.investigation-id').textContent = '#' + pageNumber;
          document.querySelector('.table-paging-message').textContent =
            'Showing incidents ' + pageNumber + ' to ' + pageNumber + ' out of 100';
          if (pageNumber === 100) document.querySelector('.paging-next').classList.add('disabled');
          spinner.hidden = true;
        });
      </script>`);
    page.waitForTimeout = async () => {};
    const result = await collectSearchResults(page, "999", true, 1000, 200);
    assert.equal(result.tickets.length, 100);
  });
});

test("waits for paginated rows to change after the pager advances", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="2">
        <div class="fixedDataTableLayout_rowsContainer">
          <div class="public_fixedDataTable_bodyRow" role="row" aria-rowindex="2">
            <a class="investigation-id" href="/incident/1">#1</a>
          </div>
        </div>
      </div>
      <div class="paging"><span class="page-number">1/2</span><span class="paging-next"> &gt;</span></div>
      <span class="table-paging-message">Showing incidents 1 to 1 out of 2</span>
      <script>
        document.querySelector('.paging-next').addEventListener('click', () => {
          document.querySelector('.page-number').textContent = '2/2';
          document.querySelector('.paging-next').classList.add('disabled');
          setTimeout(() => {
            document.querySelector('.investigation-id').href = '/incident/2';
            document.querySelector('.investigation-id').textContent = '#2';
            document.querySelector('.table-paging-message').textContent =
              'Showing incidents 2 to 2 out of 2';
          }, 1200);
        });
      </script>`);
    const result = await collectSearchResults(page, "999", true, 4000, 4000, "^/api/search$");
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["1", "2"]);
  });
});

test("rejects a page transition whose first result change misses paginationTimeoutMs", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="2">
        <div class="fixedDataTableLayout_rowsContainer">
          <div class="public_fixedDataTable_bodyRow" role="row" aria-rowindex="2">
            <a class="investigation-id" href="/incident/1">#1</a>
          </div>
        </div>
      </div>
      <span class="paging-next"> &gt;</span>
      <span class="table-paging-message">Showing incidents 1 to 1 out of 2</span>
      <script>
        document.querySelector('.paging-next').addEventListener('click', () => {
          setTimeout(() => {
            document.querySelector('.paging-next').classList.add('disabled');
            document.querySelector('.investigation-id').href = '/incident/2';
            document.querySelector('.investigation-id').textContent = '#2';
            document.querySelector('.table-paging-message').textContent =
              'Showing incidents 2 to 2 out of 2';
          }, 700);
        });
      </script>`);
    await assert.rejects(
      () => collectSearchResults(page, "999", true, 1000, 300),
      /pagination action.*300 ms/i
    );
  });
});

test("waits through an intermediate render after pagination", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="2">
        <div class="fixedDataTableLayout_rowsContainer">
          <div class="public_fixedDataTable_bodyRow" role="row" aria-rowindex="2">
            <a class="investigation-id" href="/incident/1">#1</a>
          </div>
        </div>
      </div>
      <div class="paging"><span class="page-number">1/2</span><span class="paging-next"> &gt;</span></div>
      <span class="table-paging-message">Showing incidents 1 to 1 out of 2</span>
      <script>
        document.querySelector('.paging-next').addEventListener('click', () => {
          document.querySelector('.page-number').textContent = '2/2';
          document.querySelector('.paging-next').classList.add('disabled');
          document.querySelector('.investigation-id').href = '/incident/2';
          document.querySelector('.investigation-id').textContent = '#2';
          document.querySelector('.table-paging-message').textContent = 'Showing incidents 2 to 2 out of 2';
          setTimeout(() => {
            document.querySelector('.investigation-id').href = '/incident/3';
            document.querySelector('.investigation-id').textContent = '#3';
          }, 3900);
        });
      </script>`);
    const result = await collectSearchResults(page, "999", true, 4000);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["1", "3"]);
  });
});

test("resets a virtualized grid to the first row on every page", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="fixedDataTableLayout_main" role="grid" aria-rowcount="5">
        <div class="fixedDataTableLayout_rowsContainer" style="height:100px"></div>
      </div>
      <div class="paging"><span class="page-number">1/2</span><span class="paging-next"> &gt;</span></div>
      <span class="table-paging-message">Showing incidents 1 to 4 out of 8</span>
      <script>
        let pageNumber = 1;
        let chunk = 0;
        const root = document.querySelector('.fixedDataTableLayout_rowsContainer');
        function render() {
          const start = ((pageNumber - 1) * 4) + (chunk * 2) + 1;
          root.innerHTML = [start, start + 1].map((id, index) =>
            '<div class="public_fixedDataTable_bodyRow" aria-rowindex="' + ((chunk * 2) + index + 2) + '">' +
            '<a class="investigation-id" href="/incident/' + id + '">#' + id + '</a></div>'
          ).join('');
        }
        root.addEventListener('wheel', (event) => {
          event.preventDefault();
          if (event.deltaY > 0) chunk = 1;
          if (event.deltaY < 0) chunk = 0;
          render();
        });
        document.querySelector('.paging-next').addEventListener('click', () => {
          pageNumber = 2;
          document.querySelector('.page-number').textContent = '2/2';
          document.querySelector('.paging-next').classList.add('disabled');
          document.querySelector('.table-paging-message').textContent = 'Showing incidents 5 to 8 out of 8';
          render();
        });
        render();
      </script>`);
    const result = await collectSearchResults(page, "999", true, 4000);
    assert.deepEqual(result.tickets.map((ticket) => ticket.ticketId), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  });
});

test("rejects search results that never stabilize", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="results"><a class="investigation-id" href="/incident/1">#1</a><span class="table-paging-message">Showing incidents 1 to 1 out of 1</span></div>
      <script>
        let ticket = 1;
        setInterval(() => {
          ticket += 1;
          const link = document.querySelector('.investigation-id');
          link.href = '/incident/' + ticket;
          link.textContent = '#' + ticket;
        }, 100);
      </script>`);
    await assert.rejects(
      () => collectSearchResults(page, "999", true, 800),
      /did not stabilize/i
    );
  });
});

test("waits for asynchronously populated incident values", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Rule Name</label><div class="value-wrapper"><button>Edit</button></div></div>
      <script>
        setTimeout(() => {
          document.querySelector('.value-wrapper').innerHTML =
            '<div class="text-field-display-value">delayed_rule</div>';
        }, 2200);
      </script>`);
    await waitForIncidentReady(page, 5000, {
      requiredFieldLabels: [["Rule Name"]]
    });
    const incident = await extractIncident(page, {});
    assert.equal(incident.ruleName, "delayed_rule");
  });
});

test("ignores unrelated live incident fields once required fields are stable", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Rule Name</label><div class="value-wrapper"><div class="text-field-display-value">ready_rule</div></div></div>
      <div class="field-wrapper"><label>Type</label><div class="value-wrapper"><div class="text-field-display-value">TEST-TENANT</div></div></div>
      <div class="field-wrapper"><label>Live Status</label><div id="counter" class="value-wrapper">0</div></div>
      <script>setInterval(() => document.querySelector('#counter').textContent = String(Date.now()), 100)</script>`);
    await waitForIncidentReady(page, 800, {
      requiredFieldLabels: [["Rule Name"], ["Type"]]
    });
  });
});

test("does not treat a field label or edit control as its value", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label title="Rule Name">Rule Name</label><button title="Edit">Edit</button></div>`);
    const incident = await extractIncident(page, {});
    assert.equal(incident.ruleName, "");
  });
});

test("collects V3 fields from every historical ticket", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    const requestedPaths = [];
    await context.route("https://example.test/**", async (route) => {
      requestedPaths.push(new URL(route.request().url()).pathname);
      const ticketId = route.request().url().match(/\/(\d+)$/)[1];
      await route.fulfill({
        contentType: "text/html",
        body: `<span class="header-inv-id">#${ticketId}</span>
          <div class="field-wrapper"><label>Classification</label><div class="value-wrapper"><div class="single-select-field-wrapper__single-value">FP${ticketId}</div></div></div>
          <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed ${ticketId}</div></div></div>
          <div class="field-wrapper"><div class="editable-long-text-field"><div class="text-field-display-value">Long ${ticketId}</div></div></div>
          <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Summary ${ticketId}</div></div></div>
          <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation ${ticketId}</div></div></div>`
      });
    });
    const tickets = ["1", "2", "3"].map((ticketId) => ({ ticketId, href: `/incident/${ticketId}` }));
    const startedAt = performance.now();
    const result = await collectHistoricalDetails(context, "https://example.test/Custom/tab/999", tickets, {
      navigationTimeoutMs: 3000,
      historicalFieldsTimeoutMs: 3000,
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    });
    const elapsedMs = performance.now() - startedAt;
    assert.deepEqual(result.map((item) => item.ticketId), ["1", "2", "3"]);
    assert.deepEqual(result.map((item) => item.classification), ["FP1", "FP2", "FP3"]);
    assert.deepEqual(result.map((item) => item.closeNotes), ["Closed 1", "Closed 2", "Closed 3"]);
    assert.deepEqual(result.map((item) => item.descriptionLong), ["Long 1", "Long 2", "Long 3"]);
    assert.deepEqual(result.map((item) => item.historicalSummary), ["Summary 1", "Summary 2", "Summary 3"]);
    assert.deepEqual(result.map((item) => item.historicalRecommendations), ["Recommendation 1", "Recommendation 2", "Recommendation 3"]);
    assert.deepEqual(requestedPaths.sort(), ["/Custom/tab/1", "/Custom/tab/2", "/Custom/tab/3"]);
    assert.ok(elapsedMs < 3500, "ready historical fields should not pay the full quiet period per ticket");
  });
});

test("preloads historical navigation up to the configured concurrency", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", async (route) => {
      const ticketId = route.request().url().match(/\/(\d+)$/)[1];
      await route.fulfill({
        contentType: "text/html",
        body: `<span class="header-inv-id">#${ticketId}</span>
          <div class="field-wrapper"><label>Classification</label><div class="value-wrapper"><div class="single-select-field-wrapper__single-value">Low</div></div></div>
          <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed ${ticketId}</div></div></div>
          <div class="field-wrapper"><div class="editable-long-text-field"><div class="text-field-display-value">Long ${ticketId}</div></div></div>
          <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Summary ${ticketId}</div></div></div>
          <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation ${ticketId}</div></div></div>`
      });
    });
    const createPage = context.newPage.bind(context);
    let activeNavigations = 0;
    let maximumActiveNavigations = 0;
    let startedNavigations = 0;
    let releaseNavigations;
    const allNavigationsStarted = new Promise((resolve) => {
      releaseNavigations = resolve;
    });
    const waitForConcurrentStarts = async () => {
      let timer;
      try {
        return await Promise.race([
          allNavigationsStarted.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    context.newPage = async () => {
      const page = await createPage();
      const navigate = page.goto.bind(page);
      page.goto = async (...args) => {
        activeNavigations += 1;
        startedNavigations += 1;
        maximumActiveNavigations = Math.max(maximumActiveNavigations, activeNavigations);
        if (startedNavigations === 3) releaseNavigations();
        try {
          const startedTogether = await waitForConcurrentStarts();
          if (!startedTogether) throw new Error("Historical navigations did not start concurrently.");
          return await navigate(...args);
        } finally {
          activeNavigations -= 1;
        }
      };
      return page;
    };

    const tickets = ["1", "2", "3"].map((ticketId) => ({ ticketId }));
    const result = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      tickets,
      {
        navigationTimeoutMs: 3000,
        historicalFieldsTimeoutMs: 2000,
        historicalConcurrency: 3,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );

    assert.equal(maximumActiveNavigations, 3);
    assert.deepEqual(result.map((item) => item.ticketId), ["1", "2", "3"]);
  });
});

test("does not wait for absent alternative historical fields", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    const createPage = context.newPage.bind(context);
    let requestedWaitMs = 0;
    context.newPage = async () => {
      const page = await createPage();
      const waitForTimeout = page.waitForTimeout.bind(page);
      page.waitForTimeout = async (timeoutMs) => {
        requestedWaitMs += timeoutMs;
        return waitForTimeout(timeoutMs);
      };
      return page;
    };
    await context.route("https://example.test/**", (route) => {
      const ticketId = route.request().url().match(/\/(\d+)$/)[1];
      return route.fulfill({
        contentType: "text/html",
        body: `<span class="header-inv-id">#${ticketId}</span>
          <div class="field-wrapper"><label>Classification</label><div class="value-wrapper"><div class="single-select-field-wrapper__single-value">Low</div></div></div>
          <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation ${ticketId}</div></div></div>`
      });
    });
    const tickets = ["1", "2", "3", "4", "5"].map((ticketId) => ({ ticketId }));
    const result = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      tickets,
      {
        navigationTimeoutMs: 2000,
        historicalFieldsTimeoutMs: 800,
        historicalConcurrency: 1,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );
    assert.ok(requestedWaitMs < 3000, `usable alternatives requested ${requestedWaitMs} ms of polling waits`);
    assert.deepEqual(result.map((item) => item.historicalRecommendations), [
      "Recommendation 1",
      "Recommendation 2",
      "Recommendation 3",
      "Recommendation 4",
      "Recommendation 5"
    ]);
  });
});

test("retries a failed historical preload while the page is foregrounded", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<span class="header-inv-id">#1</span>
        <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed</div></div></div>
        <div class="field-wrapper"><div class="editable-long-text-field"><div class="text-field-display-value">Long</div></div></div>
        <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Summary</div></div></div>
        <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation</div></div></div>`
    }));
    const createPage = context.newPage.bind(context);
    let navigationAttempts = 0;
    context.newPage = async () => {
      const page = await createPage();
      const navigate = page.goto.bind(page);
      page.goto = async (...args) => {
        navigationAttempts += 1;
        if (navigationAttempts === 1) throw new Error("simulated background throttle");
        return navigate(...args);
      };
      return page;
    };

    const [result] = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      [{ ticketId: "1" }],
      {
        navigationTimeoutMs: 2000,
        historicalFieldsTimeoutMs: 1000,
        historicalConcurrency: 1,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );

    assert.equal(navigationAttempts, 2);
    assert.equal(result.error, undefined);
    assert.equal(result.closeNotes, "Closed");
  });
});

test("foregrounds each historical incident before navigating it", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<span class="header-inv-id">#1</span>
        <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed</div></div></div>
        <div class="field-wrapper"><div class="editable-long-text-field"><div class="text-field-display-value">Long</div></div></div>
        <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Summary</div></div></div>
        <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation</div></div></div>`
    }));
    const createPage = context.newPage.bind(context);
    let explicitlyActivatedBeforeNavigation = null;
    context.newPage = async () => {
      const page = await createPage();
      const navigate = page.goto.bind(page);
      const activate = page.bringToFront.bind(page);
      let activated = false;
      page.bringToFront = async () => {
        activated = true;
        return activate();
      };
      page.goto = async (...args) => {
        explicitlyActivatedBeforeNavigation = activated;
        return navigate(...args);
      };
      return page;
    };

    const result = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      [{ ticketId: "1", href: "/incident/1" }],
      {
        navigationTimeoutMs: 2000,
        historicalConcurrency: 1,
        historicalFieldsTimeoutMs: 1000,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );
    assert.equal(explicitlyActivatedBeforeNavigation, true);
    assert.equal(result[0].ticketId, "1");
  });
});

test("waits for delayed V3 fields on historical tickets", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<span class="header-inv-id">#1</span>
        <div class="field-wrapper"><label>Rule Name</label><div class="value-wrapper"><div class="text-field-display-value">Rule</div></div></div>
        <script>
          setTimeout(() => {
            document.body.insertAdjacentHTML('beforeend',
              '<div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Delayed close</div></div></div>' +
              '<div class="field-wrapper"><label>Description Long</label><div class="value-wrapper"><div class="text-field-display-value">Delayed description</div></div></div>' +
              '<div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Delayed summary</div></div></div>' +
              '<div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Delayed recommendation</div></div></div>');
          }, 1200);
        </script>`
    }));

    const [result] = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      [{ ticketId: "1", href: "/incident/1" }],
      {
        navigationTimeoutMs: 3000,
        historicalConcurrency: 1,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );

    assert.equal(result.closeNotes, "Delayed close");
    assert.equal(result.descriptionLong, "Delayed description");
    assert.equal(result.historicalSummary, "Delayed summary");
    assert.equal(result.historicalRecommendations, "Delayed recommendation");
  });
});

test("waits briefly for an optional delayed historical Classification", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<span class="header-inv-id">#1</span>
        <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed</div></div></div>
        <div class="field-wrapper"><label>Description Long</label><div class="value-wrapper"><div class="text-field-display-value">Long description</div></div></div>
        <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Summary</div></div></div>
        <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation</div></div></div>
        <script>
          setTimeout(() => document.body.insertAdjacentHTML('beforeend',
            '<div class="field-wrapper"><label>Classification</label><div class="value-wrapper"><div class="single-select-field-wrapper__single-value">FP</div></div></div>'), 900);
        </script>`
    }));
    const [result] = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      [{ ticketId: "1", href: "/incident/1" }],
      {
        navigationTimeoutMs: 2000,
        historicalFieldsTimeoutMs: 2000,
        historicalConcurrency: 1,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );
    assert.equal(result.classification, "FP");
  });
});

test("prefers a delayed historical summary over an earlier unrelated summary", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<span class="header-inv-id">#1</span>
        <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed</div></div></div>
        <div class="field-wrapper"><label>Description Long</label><div class="value-wrapper"><div class="text-field-display-value">Long description</div></div></div>
        <div class="field-wrapper"><label>Alert Summary</label><div class="value-wrapper"><div class="text-field-display-value">Wrong alert summary</div></div></div>
        <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation</div></div></div>
        <script>
          setTimeout(() => document.body.insertAdjacentHTML('beforeend',
            '<div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Correct historical summary</div></div></div>'), 1200);
        </script>`
    }));
    const [result] = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      [{ ticketId: "1", href: "/incident/1" }],
      {
        navigationTimeoutMs: 3000,
        historicalConcurrency: 1,
        historicalSummaryLabels: [],
        historicalRecommendationLabels: []
      }
    );
    assert.equal(result.historicalSummary, "Correct historical summary");
  });
});

test("waits for a configured historical label instead of an early semantic fallback", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext();
    await context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<span class="header-inv-id">#1</span>
        <div class="field-wrapper"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Closed</div></div></div>
        <div class="field-wrapper"><label>Description Long</label><div class="value-wrapper"><div class="text-field-display-value">Long description</div></div></div>
        <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Fallback summary</div></div></div>
        <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Recommendation</div></div></div>
        <script>
          setTimeout(() => document.body.insertAdjacentHTML('beforeend',
            '<div class="field-wrapper"><label>Custom Analyst Summary</label><div class="value-wrapper"><div class="text-field-display-value">Configured summary</div></div></div>'), 1200);
        </script>`
    }));
    const [result] = await collectHistoricalDetails(
      context,
      "https://example.test/Custom/tab/999",
      [{ ticketId: "1", href: "/incident/1" }],
      {
        navigationTimeoutMs: 3000,
        historicalConcurrency: 1,
        historicalSummaryLabels: ["Custom Analyst Summary"],
        historicalRecommendationLabels: []
      }
    );
    assert.equal(result.historicalSummary, "Configured summary");
  });
});

test("rejects invalid historical concurrency", async () => {
  const context = { newPage: async () => { throw new Error("should not open a page"); } };
  await assert.rejects(
    () => collectHistoricalDetails(context, "https://example.test/Custom/tab/999", [
      { ticketId: "1", href: "/incident/1" }
    ], {
      navigationTimeoutMs: 1000,
      historicalConcurrency: "oops",
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    }),
    /historicalConcurrency/i
  );
  await assert.rejects(
    () => collectHistoricalDetails(context, "https://example.test/Custom/tab/999", [
      { ticketId: "1", href: "/incident/1" }
    ], {
      navigationTimeoutMs: 1000,
      historicalConcurrency: 1,
      historicalFieldsTimeoutMs: "oops"
    }),
    /historicalFieldsTimeoutMs/i
  );
});

test("reports only actionable historical failures as non-fatal warnings", () => {
  const warning = assessHistoricalResults([
    { ticketId: "1", error: "historical page timed out" },
    { ticketId: "2", error: "wrong incident opened" }
  ]);
  assert.match(warning, /all 2 historical incidents could not be read/i);
  assert.match(warning, /#1: historical page timed out/i);
  assert.equal(
    assessHistoricalResults([{ ticketId: "1", closeNotes: "done" }, { ticketId: "2", error: "failed" }]),
    "1 historical incident(s) could not be read."
  );
  assert.equal(assessHistoricalResults([{
    ticketId: "1",
    closeNotes: "Confirmed benign activity.",
    missingFields: ["Description Long", "Historical Summary", "Historical Recommendations"]
  }]), "");
  assert.equal(
    assessHistoricalResults([{ ticketId: "1", missingFields: ["Historical Summary"] }]),
    "1 historical incident(s) have no usable recommendation: #1."
  );
});

test("discovers historical summary and recommendation field labels", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Historical Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Known benign pattern</div></div></div>
      <div class="field-wrapper"><label>Historical Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Confirm the approved change</div></div></div>`);
    const incident = await extractIncident(page, {
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    });
    assert.equal(incident.historicalSummary, "Known benign pattern");
    assert.equal(incident.historicalRecommendations, "Confirm the approved change");
  });
});

test("prefers configured historical labels over semantic fallbacks", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Alert Summary</label><div class="value-wrapper"><div class="text-field-display-value">Wrong summary</div></div></div>
      <div class="field-wrapper"><label>Historical Analysis</label><div class="value-wrapper"><div class="text-field-display-value">Correct summary</div></div></div>`);
    const incident = await extractIncident(page, {
      historicalSummaryLabels: ["Historical Analysis"],
      historicalRecommendationLabels: []
    });
    assert.equal(incident.historicalSummary, "Correct summary");
  });
});

test("does not treat unrelated summaries or recommendations as historical fields", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Alert Summary</label><div class="value-wrapper"><div class="text-field-display-value">Alert overview</div></div></div>
      <div class="field-wrapper"><label>Vendor Recommendations</label><div class="value-wrapper"><div class="text-field-display-value">Generic vendor advice</div></div></div>`);
    const incident = await extractIncident(page, {
      historicalSummaryLabels: [],
      historicalRecommendationLabels: []
    });
    assert.equal(incident.historicalSummary, "");
    assert.equal(incident.historicalRecommendations, "");
  });
});

test("does not replace an empty configured historical field with semantic content", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <span class="header-inv-id">#42</span>
      <div class="field-wrapper"><label>Historical Analysis</label><div class="value-wrapper"><button>Edit</button></div></div>
      <div class="field-wrapper"><label>Malware Analysis Summary</label><div class="value-wrapper"><div class="text-field-display-value">Unrelated malware analysis</div></div></div>`);
    const incident = await extractIncident(page, {
      historicalSummaryLabels: ["Historical Analysis"],
      historicalRecommendationLabels: []
    });
    assert.equal(incident.historicalSummary, "");
  });
});

test("launcher uses a dedicated Chromium profile and AHK targets the configured binary", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const launcher = fs.readFileSync(path.join(projectRoot, "start-chrome-debug.bat"), "utf8");
  const ahk = fs.readFileSync(path.join(projectRoot, "xsoar-incident-assistant.ahk"), "utf8");
  assert.match(launcher, /--user-data-dir=/i);
  assert.doesNotMatch(launcher, /powershell|pwsh/i);
  assert.doesNotMatch(launcher, /DevToolsActivePort/i);
  assert.match(launcher, /curl\.exe/i);
  assert.doesNotMatch(launcher, /-cdp-session\.txt|VERIFY_FILE|VERIFY_JSON|%TEMP%|fc\s+\/b/i);
  assert.match(launcher, /netstat\s+-ano/i);
  assert.match(launcher, /xsoar-incident-assistant\.ahk/i);
  assert.match(launcher, /start\s+""\s+"!AHK_EXE!"\s+"%AHK_SCRIPT%"/i);
  assert.match(launcher, /start\s+""\s+"%AHK_SCRIPT%"/i);
  assert.match(ahk, /ProcessGetPath\(/);
  assert.match(ahk, /ahk_id/i);
  assert.match(ahk, /RunNodeAndReadProtocol\(/i);
  assert.match(ahk, /StdOut/i);
  assert.match(ahk, /StdErr/i);
  const protocolLoop = ahk.slice(
    ahk.indexOf("while process.Status"),
    ahk.indexOf("return {", ahk.indexOf("while process.Status"))
  );
  assert.match(protocolLoop, /StdOut/);
  assert.match(protocolLoop, /StdErr/);
  assert.doesNotMatch(ahk, /output\.json|template\.txt|progress\.json|AppendErrorLog|FileAppend|logs[\\/]/i);
  assert.doesNotMatch(ahk, /A_Clipboard|ClipboardAll|\^v/i);
  assert.doesNotMatch(ahk, /\bSend\("\^n"\)/i);
  assert.match(ahk, /ControlSend\("\^n",\s*,\s*"ahk_id " notepadHwnd\)/i);
  assert.match(ahk, /SendMessage\(2084[\s\S]+newBufferId/i);
  assert.match(ahk, /did not create a new document; no text was written/i);
  assert.match(ahk, /ControlSetText\(text,\s*,\s*"ahk_id " editorHwnd\)/i);
  assert.doesNotMatch(ahk, /SendMessage\(2181/i);
  assert.match(ahk, /\+AlwaysOnTop/i);
  assert.match(ahk, /SetTimer\(DebugOverlayPoll/i);
  assert.match(ahk, /ExpandEnvironmentPath\(/i);
  assert.doesNotMatch(ahk, /ticketId|searchQuery|matchCount|errors/i);
});

test("checked-in defaults are portable and quiet", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config.example.json"), "utf8"));
  const ignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  assert.equal(config.debugMode, false);
  assert.equal(config.headless, false);
  assert.equal(config.headlessBrowserChannel, "auto");
  assert.equal(config.notepadPlusPlusPath, "%LOCALAPPDATA%\\Programs\\Notepad++\\notepad++.exe");
  assert.deepEqual(config.allowedXsoarOrigins, ["https://xsoar.example.com"]);
  assert.match(ignore, /^config\.json$/m);
});

test("launcher discovers common Chrome installation locations", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const launcher = fs.readFileSync(path.join(projectRoot, "start-chrome-debug.bat"), "utf8");
  assert.match(launcher, /ProgramFiles%\\Google\\Chrome\\Application\\chrome\.exe/i);
  assert.match(launcher, /ProgramFiles\(x86\)%\\Google\\Chrome\\Application\\chrome\.exe/i);
  assert.match(launcher, /LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome\.exe/i);
  assert.match(launcher, /where\s+chrome\.exe/i);
  assert.match(launcher, /Microsoft\\Edge\\Application\\msedge\.exe/i);
  assert.match(launcher, /where\s+msedge\.exe/i);
  assert.match(launcher, /\/C:"Chromium\//i);
  assert.match(launcher, /XSOAR_ASSISTANT_BROWSER/i);
  assert.match(launcher, /Microsoft\\Edge\\XSOAR-Incident-Assistant/i);
  assert.match(launcher, /Google\\Chrome\\XSOAR-Incident-Assistant/i);
});

test("headless mode imports storage state and keeps the source browser separate", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(projectRoot, "search-xsoar.js"), "utf8");
  assert.match(source, /storageState\(\)/);
  assert.match(source, /headlessBrowserChannel/);
  assert.match(source, /headlessBrowser\.close\(\)/);
  assert.match(source, /sourceIncidentPage\.bringToFront\(\)/);
});

test("non-admin installer uses per-user dependencies and Startup shortcut", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const installer = fs.readFileSync(path.join(projectRoot, "install-xsoar-incident-assistant.bat"), "utf8");
  const shortcut = fs.readFileSync(path.join(projectRoot, "install-startup-shortcut.vbs"), "utf8");
  assert.doesNotMatch(installer, /powershell|pwsh/i);
  assert.match(installer, /winget\.exe\s+install/i);
  assert.match(installer, /--scope\s+user/i);
  assert.match(installer, /npm\s+ci/i);
  assert.match(installer, /copy\s+\/y\s+"%CONFIG_TEMPLATE%"\s+"%CONFIG_PATH%"/i);
  assert.match(installer, /APPDATA.*Startup/i);
  assert.match(installer, /XSOAR Incident Assistant\.lnk/i);
  assert.match(installer, /cscript\.exe/i);
  assert.match(installer, /notepad\+\+\\notepad\+\+\.exe/i);
  assert.match(installer, /ASSISTANT_NOTEPAD_PATH/i);
  const wingetHelper = installer.slice(installer.indexOf(":winget_install"), installer.indexOf(":pause_if_visible"));
  assert.doesNotMatch(wingetHelper, /set\s+"MISSING=1"/i);
  assert.match(shortcut, /CreateShortcut/i);
  assert.match(shortcut, /wscript\.exe/i);
});

test("hidden launcher runs the sibling batch without a command window", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const hiddenLauncher = fs.readFileSync(path.join(projectRoot, "start-xsoar-assistant-hidden.vbs"), "utf8");
  const batchLauncher = fs.readFileSync(path.join(projectRoot, "start-chrome-debug.bat"), "utf8");
  assert.match(hiddenLauncher, /GetParentFolderName\(WScript\.ScriptFullName\)/i);
  assert.match(hiddenLauncher, /start-chrome-debug\.bat/i);
  assert.match(hiddenLauncher, /Environment\("PROCESS"\)\("XSOAR_ASSISTANT_HIDDEN_LAUNCH"\)\s*=\s*"1"/i);
  assert.match(hiddenLauncher, /\.Run\([^\r\n]+,\s*0,\s*True\)/i);
  assert.doesNotMatch(hiddenLauncher, /powershell|pwsh/i);
  assert.match(batchLauncher, /call\s+:pause_if_visible/i);
  assert.match(batchLauncher, /if\s+\/I\s+"%XSOAR_ASSISTANT_HIDDEN_LAUNCH%"=="1"\s+exit\s+\/b\s+0/i);
  assert.match(batchLauncher, /shortcut to start-xsoar-assistant-hidden\.vbs in Startup/i);
});

test("returns an empty result for a no-match table", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent('<div class="table-paging-message">Showing incidents 0 to 0 out of 0</div>');
    const result = await collectSearchResults(page, "42", true, 1000);
    assert.equal(result.matches, 0);
    assert.deepEqual(result.tickets, []);
  });
});

test("handles missing fields without inventing values", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent('<span class="header-inv-id">#42</span>');
    await waitForIncidentReady(page, 800, {
      requiredFieldLabels: [["Rule Name"], ["Type", "Case Type"]]
    });
    const incident = await extractIncident(page, {});
    assert.equal(incident.ticketId, "42");
    assert.equal(incident.ruleName, "");
    assert.equal(incident.caseType, "");
  });
});

test("finds the focused incident among multiple matching tabs", async () => {
  const first = {
    url: () => "https://example.test/Custom/tab/100",
    evaluate: async () => true
  };
  const second = {
    url: () => "https://example.test/Custom/tab/200",
    evaluate: async () => false
  };
  const browser = { contexts: () => [{ pages: () => [first, second] }] };
  const found = await findActiveIncidentPage(
    browser,
    "\\/Custom\\/[^/]+\\/\\d+$",
    ["https://example.test"]
  );
  assert.equal(found, first);
});

test("rejects ambiguous incident tabs when none is focused", async () => {
  const page = (ticketId) => ({
    url: () => `https://example.test/Custom/tab/${ticketId}`,
    evaluate: async () => false
  });
  const browser = { contexts: () => [{ pages: () => [page("100"), page("200")] }] };
  await assert.rejects(
    () => findActiveIncidentPage(browser, "\\/Custom\\/[^/]+\\/\\d+$", ["https://example.test"]),
    /multiple open XSOAR incident tabs/i
  );
});

test("rejects a focused matching path outside the trusted XSOAR origin", async () => {
  const page = {
    url: () => "https://attacker.example/Custom/tab/100",
    evaluate: async () => true
  };
  const browser = { contexts: () => [{ pages: () => [page] }] };
  await assert.rejects(
    () => findActiveIncidentPage(browser, "\\/Custom\\/[^/]+\\/\\d+$", ["https://example.test"]),
    /no open XSOAR incident tab/i
  );
});

test("escapes XSOAR query values", () => {
  assert.equal(
    buildSearchQuery('rule "one"', "CUSTOMER\\TYPE"),
    'name:"rule \\"one\\"" and type:"CUSTOMER\\\\TYPE"'
  );
});

test("builds the analyst template without unavailable historical ratings", () => {
  const text = buildTemplate({
    incidentName: "P3 - Sample Incident",
    ruleName: "sample_rule",
    caseType: "EXAMPLE-TENANT",
    customerName: "Sample Customer",
    customerShortName: "",
    severity: "High",
    description: "Description text",
    descriptionLong: "",
    matches: 0,
    tickets: [],
    historical: []
  });
  assert.match(text, /^Hello Sample Customer,/);
  assert.match(text, /We have detected P3 - Sample Incident for n\/a\./);
  assert.doesNotMatch(text, /Past rating:/);
  assert.match(text, /Recommended Actions\nx x x/);
  assert.match(text, /Kind regards,$/);
  assert.doesNotMatch(text, /Example Analyst/i);
});

test("does not substitute other fields for exact template placeholders", () => {
  const text = buildTemplate({
    customerName: "",
    customerShortName: "Short Account",
    caseType: "EXAMPLE-TENANT",
    incidentName: "",
    eventName: "Different event name",
    ruleName: "different_rule",
    historical: []
  });
  assert.match(text, /^Hello n\/a,/);
  assert.match(text, /We have detected n\/a for n\/a\./);
  assert.doesNotMatch(text, /^Hello (?:Short Account|EXAMPLE-TENANT),/);
  assert.doesNotMatch(text, /We have detected (?:Different event name|different_rule) for/);
});

test("fills a generic configured event template and numbered historical recommendations", () => {
  const text = buildTemplate({
    incidentName: "Example High-Volume Export",
    ruleName: "sample_rule",
    caseType: "EXAMPLE-TENANT",
    customerName: "Sample Customer",
    customerShortName: "",
    occurred: "Jan 2nd 2024 03:04:05",
    deviceHostname: "example-host-01",
    sourceIp: "192.0.2.47",
    sourceUsername: "EXAMPLE\\analyst",
    destinationIp: "",
    eventName: "Example Export Threshold Exceeded",
    detectionUrl: "https://security.example/incidents/example-event-002",
    serviceMessage: "An example export exceeded the configured threshold.",
    historical: [
      { ticketId: "7001", classification: "FP", historicalRecommendations: "Confirm the approved activity." },
      { ticketId: "7000", classification: "TP", closeNotes: "Escalated to the customer." },
      { ticketId: "6999", classification: "N/A", closeNotes: "" }
    ]
  }, {
    analystName: "Example Analyst",
    analystTitle: "Security Analyst"
  });
  assert.equal(text, `Hello Sample Customer,
Past rating: FP, TP
We have detected Example High-Volume Export for example-host-01.
-----------------------------------------------------------------

Event info breakdown is as follows:

Time Stamp: Jan 2nd 2024 03:04:05
User: EXAMPLE\\analyst
Source: 192.0.2.47
Destination: n/a
Client Hostname: example-host-01
Event Detail: Example Export Threshold Exceeded
Event Record URL: https://security.example/incidents/example-event-002
Error / Service Message: An example export exceeded the configured threshold.
----------------------------------------------------------

Investigation Summary
x x x
-----

Related Activity
x x x
-----

Recommended Actions
1. #7001: Confirm the approved activity.
2. #7000: Escalated to the customer.
-----------------------------------------------

Vendor Guidance
x x x
-----

If you require more information or would like to discuss this incident, contact your security operations team and quote the incident ID.

Kind regards,
Example Analyst
Security Analyst`);
});
