import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

import { attachBrowserActivationShortcut } from "../src/browser-session.js";
import { createAssistantServer } from "../src/server.js";
import { resolveAppConfig } from "../src/config.js";
import { resolveSettings } from "../src/domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "../src/page-adapter.js";

let uiConfig = resolveAppConfig({}, { requireTenant: false });
const detectedProfile = {
  id: "chrome:Default",
  browser: "chrome",
  browserName: "Google Chrome",
  directoryName: "Default",
  name: "Default profile",
  isDefault: true
};
const app = createAssistantServer({
  token: "browser-verification-token",
  routerOptions: {
    configStore: {
      load: async () => uiConfig,
      save: async (input, options) => {
        uiConfig = resolveAppConfig(input, options);
        return uiConfig;
      }
    },
    profileStore: {
      list: async () => [detectedProfile],
      import: async () => ({
        browser: "chrome",
        profileDirectory: path.join(uiConfig.session.profileDirectory, "..", "imported-chrome-default"),
        reused: false
      })
    }
  }
});
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
  assert.equal(await page.locator("#browser").inputValue(), "chrome");
  assert.equal(await page.locator("#analystName").inputValue(), "");
  assert.match(await page.locator("#existingProfile").textContent(), /Google Chrome.*Default profile.*Default/);
  await page.locator("#importProfile").click();
  await page.getByText("Browser sign-in data was imported into a dedicated assistant profile.").waitFor();
  assert.equal(uiConfig.session.browser, "chrome");
  assert.ok(uiConfig.session.profileDirectory.endsWith("imported-chrome-default"));
  await page.reload();
  await page.locator("#mode").waitFor();
  assert.match(await page.locator("#status").textContent(), /Browser sign-in data was imported/);
  await page.getByText("Advanced query settings").click();
  await page.locator("#maxHistoricalIncidents").fill("", { timeout: 2000 });
  assert.equal(await page.locator("#maxHistoricalIncidents").inputValue(), "");
  await page.locator("#maxHistoricalIncidents").fill("10", { timeout: 2000 });
  assert.equal(await page.locator("#maxHistoricalIncidents").inputValue(), "10");
  await page.locator("#allowedOrigin").fill("https://xsoar.example.test");
  const customProfileDirectory = path.join(path.dirname(uiConfig.session.profileDirectory), "custom-xsoar-profile");
  await page.locator("#profileDirectory").fill(customProfileDirectory);
  await page.locator("#analystName").fill("Example Analyst");
  await page.locator("#recordHotkey").click();
  await page.getByRole("button", { name: /Cancel \(5s\)/ }).waitFor();
  await page.keyboard.press("Control+Alt+K");
  assert.equal(await page.locator("#activationHotkey").inputValue(), "Ctrl + Alt + K");
  await page.getByText("Ctrl + Alt + K recorded. Save settings to activate it.").waitFor();
  await page.locator("#save").click();
  await page.getByText("Settings saved.").waitFor();
  assert.equal(uiConfig.xsoar.maxHistoricalIncidents, 10);
  assert.equal(uiConfig.session.profileDirectory, customProfileDirectory);
  assert.equal(uiConfig.xsoar.template.analystName, "Example Analyst");
  assert.deepEqual(uiConfig.session.activationHotkey, { label: "Ctrl + Alt + K", modifiers: 3, code: "KeyK" });
  await page.locator("#recordHotkey").click();
  await page.getByText("No shortcut was detected within five seconds. Settings unchanged.").waitFor({ timeout: 6000 });
  assert.equal(await page.locator("#activationHotkey").inputValue(), "Ctrl + Alt + K");
  assert.deepEqual(await page.locator("#mode option").evaluateAll((options) => options.map((option) => option.value)), ["managed", "diagnostics"]);
  await page.locator("#mode").selectOption("diagnostics");
  assert.equal(await page.locator("#launchDebug").count(), 0);
  await page.getByText("does not expose a remote-debugging network port").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
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
  let shortcutActivations = 0;
  await attachBrowserActivationShortcut(persistentContext, {
    session: { activationHotkey: { label: "Ctrl + Alt + K", modifiers: 3, code: "KeyK" } },
    xsoar: settings
  }, async () => {
    shortcutActivations += 1;
  });
  await incidentPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: route.request().url().includes("/incidents?")
      ? '<div id="incidents-page" role="grid"><a href="/incident/4199">4199</a></div><div class="table-paging-message">1 out of 1</div>'
      : '<div class="header-inv-id">#4200</div><div class="header-inv-title">Example detection</div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">Example Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div>'
  }));
  await incidentPage.goto("https://xsoar.example.test/Custom/GenericLayout/4200");
  await incidentPage.keyboard.press("Control+Alt+K");
  await incidentPage.waitForTimeout(50);
  assert.equal(shortcutActivations, 1);
  await incidentPage.goto("https://xsoar.example.test/incidents");
  await incidentPage.keyboard.press("Control+Alt+K");
  await incidentPage.waitForTimeout(50);
  assert.equal(shortcutActivations, 1);
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
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
}
