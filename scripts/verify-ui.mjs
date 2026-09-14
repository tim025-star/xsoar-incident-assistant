import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

import { createAssistantServer } from "../src/server.js";
import { resolveSettings } from "../src/domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "../src/page-adapter.js";

const app = createAssistantServer({ token: "browser-verification-token" });
const url = await app.listen(0);
let browser;
let persistentContext;
let profileDirectory;
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
  assert.equal(await page.locator("#mode").inputValue(), "managed");
  assert.equal(await page.locator("#analystName").inputValue(), "");
  assert.equal(await page.locator("#launchDebug").isVisible(), false);
  await page.locator("#mode").selectOption("cdp");
  assert.equal(await page.locator("#launchDebug").isVisible(), true);
  await browser.close();
  browser = null;

  profileDirectory = await mkdtemp(path.join(os.tmpdir(), "xsoar-assistant-profile-"));
  const settings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
    pageReadyTimeoutMs: 1000
  });
  persistentContext = await chromium.launchPersistentContext(profileDirectory, { executablePath, headless: true });
  const incidentPage = persistentContext.pages()[0] || await persistentContext.newPage();
  await incidentPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: route.request().url().includes("/incidents?")
      ? '<div id="incidents-page" role="grid"><a href="/incident/4199">4199</a></div><div class="table-paging-message">1 out of 1</div>'
      : '<div class="header-inv-id">#4200</div><div class="header-inv-title">Example detection</div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">Example Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div>'
  }));
  await incidentPage.goto("https://xsoar.example.test/Custom/GenericLayout/4200");
  const incident = await incidentPage.evaluate(extractIncidentFromPage, settings);
  assert.equal(incident.ruleName, "Example Rule");
  await incidentPage.evaluate(() => localStorage.setItem("profile-check", "retained"));

  const query = 'name:"Example Rule" and type:"Endpoint"';
  const searchPage = await persistentContext.newPage();
  await searchPage.route("https://xsoar.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<div id="incidents-page" role="grid"><a href="/incident/4199">4199</a></div><div class="table-paging-message">1 out of 1</div>' }));
  await searchPage.goto(`https://xsoar.example.test/incidents?query=${encodeURIComponent(query)}`);
  const results = await searchPage.evaluate(extractSearchResultsFromPage, { expectedOrigin: settings.allowedOrigin, expectedPath: "/incidents", queryParameter: "query", expectedQuery: query, maxResults: 2, timeoutMs: 1000 });
  assert.deepEqual(results.tickets.map((item) => item.ticketId), ["4199"]);
  await persistentContext.close();
  persistentContext = await chromium.launchPersistentContext(profileDirectory, { executablePath, headless: true });
  const restored = persistentContext.pages()[0] || await persistentContext.newPage();
  await restored.route("https://xsoar.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>restored</p>" }));
  await restored.goto("https://xsoar.example.test/");
  assert.equal(await restored.evaluate(() => localStorage.getItem("profile-check")), "retained");
  console.log("Local UI, URL-based extraction, and persistent Playwright profile verification passed.");
} finally {
  await browser?.close();
  await persistentContext?.close();
  await new Promise((resolve) => app.server.close(resolve));
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
}
