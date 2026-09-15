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
const pulledModels = [];
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
    },
    localAi: {
      status: async () => ({ available: true, models: ["qwen3.5:9b"], detail: "Local Ollama is available." }),
      pull: async (model, { signal } = {}) => {
        pulledModels.push(model);
        if (model !== "slow-model") return [model];
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Local Ollama model download was cancelled.")), { once: true });
        });
      },
      enrich: async () => ({})
    },
    generateDraft: async ({ onProgress }) => {
      await onProgress("Enriching the draft locally.");
      return { draft: "Locally enriched example draft", warning: "", reviewed: 0, aiEnriched: true };
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
  assert.equal(await page.locator("#localAiEnabled").isChecked(), false);
  assert.equal(await page.locator("#localAiModel").inputValue(), "qwen3.5:9b");
  await page.locator("#localAiEnabled").check();
  await page.locator("#pullModel").click();
  await page.getByText("Local Ollama is available.").waitFor();
  assert.deepEqual(pulledModels, ["qwen3.5:9b"]);

  await page.locator("#localAiModel").fill("slow-model");
  await page.locator("#pullModel").click();
  await page.locator("#cancelPull").waitFor();
  await page.reload();
  await page.locator("#cancelPull").waitFor();
  await page.locator("#cancelPull").click();
  await page.getByText("Local Ollama model download was cancelled.").waitFor({ timeout: 3000 });
  await page.locator("#cancelPull").waitFor({ state: "detached", timeout: 3000 });
  assert.deepEqual(pulledModels, ["qwen3.5:9b", "slow-model"]);
  await page.locator("#localAiEnabled").check();

  await page.locator("#allowedOrigin").fill("https://xsoar.example.test");
  await page.locator("#open").click();
  await page.locator("#stop:not([disabled])").waitFor({ timeout: 2000 });
  assert.equal(starts, 1);
  assert.equal(uiConfig.xsoar.allowedOrigin, "https://xsoar.example.test");
  assert.equal(uiConfig.localAi.enabled, true);
  await page.getByText("Connected to the current Chrome window.").waitFor({ timeout: 2000 });
  assert.equal(await page.locator("#allowedOrigin").isDisabled(), true);
  assert.equal(await page.locator("#analystName").isDisabled(), true);
  assert.equal(await page.locator("#maxHistoricalIncidents").isDisabled(), true);
  await page.locator("#stop").click();
  await page.getByText("Chrome and its tabs remain open.").waitFor();
  assert.equal(sessionRunning, false);
  assert.equal(await page.locator("#allowedOrigin").isDisabled(), false);

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

  await page.locator("#run").click();
  await page.locator("#aiDraftAcknowledgement").waitFor();
  assert.equal(await page.locator("#copy").isDisabled(), true);
  await page.locator("#aiDraftAcknowledgement").check();
  assert.equal(await page.locator("#copy").isDisabled(), false);
  const secondPage = await browser.newPage();
  await secondPage.goto(url);
  await secondPage.getByRole("heading", { name: "XSOAR Incident Assistant" }).waitFor();
  await secondPage.locator("#run").click();
  await secondPage.locator("#aiDraftAcknowledgement").waitFor();
  await page.waitForFunction(() => !document.querySelector("#aiDraftAcknowledgement")?.checked, undefined, { timeout: 3000 });
  assert.equal(await page.locator("#copy").isDisabled(), true);
  await secondPage.close();

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
  assert.deepEqual(results.ticketIds, ["4199"]);

  const delayedIncidentPage = await browser.newPage();
  await delayedIncidentPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<div id="root"></div><script>setTimeout(() => { document.querySelector("#root").innerHTML = '<div class="header-inv-id">#4201</div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">Delayed Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div>'; }, 650);</script>`
  }));
  await delayedIncidentPage.goto("https://xsoar.example.test/Custom/GenericLayout/4201");
  const delayedIncident = await delayedIncidentPage.evaluate(extractIncidentFromPage, {
    ...settings,
    pageReadyTimeoutMs: 2000
  });
  assert.equal(delayedIncident.ruleName, "Delayed Rule");
  assert.equal(delayedIncident.caseType, "Endpoint");

  const delayedSearchPage = await browser.newPage();
  await delayedSearchPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<div class="no-results" style="display:none">Hidden empty state</div><div id="incidents-page" role="grid"></div><script>setTimeout(() => { document.querySelector("#incidents-page").innerHTML = '<a href="/incident/4198">4198</a>'; }, 900);</script>`
  }));
  await delayedSearchPage.goto(`https://xsoar.example.test/incidents?query=${encodeURIComponent(query)}`);
  const delayedResults = await delayedSearchPage.evaluate(extractSearchResultsFromPage, {
    expectedOrigin: settings.allowedOrigin,
    expectedPath: "/incidents",
    queryParameter: "query",
    expectedQuery: query,
    maxResults: 2,
    timeoutMs: 2500
  });
  assert.deepEqual(delayedResults.ticketIds, ["4198"]);
  console.log("Current-Chrome-only UI, upgrade migration, and URL-based extraction verification passed.");
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
}
