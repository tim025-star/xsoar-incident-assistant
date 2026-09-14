import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { DEFAULT_SETTINGS, resolveSettings } from "../extension/domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "../extension/page-adapter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectRoot, "extension");
const outputPath = path.join(projectRoot, "output", "playwright");
const executableCandidates = [
  process.env.XSOAR_ASSISTANT_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
const executablePath = executableCandidates.find(existsSync);

if (!executablePath) {
  throw new Error("Chrome or Microsoft Edge was not found. Set XSOAR_ASSISTANT_BROWSER_PATH to verify the extension UI.");
}

const assets = new Map([
  ["/options.html", ["options.html", "text/html; charset=utf-8"]],
  ["/options.js", ["options.js", "text/javascript; charset=utf-8"]],
  ["/sidepanel.html", ["sidepanel.html", "text/html; charset=utf-8"]],
  ["/sidepanel.js", ["sidepanel.js", "text/javascript; charset=utf-8"]],
  ["/domain.js", ["domain.js", "text/javascript; charset=utf-8"]],
  ["/ui.css", ["ui.css", "text/css; charset=utf-8"]]
]);
const server = http.createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
  response.end(await readFile(path.join(extensionPath, asset[0])));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript((defaults) => {
    globalThis.chrome = {
      permissions: {
        getAll: async () => ({ origins: ["https://xsoar.example.test/*"] }),
        request: async () => true,
        remove: async () => true
      },
      runtime: {
        sendMessage: async ({ type }) => type === "GET_SETTINGS" ? defaults : {},
        openOptionsPage: async () => {}
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {}
        }
      }
    };
  }, DEFAULT_SETTINGS);
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/options.html`);
  await page.waitForSelector("#settings-form");
  assert.equal(await page.locator("#analyst-name").inputValue(), "");
  assert.equal(await page.locator("#search-parameter").inputValue(), "query");
  assert.match(await page.locator("body").innerText(), /does not store credentials/i);
  assert.equal(await page.locator("#import-settings").isVisible(), false);
  await page.locator("#allowed-origin").fill("https://xsoar.example.test");
  await page.locator("button[type='submit']").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Settings saved"));
  assert.match(await page.locator("#search-preview").textContent(), /^https:\/\/xsoar\.example\.test\/incidents\?query=/);
  await mkdir(outputPath, { recursive: true });
  await page.screenshot({ path: path.join(outputPath, "settings.png"), fullPage: true });

  await page.goto(`http://127.0.0.1:${address.port}/sidepanel.html`);
  await page.waitForSelector("#run");
  assert.match(await page.locator("body").innerText(), /current browser session/i);
  assert.equal(await page.locator("#draft-section").isVisible(), false);
  await page.screenshot({ path: path.join(outputPath, "sidepanel.png"), fullPage: true });

  const settings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
    pageReadyTimeoutMs: 1000
  });
  await page.setContent(`
    <div class="header-inv-id">#4200</div>
    <div class="header-inv-title" title="Example detection">Example detection</div>
    <div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper"><span class="text-field-display-value">Example Rule</span></div></div>
    <div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper"><span class="text-field-display-value">Endpoint</span></div></div>
    <table><tr><td>Source IP</td><td>192.0.2.10</td></tr></table>
  `);
  await page.evaluate(() => history.replaceState({}, "", "/Custom/GenericLayout/4200"));
  const incident = await page.evaluate(extractIncidentFromPage, settings);
  assert.equal(incident.ticketId, "4200");
  assert.equal(incident.ruleName, "Example Rule");
  assert.equal(incident.caseType, "Endpoint");
  assert.equal(incident.sourceIp, "192.0.2.10");

  await page.setContent(`
    <div id="incidents-page" role="grid" aria-rowcount="2">
      <a href="/incident/4198">4198</a>
      <a href="/incident/4199">4199</a>
    </div>
    <div class="table-paging-message">1–2 out of 2</div>
  `);
  const results = await page.evaluate(extractSearchResultsFromPage, { maxResults: 2, timeoutMs: 1000 });
  assert.deepEqual(results.tickets.map(({ ticketId }) => ticketId), ["4199", "4198"]);
  process.stdout.write(`Verified extension UI and DOM extraction in ${path.basename(executablePath)}.\n`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
