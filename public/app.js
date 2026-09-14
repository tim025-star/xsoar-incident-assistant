const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const byId = (id) => document.getElementById(id);
let loadedConfig;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Assistant-Token": token, ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function updateMode() {
  document.body.classList.toggle("debug-mode", byId("mode").value === "cdp");
}

function populate(config) {
  loadedConfig = config;
  byId("mode").value = config.session.mode;
  byId("browser").value = config.session.browser;
  byId("profileDirectory").value = config.session.profileDirectory;
  for (const key of ["allowedOrigin", "incidentUrlPattern", "incidentsPath", "searchQueryParameter", "lookbackQuery", "maxHistoricalIncidents", "pageReadyTimeoutMs"]) byId(key).value = config.xsoar[key];
  byId("analystName").value = config.xsoar.template.analystName;
  byId("analystTitle").value = config.xsoar.template.analystTitle;
  updateMode();
}

function collect() {
  return {
    configVersion: 3,
    session: { mode: byId("mode").value, browser: byId("browser").value, profileDirectory: byId("profileDirectory").value },
    xsoar: {
      ...loadedConfig.xsoar,
      allowedOrigin: byId("allowedOrigin").value,
      incidentUrlPattern: byId("incidentUrlPattern").value,
      incidentsPath: byId("incidentsPath").value,
      searchQueryParameter: byId("searchQueryParameter").value,
      lookbackQuery: byId("lookbackQuery").value,
      maxHistoricalIncidents: Number(byId("maxHistoricalIncidents").value),
      pageReadyTimeoutMs: Number(byId("pageReadyTimeoutMs").value),
      template: { ...loadedConfig.xsoar.template, analystName: byId("analystName").value, analystTitle: byId("analystTitle").value }
    }
  };
}

async function action(path, body) {
  byId("status").textContent = "Working…";
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify(body || {}) });
    if (result.draft) byId("draft").value = result.draft;
    await refresh();
  } catch (error) {
    byId("status").textContent = error.message;
  }
}

async function refresh() {
  const state = await api("/api/status");
  byId("status").textContent = state.detail;
  if (state.draft) byId("draft").value = state.draft;
}

byId("mode").addEventListener("change", updateMode);
byId("save").addEventListener("click", async () => { try { populate(await api("/api/config", { method: "POST", body: JSON.stringify(collect()) })); byId("status").textContent = "Settings saved."; } catch (error) { byId("status").textContent = error.message; } });
byId("launchDebug").addEventListener("click", () => action("/api/debug/launch"));
byId("open").addEventListener("click", () => action("/api/browser/open"));
byId("run").addEventListener("click", () => action("/api/run"));
byId("stop").addEventListener("click", () => action("/api/browser/stop"));
byId("copy").addEventListener("click", async () => { await navigator.clipboard.writeText(byId("draft").value); byId("status").textContent = "Draft copied."; });

if (!token) byId("status").textContent = "Start the assistant again to open an authorised local control page.";
else Promise.all([api("/api/config"), refresh()]).then(([config]) => populate(config)).catch((error) => { byId("status").textContent = error.message; });
setInterval(() => { if (token) refresh().catch(() => {}); }, 1500);
