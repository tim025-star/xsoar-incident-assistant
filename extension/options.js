import {
  buildIncidentSearchUrl,
  buildSearchQuery,
  permissionPatternForOrigin,
  resolveSettings
} from "./domain.js";

const byId = (id) => document.getElementById(id);
const form = byId("settings-form");
const status = byId("status");

function lines(value) {
  return String(value || "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function formSettings() {
  let fieldLabels;
  try {
    fieldLabels = JSON.parse(byId("field-labels").value);
  } catch {
    throw new Error("Field labels must contain valid JSON.");
  }
  return resolveSettings({
    allowedOrigin: byId("allowed-origin").value,
    incidentUrlPattern: byId("incident-pattern").value,
    incidentsPath: byId("incidents-path").value,
    searchQueryParameter: byId("search-parameter").value,
    lookbackQuery: byId("lookback-query").value,
    maxHistoricalIncidents: Number(byId("max-history").value),
    pageReadyTimeoutMs: Number(byId("page-timeout").value),
    incidentInfoTabLabel: byId("incident-info-label").value,
    investigationTabLabel: byId("investigation-label").value,
    historicalSummaryLabels: lines(byId("historical-summary-labels").value),
    historicalRecommendationLabels: lines(byId("historical-recommendation-labels").value),
    fieldLabels,
    template: {
      greeting: byId("greeting").value,
      recommendationsHeading: byId("recommendations-heading").value,
      contactText: byId("contact-text").value,
      signOff: byId("sign-off").value,
      analystName: byId("analyst-name").value,
      analystTitle: byId("analyst-title").value
    }
  });
}

function populate(settings) {
  byId("allowed-origin").value = settings.allowedOrigin || "";
  byId("incident-pattern").value = settings.incidentUrlPattern;
  byId("incidents-path").value = settings.incidentsPath;
  byId("search-parameter").value = settings.searchQueryParameter;
  byId("lookback-query").value = settings.lookbackQuery;
  byId("max-history").value = settings.maxHistoricalIncidents;
  byId("page-timeout").value = settings.pageReadyTimeoutMs;
  byId("incident-info-label").value = settings.incidentInfoTabLabel;
  byId("investigation-label").value = settings.investigationTabLabel;
  byId("historical-summary-labels").value = (settings.historicalSummaryLabels || []).join("\n");
  byId("historical-recommendation-labels").value = (settings.historicalRecommendationLabels || []).join("\n");
  byId("field-labels").value = JSON.stringify(settings.fieldLabels, null, 2);
  byId("greeting").value = settings.template.greeting;
  byId("recommendations-heading").value = settings.template.recommendationsHeading;
  byId("contact-text").value = settings.template.contactText;
  byId("sign-off").value = settings.template.signOff;
  byId("analyst-name").value = settings.template.analystName;
  byId("analyst-title").value = settings.template.analystTitle;
  updatePreview();
}

function updatePreview() {
  try {
    const settings = formSettings();
    const query = buildSearchQuery("Example Rule", "Example Type", settings.lookbackQuery);
    byId("search-preview").textContent = buildIncidentSearchUrl(settings, query);
  } catch {
    byId("search-preview").textContent = "Complete the tenant settings to preview the generated search URL.";
  }
}

async function reconcileOriginPermissions(requiredOrigin) {
  const requiredPattern = permissionPatternForOrigin(requiredOrigin);
  const granted = await chrome.permissions.getAll();
  const staleOrigins = (granted.origins || []).filter((origin) => origin !== requiredPattern);
  if (staleOrigins.length) {
    const removed = await chrome.permissions.remove({ origins: staleOrigins });
    if (!removed) throw new Error("Old tenant access could not be removed. Review this extension's site access and try again.");
  }
  const verified = await chrome.permissions.getAll();
  const unexpected = (verified.origins || []).filter((origin) => origin !== requiredPattern);
  if (unexpected.length) throw new Error("The browser still reports access to an old tenant. Remove it from extension site access before continuing.");
}

async function saveSettings(event) {
  event.preventDefault();
  status.className = "status";
  status.textContent = "Checking settings…";
  try {
    const settings = formSettings();
    const permission = permissionPatternForOrigin(settings.allowedOrigin);
    const granted = await chrome.permissions.request({ origins: [permission] });
    if (!granted) throw new Error("Tenant access was not granted.");
    await reconcileOriginPermissions(settings.allowedOrigin);
    await chrome.storage.local.set({ settings });
    status.className = "status success";
    status.textContent = "Settings saved. Open an XSOAR incident and use the extension button.";
    updatePreview();
  } catch (error) {
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

byId("export-settings").addEventListener("click", async () => {
  try {
    const settings = formSettings();
    const blob = new Blob([`${JSON.stringify(settings, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "xsoar-incident-assistant-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  } catch (error) {
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

byId("import-settings").addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) return;
  try {
    const settings = resolveSettings(JSON.parse(await file.text()));
    populate(settings);
    status.className = "status";
    status.textContent = "Settings imported. Select Save to grant tenant access and keep them.";
  } catch (error) {
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    event.target.value = "";
  }
});

form.addEventListener("submit", saveSettings);
form.addEventListener("input", updatePreview);
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).then(populate);
