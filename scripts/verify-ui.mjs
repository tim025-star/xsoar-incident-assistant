import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

import { createAssistantServer } from "../src/server.js";
import { resolveAppConfig } from "../src/config.js";
import { resolveSettings } from "../src/domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "../src/page-adapter.js";

let uiConfig = resolveAppConfig({
  configVersion: 7,
  session: {
    mode: "managed",
    browser: "chrome",
    profileDirectory: "C:\\Legacy Browser Profile",
    activationHotkey: { label: "Numpad +", modifiers: 0, code: "NumpadAdd" }
  }
}, { requireTenant: false });
let sessionRunning = false;
let starts = 0;
let setupOpens = 0;
const sessions = {
  status: () => ({ running: sessionRunning }),
  openSetup: () => { setupOpens += 1; },
  start: async () => {
    starts += 1;
    sessionRunning = true;
    return {};
  },
  stop: async () => { sessionRunning = false; },
  adapter: () => ({})
};
const app = createAssistantServer({
  token: "browser-verification-token",
  routerOptions: {
    sessions,
    configStore: {
      load: async () => uiConfig,
      save: async (input, options) => {
        uiConfig = resolveAppConfig(input, options);
        return uiConfig;
      }
    }
  }
});
const url = await app.listen(0);
let browser;
try {
  const candidates = [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];
  const executablePath = candidates.find(existsSync);
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: "chromium", headless: true });
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByRole("heading", { name: "XSOAR Incident Assistant" }).waitFor();
  assert.equal(await page.locator("#mode").count(), 0);
  assert.equal(await page.locator("#profileDirectory").count(), 0);
  assert.equal("session" in uiConfig, false);

  await page.locator("#allowedOrigin").fill("https://xsoar.example.test");
  await page.locator("#open").click();
  await page.locator("#stop:not([disabled])").waitFor({ timeout: 2000 });
  assert.equal(starts, 1);
  assert.equal(uiConfig.xsoar.allowedOrigin, "https://xsoar.example.test");
  await page.getByText("Connected to the current Chrome window.").waitFor({ timeout: 2000 });
  await page.locator("#stop").click();
  await page.getByText("Chrome and its tabs remain open.").waitFor();
  assert.equal(sessionRunning, false);

  await page.locator("#setup").click();
  await page.getByText("Chrome setup opened.").waitFor();
  assert.equal(setupOpens, 1);
  await page.getByText("This approval must be repeated after Chrome restarts.").waitFor();

  await page.getByText("Advanced query settings").click();
  await page.locator("#maxHistoricalIncidents").fill("");
  assert.equal(await page.locator("#maxHistoricalIncidents").inputValue(), "");
  await page.locator("#maxHistoricalIncidents").fill("10");
  await page.locator("#analystName").fill("Example Analyst");
  await page.locator("#save").click();
  await page.getByText("Settings saved.").waitFor();
  assert.equal(uiConfig.xsoar.maxHistoricalIncidents, 10);
  assert.equal(uiConfig.xsoar.template.analystName, "Example Analyst");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  const settings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
    pageReadyTimeoutMs: 1000
  });
  const incidentPage = await browser.newPage();
  await incidentPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: route.request().url().includes("/incidents?")
      ? '<div id="incidents-page" role="grid"><a href="/incident/4199">4199</a></div><div class="table-paging-message">1 out of 1</div>'
      : '<div class="header-inv-id">#4200</div><div class="header-inv-title">Example detection</div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">Example Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div>'
  }));
  await incidentPage.goto("https://xsoar.example.test/Custom/GenericLayout/4200");
  const incident = await incidentPage.evaluate(extractIncidentFromPage, settings);
  assert.equal(incident.ruleName, "Example Rule");

  const query = 'name:"Example Rule" and type:"Endpoint"';
  await incidentPage.goto(`https://xsoar.example.test/incidents?query=${encodeURIComponent(query)}`);
  const results = await incidentPage.evaluate(extractSearchResultsFromPage, {
    expectedOrigin: settings.allowedOrigin,
    expectedPath: "/incidents",
    queryParameter: "query",
    expectedQuery: query,
    maxResults: 2,
    timeoutMs: 1000
  });
  assert.deepEqual(results.tickets.map((item) => item.ticketId), ["4199"]);
  console.log("Current-Chrome-only UI, upgrade migration, and URL-based extraction verification passed.");
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
}
