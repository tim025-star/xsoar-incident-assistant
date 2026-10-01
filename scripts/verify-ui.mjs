import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

import { submitHistoricSearch } from "../src/browser-session.js";
import { createAssistantServer } from "../src/server.js";
import { resolveAppConfig } from "../src/config.js";
import { resolveSettings } from "../src/domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "../src/page-adapter.js";
import { runIncidentDraft } from "../src/workflow.js";

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
let failNextStart = false;
let consolePage;
let workflowPage;
let consoleRestoreCalls = 0;
let foregroundPage = "console";
let registeredConsoleUrl = "";
const pulledModels = [];
const requestedIncidentIds = [];
let layaInstalled = false;
let nextConfigSaveError = "";
const demoCheckpoint = {
  id: "expanded-training-cuda-632-alerts-v1",
  label: "Reviewed 632-alert Laya demo",
  channel: "demo",
  weightsSha256: "a".repeat(64),
  trainingComplete: true,
  promotionEligible: false,
  trainingSequences: 23512,
  developmentSequences: 5338,
  sequenceAccuracy: 0.8115399025852379,
  warning: "Review every mapping."
};
const firstAiChunk = `{"eventSummary":"${Array.from({ length: 60 }, (_, index) => `field-${index + 1}`).join("\\n")}`;
const secondAiChunk = '","observedFacts":[]}';
const generatedDraft = Array.from({ length: 60 }, (_, index) => `Evidence field ${index + 1}: observed value`).join("\n");
let finishFirstAiResponse;
const firstAiResponseCanFinish = new Promise((resolve) => { finishFirstAiResponse = resolve; });
const sessions = {
  status: () => ({ running: sessionRunning }),
  openSetup: () => { setupOpens += 1; },
  start: async () => {
    starts += 1;
    if (failNextStart) {
      failNextStart = false;
      throw new Error("Enable remote debugging in Chrome, approve the prompt, then try again.");
    }
    sessionRunning = true;
    return {};
  },
  stop: async () => { sessionRunning = false; },
  setConsoleUrl: (url) => { registeredConsoleUrl = url; },
  showConsole: async () => {
    consoleRestoreCalls += 1;
    foregroundPage = "console";
    await consolePage?.bringToFront();
  },
  adapter: () => ({})
};
const app = createAssistantServer({
  token: "browser-verification-token",
  routerOptions: {
    sessions,
    configStore: {
      load: async () => uiConfig,
      save: async (input, options) => {
        if (nextConfigSaveError) {
          const message = nextConfigSaveError;
          nextConfigSaveError = "";
          throw new Error(message);
        }
        uiConfig = resolveAppConfig(input, options);
        return uiConfig;
      }
    },
    localAi: {
      status: async () => ({ available: true, models: ["qwen3.5:9b"], detail: "Ollama is online and ready." }),
      enrich: async ({ onToken }) => {
        onToken(firstAiChunk);
        await firstAiResponseCanFinish;
        onToken(secondAiChunk);
        return {};
      }
    },
    localAiInstaller: {
      installModel: async (model, { signal } = {}) => {
        pulledModels.push(model);
        if (model !== "slow-model") return [model];
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Local Ollama model download was cancelled.")), { once: true });
        });
      }
    },
    layaMapper: {
      status: async () => ({
        available: layaInstalled,
        detail: layaInstalled ? "Laya-mapper is ready." : "Laya-mapper is not installed.",
        checkpoints: []
      }),
      mapIncident: async ({ targets, onProgress }) => {
        onProgress?.({ detail: "Final assessment sourceIp: forward 7/7 fields.", stage: "final_assessment", completed: 7, total: 7, target: "sourceIp", pass: "forward" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {
          fields: targets.includes("sourceIp") ? { sourceIp: "203.0.113.8" } : {},
          paths: targets.includes("sourceIp") ? { sourceIp: "/documents/0/alertEnvelope/network/peer" } : {},
          statuses: Object.fromEntries(targets.map((t) => [t, t === "sourceIp" ? "selected" : "no_supported_match"])), provenance: Object.fromEntries(targets.map((t) => [t, { agreement: { value: t === "sourceIp" ? "agreed" : "none" } }])), warning: "", complete: true, sourceComplete: true, processingComplete: true, runtime: { effectiveWorkers: 1 }, timings: { totalMs: 2000 }, leaves: 7
        };
      },
      close: () => {}
    },
    layaMapperInstaller: {
      installInference: async () => { layaInstalled = true; return { installed: true, checkpointId: demoCheckpoint.id }; }
    },
    layaInstallManifest: { schemaVersion: 4, checkpoint: demoCheckpoint },
    layaInstallationIdentityReader: async () => layaInstalled ? { schemaVersion: 1, checkpoint: demoCheckpoint } : undefined,
    generateDraft: async ({ incidentId, onProgress, enrichDraft, mapIncident }) => {
      requestedIncidentIds.push(incidentId);
      if (incidentId === "4301") {
        const mapped = await mapIncident({
          incident: { alertJson: [{ sourceIp: "203.0.113.8" }], alertJsonComplete: true },
          targets: ["sourceIp"]
        });
        return {
          draft: `Source: ${mapped.fields.sourceIp}`, warning: "", reviewed: 0, aiEnriched: false,
          layaMapped: true, layaFields: [{ key: "sourceIp", pointer: mapped.paths.sourceIp }],
          layaTentativeFields: [], processingMode: "Laya mapping"
        };
      }
      await onProgress("Running local AI data processing.");
      await enrichDraft?.({ incident: {} });
      foregroundPage = "workflow";
      await workflowPage?.bringToFront();
      return { draft: generatedDraft, warning: "", reviewed: 0, aiEnriched: true, layaMapped: false, processingMode: "Deterministic extraction + Qwen enrichment" };
    }
  }
});
const url = await app.listen(0);
assert.equal(registeredConsoleUrl, url);
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

  // Exercise the built theme bootstrap under the server's real CSP, independently
  // of the incident workflow fixtures below.
  const themeContext = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 900 } });
  const themePage = await themeContext.newPage();
  const themeErrors = [];
  themePage.on("pageerror", (error) => themeErrors.push(error.message));
  await themePage.goto(url);
  const themeSelect = themePage.getByLabel("Theme", { exact: true });
  const assertTheme = async (page, dark) => {
    await page.waitForFunction((expected) => document.documentElement.classList.contains("dark") === expected, dark);
    assert.equal(await page.locator("html").evaluate((node) => getComputedStyle(node).colorScheme), dark ? "dark" : "light");
    assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor), dark ? "rgb(28, 28, 28)" : "rgb(244, 247, 251)");
  };
  await themeSelect.waitFor();
  assert.equal(await themeSelect.inputValue(), "system");
  await assertTheme(themePage, true);
  await themePage.emulateMedia({ colorScheme: "light" });
  await assertTheme(themePage, false);
  await themeSelect.selectOption("dark");
  await assertTheme(themePage, true);
  await themePage.reload();
  await themeSelect.waitFor();
  assert.equal(await themeSelect.inputValue(), "dark", "explicit preferences survive reloads and override the system");
  await assertTheme(themePage, true);

  await mkdir("output/playwright", { recursive: true });
  for (const mode of ["dark", "light"]) {
    await themeSelect.selectOption(mode);
    for (const [pathname, control] of [["/", "#draft"], ["/tools", "#sanitizerInput"], ["/configuration", "#allowedOrigin"], ["/ai", "#localAiModel"], ["/laya", "#layaTestJson"]]) {
      await themePage.goto(new URL(pathname, url).href);
      await themePage.locator(control).waitFor();
      assert.equal(await themeSelect.inputValue(), mode, `${pathname} preserves the selected theme`);
      await assertTheme(themePage, mode === "dark");
      assert.equal(await themePage.locator(control).evaluate((node) => getComputedStyle(node).backgroundColor), mode === "dark" ? "rgb(38, 38, 38)" : "rgb(255, 255, 255)");
      await themePage.screenshot({ path: `output/playwright/${mode}-${pathname.slice(1) || "home"}.png`, fullPage: true });
    }
  }
  await themePage.emulateMedia({ colorScheme: "dark" });
  await assertTheme(themePage, false);
  await themeSelect.selectOption("system");
  await assertTheme(themePage, true);
  assert.equal(await themePage.evaluate(() => localStorage.getItem("xsoar-theme")), null);

  const otherThemePage = await themeContext.newPage();
  await otherThemePage.goto(url);
  await otherThemePage.getByLabel("Theme", { exact: true }).waitFor();
  await themeSelect.selectOption("light");
  await assertTheme(otherThemePage, false);
  assert.equal(await otherThemePage.getByLabel("Theme", { exact: true }).inputValue(), "light", "open tabs synchronize the selector");

  // The initial preference must apply even while the main app bundle is delayed.
  await themeSelect.selectOption("dark");
  let releaseAppBundle;
  const appBundleGate = new Promise((resolve) => { releaseAppBundle = resolve; });
  await otherThemePage.route("**/assets/index-*.js", async (route) => { await appBundleGate; await route.continue(); });
  await otherThemePage.reload({ waitUntil: "commit" });
  await otherThemePage.waitForFunction(() => document.documentElement.dataset.themePreference === "dark");
  assert.equal(await otherThemePage.locator("html").getAttribute("class"), "dark", "theme applies before the app bundle executes");
  releaseAppBundle();
  await otherThemePage.getByLabel("Theme", { exact: true }).waitFor();
  await otherThemePage.close();
  await themePage.setViewportSize({ width: 320, height: 800 });
  await themePage.goto(url);
  await themePage.locator("#draft").waitFor();
  assert.equal(await themePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "theme controls fit a narrow viewport");
  await themePage.screenshot({ path: "output/playwright/dark-mobile.png", fullPage: true });
  assert.deepEqual(themeErrors, []);
  await themeContext.close();

  const noStorageContext = await browser.newContext({ colorScheme: "dark" });
  await noStorageContext.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage disabled", "SecurityError"); } });
  });
  const noStoragePage = await noStorageContext.newPage();
  const noStorageErrors = [];
  noStoragePage.on("pageerror", (error) => noStorageErrors.push(error.message));
  await noStoragePage.goto(url);
  await noStoragePage.getByLabel("Theme", { exact: true }).selectOption("light");
  await assertTheme(noStoragePage, false);
  assert.deepEqual(noStorageErrors, [], "unavailable storage must not prevent using the app or selecting a theme");
  await noStorageContext.close();

  const page = await browser.newPage();
  consolePage = page;
  await page.goto(url);
  await page.getByRole("heading", { name: "XSOAR Incident Assistant" }).waitFor();
  assert.equal(await page.locator("#setup").count(), 0, "Chrome setup must stay hidden until a connection misconfiguration is detected");
  assert.equal(await page.locator("#allowedOrigin").count(), 0, "configuration controls must not appear on the home page");
  await page.getByRole("link", { name: "Configuration", exact: true }).click();
  await page.getByRole("heading", { name: "JSON log mapping" }).waitFor();
  assert.equal(await page.locator("#localAiEnabled,#layaWorkerMode").count(), 0, "optional settings belong on their own pages");
  assert.equal(await page.locator("#searchQueryParameter").count(), 0, "the unused URL search parameter must not be editable");
  await page.getByRole("link", { name: "Tools", exact: true }).click();
  await page.getByRole("heading", { name: "JSON sanitizer" }).waitFor();
  assert.equal(await page.locator("#allowedOrigin").count(), 0, "configuration controls must not appear on the tools page");
  await page.locator("#sanitizerInput").fill(JSON.stringify({
    user: { email: "private@example.test", "display.name": "Private Person" },
    events: [{ actor: { email: "first@example.test" } }, { actor: { email: "second@example.test" } }],
    emptyObject: {}, emptyArray: [], missing: null
  }));
  await page.locator("#sanitizeJson").click();
  const sanitized = JSON.parse(await page.locator("#sanitizerOutput").inputValue());
  assert.deepEqual(sanitized, {
    "user.email": "[REDACTED]",
    "user.display\\.name": "[REDACTED]",
    "events.actor.email": "[REDACTED]",
    emptyObject: "[REDACTED]",
    emptyArray: "[REDACTED]",
    missing: "[REDACTED]"
  });
  assert.equal(JSON.stringify(sanitized).includes("private@example.test"), false);
  await page.locator("#sanitizerMode").selectOption("empty");
  await page.locator("#sanitizeJson").click();
  assert.ok(Object.values(JSON.parse(await page.locator("#sanitizerOutput").inputValue())).every((value) => value === ""));
  await page.getByRole("link", { name: "Configuration", exact: true }).click();
  await page.getByRole("heading", { name: "JSON log mapping" }).waitFor();
  await page.locator("#allowedOrigin").fill("https://xsoar.example.test");
  await page.locator("#fieldLabel-occurred").fill("Occurred, Event Time");
  nextConfigSaveError = "Configuration could not be written.";
  await page.locator("#saveMappings").click();
  await page.getByText("Configuration could not be written.", { exact: true }).waitFor();
  assert.equal(await page.locator("#allowedOrigin").inputValue(), "https://xsoar.example.test", "a failed save must preserve the edited tenant");
  assert.equal(await page.locator("#fieldLabel-occurred").inputValue(), "Occurred, Event Time", "a failed save must preserve other edits");
  assert.equal(uiConfig.xsoar.allowedOrigin, "", "a failed save must not change persisted configuration");
  assert.equal(await page.locator("#status").getAttribute("role"), "alert", "save failures must be highlighted");
  await page.locator("#saveMappings").click();
  await page.getByText("XSOAR config saved.").waitFor();
  assert.equal(await page.locator("#mode").count(), 0);
  assert.equal(await page.locator("#profileDirectory").count(), 0);
  assert.equal("session" in uiConfig, false);
  await page.getByRole("link", { name: "Laya", exact: true }).click();
  await page.getByRole("heading", { name: "Laya-mapper", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/laya");
  assert.equal(await page.locator("#allowedOrigin,#localAiEnabled").count(), 0);
  assert.equal(await page.locator("#layaMapperEnabled").count(), 0);
  assert.equal(await page.locator("#layaWorkerMode").inputValue(), "auto");
  await page.locator("#layaModelIdentity").getByText("expanded-training-cuda-632-alerts-v1", { exact: true }).waitFor();
  await page.locator("#installLayaMapper").click();
  await page.getByText("Laya-mapper is ready.").waitFor();
  nextConfigSaveError = "Laya settings could not be written.";
  await page.locator("#layaWorkerMode").selectOption("manual");
  await page.getByRole("alert").getByText("Laya settings could not be written.", { exact: true }).waitFor();
  assert.equal(await page.locator("#layaWorkerMode").inputValue(), "manual");
  assert.equal(uiConfig.layaMapper.workerMode, "auto");
  await page.locator("#layaWorkerCount").selectOption("2");
  await page.getByText("Laya-mapper config saved.").waitFor();
  assert.equal(await page.locator("#status").getAttribute("role"), "status");

  const verifySettingsExport = async () => {
    const downloading = page.waitForEvent("download");
    await page.locator("#exportSettings").click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "xsoar-incident-assistant-settings.json");
    const exported = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.deepEqual(exported, uiConfig);
    assert.doesNotMatch(JSON.stringify(exported), /browser-verification-token/);
  };
  assert.equal(uiConfig.layaMapper.enabled, false);
  assert.equal(uiConfig.layaMapper.workerMode, "manual");
  assert.equal(await page.locator("#layaExperiment").count(), 0);
  await page.locator("#runLayaTest").click();
  await page.locator("#layaTestProgress").waitFor();
  await page.locator("#layaTestProgress").getByText(/Laya test: Final assessment/).waitFor();
  await page.locator("#layaProgressStage").getByText("final assessment", { exact: true }).waitFor();
  await page.locator("#layaTestResult").waitFor();
  assert.equal(await page.locator("#layaTestResult").getByText("203.0.113.8", { exact: true }).count(), 1);
  assert.equal(await page.locator("#layaTestResult").getByText("Value agreement: agreed", { exact: true }).count(), 1);
  assert.equal(await page.locator("#layaTestResult").getByText("/documents/0/alertEnvelope/network/peer", { exact: true }).count(), 1);
  assert.equal(await page.locator("#startLayaTraining").count(), 0);
  await page.getByRole("link", { name: "AI", exact: true }).click();
  await page.getByRole("heading", { name: "Local AI", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/ai");
  assert.equal(await page.locator("#allowedOrigin,#layaWorkerMode").count(), 0);
  assert.equal(await page.locator("#localAiEnabled").isChecked(), false);
  assert.equal(await page.locator("#localAiModel").inputValue(), "qwen3.5:9b");
  assert.deepEqual(await page.locator("#localAiModels option").evaluateAll((options) => options.map((option) => option.value)), ["qwen3.5:9b"]);
  assert.equal(await page.locator("#pullModel").textContent(), "Install default model");
  await page.locator("#localAiModel").fill("invalid model");
  await page.locator("#localAiEnabled").check();
  await page.getByRole("alert").getByText(/Local model names may contain/).waitFor({ timeout: 3000 });
  await page.waitForTimeout(700);
  assert.match(await page.locator("#status").textContent(), /Local model names may contain/, "status polling must not clear schema validation errors");
  assert.equal(await page.locator("#localAiModel").inputValue(), "invalid model");
  assert.equal(await page.locator("#localAiEnabled").isChecked(), true);
  assert.equal(uiConfig.localAi.enabled, false);
  await page.locator("#localAiModel").fill("qwen3.5:9b");
  await page.locator("#localAiEnabled").check();
  await page.locator("#pullModel").click();
  await page.getByText("Model qwen3.5:9b is ready for field processing.").waitFor();
  assert.deepEqual(pulledModels, ["qwen3.5:9b"]);

  await page.locator("#localAiModel").fill("slow-model");
  assert.equal(await page.locator("#pullModel").textContent(), "Pull selected model");
  await page.locator("#pullModel").click();
  await page.locator("#cancelPull").waitFor();
  const pullStartDeadline = Date.now() + 5000;
  while (!pulledModels.includes("slow-model") && Date.now() < pullStartDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(pulledModels.includes("slow-model"), "the download must start on the server before reloading the page");
  await page.reload();
  await page.locator("#cancelPull").waitFor();
  await page.locator("#cancelPull").click();
  await page.getByText("Local Ollama model download was cancelled.").waitFor({ timeout: 3000 });
  await page.locator("#cancelPull").waitFor({ state: "detached", timeout: 3000 });
  assert.deepEqual(pulledModels, ["qwen3.5:9b", "slow-model"]);
  await page.locator("#localAiEnabled").check();

  await page.getByRole("link", { name: "Configuration", exact: true }).click();
  await page.getByRole("heading", { name: "JSON log mapping" }).waitFor();
  await page.getByText("Advanced XSOAR routing and historic search").click();
  const customHistoricQuery = 'name:{incidentName} and tenantname:{tenantName} and status:closed';
  await page.locator("#historicQueryTemplate").fill(customHistoricQuery);
  await page.locator("#previewHistoricQuery").click();
  await page.locator("#historicQueryPreview").getByText('name:"Example detection" and tenantname:"Example Organisation" and status:closed').waitFor();
  await page.locator("#historicQueryMode").selectOption("json");
  await page.locator("#analystName").fill("Example Analyst");
  await page.locator("#historicQueryJson").fill("{");
  await page.locator("#saveMappings").click();
  await page.getByRole("alert").getByText("historicQueryJson must be valid JSON.", { exact: true }).waitFor();
  assert.equal(await page.locator("#historicQueryJson").inputValue(), "{");
  assert.equal(await page.locator("#historicQueryMode").inputValue(), "json");
  assert.equal(await page.locator("#analystName").inputValue(), "Example Analyst");
  assert.equal(uiConfig.xsoar.template.analystName, "");
  await page.locator("#historicQueryJson").fill(JSON.stringify({ query: customHistoricQuery }));
  await page.locator("#previewHistoricQuery").click();
  await page.locator("#historicQueryPreview").getByText('name:"Example detection" and tenantname:"Example Organisation" and status:closed').waitFor();
  await page.locator("#historicQueryMode").selectOption("javascript");
  const customHistoricJavaScript = 'function buildQuery(incident, quote) { if (incident.tenantName === "Example Organisation") return `name:${quote(incident.incidentName)} and tenantname:${quote(incident.tenantName)} and status:closed`; return "status:open"; }';
  await page.locator("#historicQueryJavaScript").fill(customHistoricJavaScript);
  await page.locator("#previewHistoricQuery").click();
  await page.locator("#historicQueryPreview").getByText('name:"Example detection" and tenantname:"Example Organisation" and status:closed').waitFor();
  await page.locator("#maxHistoricalIncidents").fill("10");
  await page.locator("#analystName").fill("Example Analyst");
  await page.locator("#saveMappings").click();
  await page.getByText("XSOAR config saved.").waitFor();
  assert.deepEqual(uiConfig.xsoar.fieldLabels.occurred, ["Occurred", "Event Time"]);
  assert.equal(uiConfig.xsoar.maxHistoricalIncidents, 10);
  assert.equal(uiConfig.xsoar.historicQueryTemplate, customHistoricQuery);
  assert.equal(uiConfig.xsoar.historicQueryMode, "javascript");
  assert.equal(uiConfig.xsoar.historicQueryJavaScript, customHistoricJavaScript);
  assert.equal(uiConfig.xsoar.template.analystName, "Example Analyst");
  assert.equal(await page.locator("#status").getAttribute("role"), "status");
  await page.locator("#analystName").fill("Unsaved Analyst");
  await verifySettingsExport();
  assert.equal(await page.locator("#analystName").inputValue(), "Unsaved Analyst");
  await page.locator("#analystName").fill("Example Analyst");

  await page.getByRole("link", { name: "Laya", exact: true }).click();
  await page.locator("#useLayaMapping").waitFor();
  await page.locator("#useLayaMapping").check();
  await page.getByText("Laya-mapper config saved.").waitFor();
  assert.equal(uiConfig.layaMapper.enabled, true);
  await page.locator("#useLayaMapping").uncheck();
  await page.getByText("Laya-mapper config saved.").waitFor();
  assert.equal(uiConfig.layaMapper.enabled, false);
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("heading", { name: "Process incident data" }).waitFor();
  assert.equal(await page.locator("#useLayaMapping,#localAiEnabled").count(), 0);
  await page.locator("#open").click();
  await page.locator("#stop:not([disabled])").waitFor({ timeout: 2000 });
  assert.equal(starts, 1);
  assert.equal(uiConfig.xsoar.allowedOrigin, "https://xsoar.example.test");
  assert.equal(uiConfig.localAi.enabled, true);
  await page.getByText("Chrome connected.").waitFor({ timeout: 2000 });
  await page.getByRole("link", { name: "Configuration", exact: true }).click();
  assert.equal(await page.locator("#allowedOrigin").isDisabled(), true);
  assert.equal(await page.locator("#analystName").isDisabled(), true);
  assert.equal(await page.locator("#fieldLabel-occurred").isDisabled(), true);
  assert.equal(await page.locator("#exportSettings").isDisabled(), false);
  await verifySettingsExport();
  await page.getByRole("link", { name: "AI", exact: true }).click();
  await page.locator("#localAiEnabled").waitFor();
  assert.equal(await page.locator("#localAiEnabled").isDisabled(), false);
  await page.locator("#localAiEnabled").uncheck();
  await page.getByText("Local AI config saved.").waitFor();
  assert.equal(uiConfig.localAi.enabled, false);
  await page.locator("#localAiEnabled").check();
  await page.getByText("Local AI config saved.").waitFor();
  assert.equal(uiConfig.localAi.enabled, true);
  await page.getByRole("link", { name: "Home" }).click();
  await page.locator("#stop").click();
  await page.getByText("Your browser and tabs are still open.").waitFor();
  assert.equal(sessionRunning, false);

  failNextStart = true;
  await page.locator("#open").click();
  await page.getByRole("heading", { name: "Chrome access needs attention" }).waitFor();
  await page.locator("#setup").click();
  await page.getByText("Chrome access setup opened.").waitFor();
  assert.equal(setupOpens, 1);
  await page.locator("#open").click();
  await page.locator("#stop:not([disabled])").waitFor({ timeout: 2000 });
  assert.equal(await page.locator("#setup").count(), 0);

  await page.getByText("Target a specific incident").click();
  await page.locator("#incidentId").fill("4300");
  workflowPage = await browser.newPage();
  await workflowPage.setContent("<title>XSOAR workflow</title><main>Incident workflow</main>");
  await page.locator("#run").click();
  await page.waitForFunction(
    (chunk) => (document.querySelector("#draft")?.value || "").includes(chunk),
    firstAiChunk,
    { timeout: 3000 }
  );
  const liveReadingPosition = await page.locator("#draft").evaluate((element) => {
    element.style.minHeight = "0";
    element.style.height = "80px";
    element.scrollTop = Math.floor(element.scrollHeight / 3);
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  assert.ok(liveReadingPosition > 0, "the live response fixture must overflow its text area");
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#draft").evaluate((element) => element.scrollTop), liveReadingPosition, "status refreshes must preserve the reader's live-output scroll position");
  finishFirstAiResponse();
  await page.locator("#copy:not([disabled])").waitFor();
  assert.equal(await page.locator("#aiDraftAcknowledgement").count(), 0, "copying processed data must not require an acknowledgement gate");
  assert.equal(await page.locator("#aiOutput").count(), 0, "live AI output belongs in the processed-data field, not a separate field");
  assert.equal(await page.locator("#draft").inputValue(), generatedDraft);
  assert.equal(await page.locator("#processingMode").textContent(), "Processing used: Deterministic extraction + Qwen enrichment.");
  const draftReadingPosition = await page.locator("#draft").evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
    return element.scrollTop;
  });
  assert.ok(draftReadingPosition > 0, "the response fixture must overflow its text area");
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#draft").evaluate((element) => element.scrollTop), draftReadingPosition, "status refreshes must preserve the reader's response scroll position");
  assert.equal(foregroundPage, "console", "the local console must return to the foreground when the response is ready");
  assert.equal(consoleRestoreCalls, 1);
  await workflowPage.close();
  workflowPage = undefined;
  assert.deepEqual(requestedIncidentIds, ["4300"]);
  assert.equal(await page.locator("#copy").isDisabled(), false);
  await page.getByRole("link", { name: "Laya", exact: true }).click();
  await page.locator("#useLayaMapping").check();
  await page.getByText("Laya-mapper config saved.").waitFor();
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("heading", { name: "Process incident data" }).waitFor();
  await page.getByText("Target a specific incident").click();
  await page.locator("#incidentId").fill("4301");
  await page.locator("#run").click();
  await page.locator("#incidentLayaProgress").getByText("Laya stage: final assessment").waitFor();
  await page.locator("#layaFieldProvenance").getByText("Source IP").waitFor();
  assert.match(await page.locator("#draft").inputValue(), /Source: 203\.0\.113\.8/);
  assert.match(await page.locator("#layaFieldProvenance").textContent(), /\/documents\/0\/alertEnvelope\/network\/peer/);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [link, heading] of [["Configuration", "JSON log mapping"], ["AI", "Local AI"], ["Laya", "Laya-mapper"]]) {
      await page.getByRole("link", { name: link, exact: true }).click();
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: link, exact: true }).getAttribute("aria-current"), "page");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${link} must fit a ${width}px viewport`);
      await page.reload();
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    }
  }

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

  const mappedLogPage = await browser.newPage();
  await mappedLogPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: '<div class="header-inv-id">#4202</div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">Mapped Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div><table><tr><td>Observed Address</td><td>192.0.2.42</td></tr></table>'
  }));
  await mappedLogPage.goto("https://xsoar.example.test/Custom/GenericLayout/4202");
  const mappedIncident = await mappedLogPage.evaluate(extractIncidentFromPage, {
    ...settings,
    fieldLabels: { ...settings.fieldLabels, destinationIp: ["Observed Address"] }
  });
  assert.equal(mappedIncident.destinationIp, "192.0.2.42");
  await mappedLogPage.close();

  const jsonLogPage = await browser.newPage();
  await jsonLogPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: '<div class="header-inv-id">#4203</div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">JSON Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div><div class="field-wrapper"><label>Detailed Alert JSON</label><div class="value-wrapper"><div class="markdown">{"network":{"destination":{"ip":"198.51.100.24"}},"events":[{"actor":{"user_name":"example.user"}}]}</div></div></div><div class="markdown">{"authorization":"must-not-be-collected"}</div>'
  }));
  await jsonLogPage.goto("https://xsoar.example.test/Custom/GenericLayout/4203");
  const jsonIncident = await jsonLogPage.evaluate(extractIncidentFromPage, {
    ...settings,
    fieldLabels: {
      ...settings.fieldLabels,
      destinationIp: ["network.destination.ip"],
      sourceUsername: ["events.actor.user_name"]
    }
  });
  assert.equal(jsonIncident.destinationIp, "198.51.100.24");
  assert.equal(jsonIncident.sourceUsername, "example.user");
  assert.deepEqual(jsonIncident.alertJson, [{ network: { destination: { ip: "198.51.100.24" } }, events: [{ actor: { user_name: "example.user" } }] }]);
  await jsonLogPage.close();

  const searchPage = await browser.newPage();
  const historicQuery = 'rawName:"Example detection" and tenantname:"Example Organisation" and (created:>="3 months ago")';
  await searchPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<header><span class="header-search"><input autocomplete="off" placeholder="Search in Incidents" type="text" class="xsoar-input search-input header-search-input"></span></header><main id="incidents-page"><div class="react-select-dropdown-multiple__input"><input type="text"></div><label>Incident query<textarea aria-label="Incident search query">-status:closed -category:job</textarea></label><div role="grid" aria-rowcount="0"></div><div class="table-paging-message"></div></main><script>document.querySelector("textarea").addEventListener("keydown", (event) => { if (event.key !== "Enter") return; event.preventDefault(); document.querySelector("[role=grid]").innerHTML = '<div class="row"><a href="/incidents">#4199</a></div>'; document.querySelector("[role=grid]").setAttribute("aria-rowcount", "1"); document.querySelector(".table-paging-message").textContent = "1-1 of 1"; });</script>`
  }));
  await searchPage.goto("https://xsoar.example.test/incidents");
  await submitHistoricSearch(searchPage, {
    expectedOrigin: "https://xsoar.example.test",
    expectedPath: "/incidents",
    expectedQuery: historicQuery,
    queryParameter: "query",
    timeoutMs: 2000
  });
  assert.equal(await searchPage.locator(".header-search input").inputValue(), "");
  assert.equal(await searchPage.locator(".react-select-dropdown-multiple__input input").inputValue(), "");
  assert.equal(await searchPage.locator("#incidents-page textarea").inputValue(), historicQuery);
  const historicResults = await searchPage.evaluate(extractSearchResultsFromPage, {
    expectedOrigin: "https://xsoar.example.test",
    expectedPath: "/incidents",
    queryParameter: "query",
    expectedQuery: historicQuery,
    incidentUrlPattern: settings.incidentUrlPattern,
    maxResults: 100,
    timeoutMs: 2000
  });
  assert.deepEqual(historicResults.ticketIds, ["4199"]);
  // The incidents-page toolbar has a persistent loading element outside the results grid.
  await searchPage.setContent(`<a href="/incident/9997">Outside results</a><main id="incidents-page">
    <div class="toolbar-buttons"><span class="table-loading loading"><span class="demisto-loader-wrapper row table-loader"></span></span></div>
    <div class="fixedDataTableLayout_main public_fixedDataTable_main" role="grid" aria-rowcount="2">
      <div class="fixedDataTableLayout_rowsContainer">
        <div role="row"><div role="columnheader">Tenant Name</div><div role="columnheader">ID</div><div role="columnheader">Name</div></div>
        <div role="row"><div role="gridcell">Example Organisation</div><div role="gridcell"><span>unstarred incident</span><div><a class="investigation-id" href="/incident/4199">4199</a></div></div><div role="gridcell">Synthetic alert</div></div>
      </div>
    </div><div class="table-paging-message">Page 1 of many</div>
  </main>`);
  const scopedResults = await searchPage.evaluate(extractSearchResultsFromPage, {
    expectedOrigin: "https://xsoar.example.test", expectedPath: "/incidents", maxResults: 100, timeoutMs: 2000
  });
  assert.deepEqual(scopedResults.ticketIds, ["4199"], "a toolbar loading element must not prevent reading the results grid");
  assert.deepEqual(scopedResults.ticketUrls, { 4199: "https://xsoar.example.test/incident/4199" });
  assert.equal(scopedResults.ticketRows["4199"].name, "Synthetic alert");
  assert.equal(scopedResults.truncated, true, "unknown paging must continue to report incomplete coverage");
  await searchPage.evaluate(() => {
    const grid = document.querySelector(".fixedDataTableLayout_main");
    const loading = grid.appendChild(document.createElement("div"));
    loading.className = "loading";
    loading.textContent = "Loading";
    setTimeout(() => {
      const link = grid.querySelector("a.investigation-id");
      link.href = "/incident/4198";
      link.textContent = "4198";
      loading.remove();
    }, 600);
  });
  const settledResults = await searchPage.evaluate(extractSearchResultsFromPage, {
    expectedOrigin: "https://xsoar.example.test", expectedPath: "/incidents", maxResults: 100, timeoutMs: 2000
  });
  assert.deepEqual(settledResults.ticketIds, ["4198"], "loading inside the grid must still prevent collecting stale rows");
  await searchPage.setContent(`<main><table><thead><tr><th>Name</th><th>ID</th><th>Tenant Name</th></tr></thead><tbody>
    <tr><td>Synthetic alert</td><td>4199</td><td>Example Organisation</td></tr>
    <tr><td>Synthetic alert</td><td><a role="button">#4198</a></td><td>Example Organisation</td></tr>
    <tr hidden><td>Synthetic alert</td><td>9999</td><td>Example Organisation</td></tr>
    <tr><td>Synthetic alert</td><td><a href="https://untrusted.example.test/incident/9998">9998</a></td><td>Example Organisation</td></tr>
  </tbody></table></main><div class="table-paging-message">1-2 of 2</div>`);
  const columnResults = await searchPage.evaluate(extractSearchResultsFromPage, {
    expectedOrigin: "https://xsoar.example.test", expectedPath: "/incidents", maxResults: 100, timeoutMs: 2000
  });
  assert.deepEqual(columnResults.ticketIds, ["4199", "4198"]);
  assert.deepEqual(columnResults.ticketUrls, {});
  assert.equal(columnResults.ticketRows["4198"].tenantName, "Example Organisation");
  await searchPage.close();

  const delayedIncidentPage = await browser.newPage();
  await delayedIncidentPage.route("https://xsoar.example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<div class="header-inv-id">#4201</div><div class="header-inv-title">Early title</div><pre data-testid="alert-json">{"event":"early"}</pre><div id="root"></div><script>setTimeout(() => { document.querySelector("#root").innerHTML = '<div class="field-wrapper fieldId-customername"><label>Customer Name</label><div class="value-wrapper">Example Organisation</div></div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper">Delayed Rule</div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper">Endpoint</div></div>'; }, 650);</script>`
  }));
  await delayedIncidentPage.goto("https://xsoar.example.test/Custom/GenericLayout/4201");
  const delayedIncident = await delayedIncidentPage.evaluate(extractIncidentFromPage, {
    ...settings,
    pageReadyTimeoutMs: 2000,
    requiredFields: ["customerName", "ruleName", "caseType"]
  });
  assert.equal(delayedIncident.customerName, "Example Organisation");
  assert.equal(delayedIncident.ruleName, "Delayed Rule");
  assert.equal(delayedIncident.caseType, "Endpoint");
  await delayedIncidentPage.close();

  const workflowContext = await browser.newContext();
  let historicLoads = 0;
  await workflowContext.route("https://xsoar.example.test/**", async (route) => {
    const requested = new URL(route.request().url());
    if (requested.pathname === "/incidents") {
      await route.fulfill({
        contentType: "text/html",
        body: `<main id="incidents-page"><label>Incident query<textarea aria-label="Incident search query"></textarea></label><div role="grid" aria-rowcount="0"></div><div class="table-paging-message"></div></main><script>document.querySelector("textarea").addEventListener("keydown", (event) => { if (event.key !== "Enter") return; event.preventDefault(); const grid = document.querySelector("[role=grid]"); grid.innerHTML = '<div role="row"><div role="columnheader">Created</div><div role="columnheader">Tenant Name</div><div role="columnheader">ID</div><div role="columnheader">Name</div><div role="columnheader">Type</div></div><div role="row"><div role="gridcell">Yesterday</div><div role="gridcell">Example Organisation</div><div role="gridcell"><a role="button">#4199</a></div><div role="gridcell">Synthetic alert</div><div role="gridcell">Endpoint</div></div>'; grid.setAttribute("aria-rowcount", "2"); document.querySelector(".table-paging-message").textContent = "1-1 of 1"; });</script>`
      });
      return;
    }
    const ticketId = requested.pathname.match(/\/(\d+)$/)?.[1] || "";
    if (ticketId === "4199") historicLoads += 1;
    const resolution = ticketId === "4199" && historicLoads > 1
      ? '<div class="field-wrapper fieldId-closenotes"><label>Close Notes</label><div class="value-wrapper"><div class="text-field-display-value">Resolved after foreground retry</div></div></div>'
      : "";
    const currentIdentity = ticketId === "4199" ? "" : `<div class="field-wrapper fieldId-customername"><label>Customer Name</label><div class="value-wrapper"><div class="text-field-display-value">Example Organisation</div></div></div><div class="field-wrapper fieldId-rulename"><label>Rule Name</label><div class="value-wrapper"><div class="text-field-display-value">Synthetic Rule</div></div></div><div class="field-wrapper fieldId-casetype"><label>Type</label><div class="value-wrapper"><div class="text-field-display-value">Endpoint</div></div></div>`;
    const delayedIdentity = ticketId === "4199" ? "" : `<div id="identity"></div><script>setTimeout(() => { document.querySelector(".header-inv-title").textContent = "Synthetic alert"; document.querySelector("#identity").innerHTML = '<div class="field-wrapper fieldId-accountshortname"><label>Account Short Name</label><div class="value-wrapper"><div class="text-field-display-value">Example Organisation</div></div></div>'; }, 900);</script>`;
    await route.fulfill({
      contentType: "text/html",
      body: `<div class="header-inv-id">#${ticketId}</div><div class="header-inv-title">${ticketId === "4199" ? "Synthetic alert" : ""}</div>${currentIdentity}${resolution}${delayedIdentity}`
    });
  });
  const workflowIncidentPage = await workflowContext.newPage();
  await workflowIncidentPage.goto("https://xsoar.example.test/Custom/GenericLayout/4200");
  const workflowSettings = resolveSettings({
    allowedOrigin: "https://xsoar.example.test",
    incidentUrlPattern: "\\/Custom\\/GenericLayout\\/\\d+$",
    pageReadyTimeoutMs: 2500,
    maxHistoricalIncidents: 1
  });
  const workflowAdapter = {
    getActiveTab: async () => ({ id: workflowIncidentPage, url: workflowIncidentPage.url() }),
    openTab: async (requestedUrl, { focusBeforeNavigation = false } = {}) => {
      const openedPage = await workflowContext.newPage();
      if (focusBeforeNavigation) await openedPage.bringToFront();
      await openedPage.goto(requestedUrl, { waitUntil: "domcontentloaded" });
      return { id: openedPage, url: openedPage.url() };
    },
    reloadTab: async (openedPage, requestedUrl, { focusBeforeNavigation = false } = {}) => {
      if (focusBeforeNavigation) await openedPage.bringToFront();
      await openedPage.goto(requestedUrl, { waitUntil: "domcontentloaded" });
    },
    getTabUrl: async (openedPage) => openedPage.url(),
    extractIncident: async (openedPage, extractionSettings) => openedPage.evaluate(
      extractIncidentFromPage,
      extractionSettings
    ),
    extractSearchResults: async (openedPage, options) => {
      assert.equal(options.expectedQuery, 'name:"Synthetic alert" and tenantname:"Example Organisation" and (created:>="3 months ago")');
      await submitHistoricSearch(openedPage, {
        ...options,
        expectedOrigin: workflowSettings.allowedOrigin,
        expectedPath: workflowSettings.incidentsPath
      });
      return openedPage.evaluate(extractSearchResultsFromPage, {
        ...options,
        expectedOrigin: workflowSettings.allowedOrigin,
        expectedPath: workflowSettings.incidentsPath,
        incidentUrlPattern: workflowSettings.incidentUrlPattern
      });
    },
    closeTab: async (openedPage) => openedPage.close(),
    focusTab: async (openedPage) => openedPage.bringToFront()
  };
  const workflowProgress = [];
  const workflowResult = await runIncidentDraft({
    adapter: workflowAdapter,
    settings: workflowSettings,
    incidentId: "4200",
    onProgress: async (message) => workflowProgress.push(message)
  });
  assert.equal(historicLoads, 2, "an incomplete historic render must receive exactly one foreground retry");
  assert.match(workflowResult.draft, /#4199: Resolved after foreground retry/);
  assert.ok(workflowProgress.some((message) => /Retrying historic incident #4199/.test(message)));
  assert.deepEqual(workflowContext.pages(), [workflowIncidentPage], "temporary search and historic tabs must be closed");
  await workflowContext.close();

  console.log("Current-Chrome-only UI, foreground historic retry workflow, upgrade migration, incidents-query submission, and extraction verification passed.");
} finally {
  await browser?.close();
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
}
