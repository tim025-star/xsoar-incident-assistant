import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

import { rpc, sessionToken } from "./rpc";
import { LAYA_TARGET_CATALOGUE } from "../../src/laya-targets.js";
import "./styles.css";

type AppConfig = Awaited<ReturnType<typeof rpc.config.get>>;
type Status = Awaited<ReturnType<typeof rpc.status>>;
type LocalAiStatus = Awaited<ReturnType<typeof rpc.localAi.status>>;
type LayaStatus = Awaited<ReturnType<typeof rpc.layaMapper.status>>;
type LayaDiagnostic = Awaited<ReturnType<typeof rpc.layaMapper.diagnostics>>;
type TextSetting = "allowedOrigin" | "incidentUrlPattern" | "incidentPathTemplate" | "incidentsPath" | "searchQueryParameter";
type NumberSetting = "maxHistoricalIncidents" | "pageReadyTimeoutMs";
type TemplateSetting = keyof AppConfig["xsoar"]["template"];
type FieldLabelSetting = keyof AppConfig["xsoar"]["fieldLabels"];

const FIELD_MAPPINGS: Array<{ key: FieldLabelSetting & keyof typeof LAYA_TARGET_CATALOGUE; name: string; use: string }> = [
  { key: "customerName", name: "Customer name", use: "customer.name → greeting and historic match" },
  { key: "occurred", name: "Time stamp", use: "@timestamp → event breakdown" },
  { key: "sourceUsername", name: "Source user", use: "source.user.name → user and source" },
  { key: "clientUserName", name: "Client user", use: "client.user.name → fallback user" },
  { key: "sourceIp", name: "Source IP", use: "source.ip → source" },
  { key: "clientIp", name: "Client IP", use: "client.ip → fallback source" },
  { key: "destinationIp", name: "Destination IP", use: "destination.ip → destination" },
  { key: "clientHostname", name: "Client hostname", use: "client.hostname → client hostname" },
  { key: "deviceHostname", name: "Device hostname", use: "host.name → affected device" },
  { key: "sourceHostname", name: "Source hostname", use: "source.hostname → fallback device" },
  { key: "eventName", name: "Event name", use: "event.name → event detail" },
  { key: "detectionUrl", name: "Detection URL", use: "event.url → event record URL" },
  { key: "serviceMessage", name: "Service message", use: "message → error / service message" },
  { key: "eventInfo", name: "Event info", use: "event.original → fallback message" },
  { key: "errorMessage", name: "Error message", use: "error.message → fallback message" },
  { key: "ruleName", name: "Rule name", use: "rule.name → alert context and historic match" },
  { key: "caseType", name: "Case type", use: "event.category → alert context and historic match" },
  { key: "classification", name: "Classification", use: "classification → recorded classification" },
  { key: "incidentOutcome", name: "Incident outcome", use: "event.outcome → factual AI context" },
  { key: "closeNotes", name: "Close notes", use: "close.notes → factual AI context" },
  { key: "descriptionLong", name: "Long description", use: "event.description → factual AI context" }
];

const DEFAULT_MAPPER_TEST_TARGETS: FieldLabelSetting[] = ["sourceIp"];
const DEFAULT_MAPPER_TEST_JSON = JSON.stringify({
  alertEnvelope: {
    tenantDisplay: "Example Test Customer",
    policyTitle: "Impossible travel sign-in",
    categoryText: "Identity alert",
    actor: { principal: "alex.taylor@example.test", endpoint: "TEST-LAPTOP-17" },
    network: { peer: "203.0.113.8", target: "198.51.100.22" },
    observedAt: "2026-09-22T05:30:00Z"
  }
}, null, 2);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function splitLabels(value: string) {
  return value.split(/[\n,]/).map((label) => label.trim()).filter(Boolean);
}

function App() {
  let draftElement: HTMLTextAreaElement | undefined;
  let mapperTestTimer: number | undefined;
  let previousResponse = "";
  let followLiveOutput = true;
  const configurationPage = location.pathname === "/configuration";
  const [config, setConfig] = createSignal<AppConfig>();
  const [status, setStatus] = createSignal<Status>();
  const [localAiStatus, setLocalAiStatus] = createSignal<LocalAiStatus>();
  const [layaStatus, setLayaStatus] = createSignal<LayaStatus>();
  const [mapperTestJson, setMapperTestJson] = createSignal(DEFAULT_MAPPER_TEST_JSON);
  const [mapperTestTargets, setMapperTestTargets] = createSignal<FieldLabelSetting[]>(DEFAULT_MAPPER_TEST_TARGETS);
  const [mapperTestResult, setMapperTestResult] = createSignal<LayaDiagnostic>();
  const [mapperTestRunning, setMapperTestRunning] = createSignal(false);
  const [mapperTestElapsedSeconds, setMapperTestElapsedSeconds] = createSignal(0);
  const [pullingModel, setPullingModel] = createSignal(false);
  const [incidentId, setIncidentId] = createSignal("");
  const [message, setMessage] = createSignal(sessionToken
    ? "Loading console status…"
    : "Restart the app to open a valid local console.");
  const [busy, setBusy] = createSignal(false);
  const modelDownloadRunning = () => pullingModel() || status()?.operation === "model download";
  const layaCheckpoint = () => layaStatus()?.checkpoint;
  const layaProgress = () => status()?.layaProgress;
  const tenantMissing = () => !config()?.xsoar.allowedOrigin.trim();
  const chromeSetupRequired = () => /remote debugging|valid browser endpoint|could not connect to chrome/i.test(message());
  const processedResponse = () => {
    const current = status();
    if (current?.draft) return current.draft;
    return current?.aiOutput ? `Local AI processing (live)\n${current.aiOutput}` : "";
  };
  const updateLiveOutputFollow = () => {
    if (!draftElement || status()?.draft) return;
    const distanceFromBottom = draftElement.scrollHeight - draftElement.clientHeight - draftElement.scrollTop;
    followLiveOutput = distanceFromBottom <= 8;
  };

  createEffect(() => {
    const response = processedResponse();
    const finalDraft = Boolean(status()?.draft);
    if (response === previousResponse) return;
    const shouldFollow = followLiveOutput;
    previousResponse = response;
    queueMicrotask(() => {
      if (!draftElement) return;
      if (finalDraft) {
        draftElement.scrollTop = 0;
        followLiveOutput = false;
      } else if (shouldFollow) {
        draftElement.scrollTop = draftElement.scrollHeight;
        followLiveOutput = true;
      }
    });
  });

  const updateTextSetting = (key: TextSetting, value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.xsoar[key] = value;
      return next;
    });
  };
  const updateNumberSetting = (key: NumberSetting, value: number) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.xsoar[key] = value;
      return next;
    });
  };
  const updateTemplate = (key: TemplateSetting, value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.xsoar.template[key] = value;
      return next;
    });
  };
  const updateFieldLabels = (key: FieldLabelSetting, value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.xsoar.fieldLabels[key] = splitLabels(value);
      return next;
    });
  };
  const updateHistoricalRecommendationLabels = (value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.xsoar.historicalRecommendationLabels = splitLabels(value);
      return next;
    });
  };
  const updateLocalAi = (key: "enabled" | "model", value: boolean | string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      if (key === "enabled") next.localAi.enabled = Boolean(value);
      else next.localAi.model = String(value);
      return next;
    });
  };

  const refresh = async () => {
    const next = await rpc.status();
    setStatus(next);
    setMessage(next.detail);
  };
  const refreshLocalAi = async () => setLocalAiStatus(await rpc.localAi.status());
  const refreshLaya = async () => {
    setLayaStatus(await rpc.layaMapper.status());
  };
  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("Running…");
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const persistSettings = async () => {
    const current = config();
    if (!current) return;
    try {
      setConfig(await rpc.config.save(current));
    } catch (error) {
      const persisted = await rpc.config.get().catch(() => undefined);
      if (persisted) setConfig(persisted);
      throw error;
    }
  };
  const persistLocalAiSettings = async () => {
    const current = config();
    if (!current) return;
    try {
      const localAi = await rpc.config.saveLocalAi(current.localAi);
      setConfig((latest) => latest ? { ...latest, localAi } : latest);
    } catch (error) {
      const persisted = await rpc.config.get().catch(() => undefined);
      if (persisted) setConfig(persisted);
      throw error;
    }
  };
  const persistLayaSettings = async () => {
    const current = config();
    if (!current) return;
    const layaMapper = await rpc.config.saveLayaMapper(current.layaMapper);
    setConfig((latest) => latest ? { ...latest, layaMapper } : latest);
  };
  const updateLayaMapper = (key: "workerMode" | "workerCount", value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      if (key === "workerMode") next.layaMapper.workerMode = value as "auto" | "manual";
      else next.layaMapper.workerCount = Number(value);
      return next;
    });
  };
  const toggleMapperTestTarget = (target: FieldLabelSetting, checked: boolean) => {
    setMapperTestTargets((current) => checked
      ? [...new Set([...current, target])]
      : current.filter((item) => item !== target));
  };
  const runMapperTest = async () => {
    const parsed = JSON.parse(mapperTestJson());
    const documents = Array.isArray(parsed) ? parsed : [parsed];
    const startedAt = Date.now();
    setMapperTestResult(undefined);
    setMapperTestElapsedSeconds(0);
    setMapperTestRunning(true);
    window.clearInterval(mapperTestTimer);
    mapperTestTimer = window.setInterval(() => setMapperTestElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    try {
      setMapperTestResult(await rpc.layaMapper.diagnostics({ documents, targets: mapperTestTargets() }));
    } finally {
      window.clearInterval(mapperTestTimer);
      mapperTestTimer = undefined;
      setMapperTestRunning(false);
    }
  };
  const cancelMapperTest = async () => {
    try { await rpc.layaMapper.cancelDiagnostic(); }
    catch (error) { setMessage(errorMessage(error)); }
  };

  const generateDraft = () => runAction(async () => {
    followLiveOutput = true;
    await rpc.draft.generate({ incidentId: incidentId().trim() });
  });
  const pullSelectedModel = async () => {
    const current = config();
    if (!current) return;
    setPullingModel(true);
    setMessage(current.localAi.model === "qwen3.5:9b"
      ? "Installing the default model from GitHub…"
      : `Pulling ${current.localAi.model} from the Ollama registry…`);
    try {
      await persistLocalAiSettings();
      await rpc.localAi.pull({ model: current.localAi.model });
      await Promise.all([refreshLocalAi(), refresh()]);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPullingModel(false);
    }
  };
  const cancelModelPull = async () => {
    try {
      await rpc.localAi.cancelPull();
      setMessage("Stopping the model download…");
    } catch (error) { setMessage(errorMessage(error)); }
  };
  const copyDraft = async () => {
    const draft = status()?.draft || "";
    if (!draft) return setMessage("Process incident data before copying it.");
    try {
      await navigator.clipboard.writeText(draft);
      setMessage("Processed incident data copied.");
    } catch (error) {
      setMessage(`Could not copy the processed incident data: ${errorMessage(error)}`);
    }
  };

  onMount(async () => {
    if (!sessionToken) return;
    try {
      const [loadedConfig, loadedStatus] = await Promise.all([rpc.config.get(), rpc.status()]);
      setConfig(loadedConfig);
      setStatus(loadedStatus);
      setMessage(loadedStatus.detail);
    } catch (error) {
      setMessage(errorMessage(error));
    }
    refreshLocalAi().catch((error) => setLocalAiStatus({ available: false, models: [], detail: errorMessage(error) }));
    refreshLaya().catch((error) => setMessage(errorMessage(error)));
    const interval = window.setInterval(() => refresh().catch(() => {}), 500);
    const layaInterval = configurationPage
      ? window.setInterval(() => refreshLaya().catch(() => {}), 2000)
      : undefined;
    onCleanup(() => {
      window.clearInterval(interval);
      window.clearInterval(mapperTestTimer);
      if (layaInterval !== undefined) window.clearInterval(layaInterval);
    });
  });

  const Header = () => (
    <header class="mb-7 grid gap-5 border-b border-line pb-7 md:grid-cols-[1fr_auto] md:items-end">
      <div>
        <p class="mb-2 text-xs font-bold tracking-[0.18em] text-brand">LOCAL SOC WORKFLOW</p>
        <h1 class="m-0 text-3xl font-bold tracking-tight sm:text-5xl">XSOAR Incident Assistant</h1>
        <p class="helper mt-3 max-w-3xl">Pull an XSOAR incident, extract important fields, and format the source data for analyst review.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <nav class="flex rounded-xl border border-line bg-white p-1 text-sm font-bold" aria-label="Main navigation">
          <a class={`nav-link ${!configurationPage ? "nav-link-active" : ""}`} href="/">Home</a>
          <a class={`nav-link ${configurationPage ? "nav-link-active" : ""}`} href="/configuration">Configuration</a>
        </nav>
        <div class="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-2 text-sm font-semibold">
          <span class={`h-2.5 w-2.5 rounded-full ${status()?.session.running ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" />
          {status()?.session.running ? "Chrome connected" : "Chrome disconnected"}
        </div>
      </div>
    </header>
  );

  const HomePage = ({ settings }: { settings: () => AppConfig }) => (
    <div class="mx-auto grid max-w-4xl gap-5">
      <Show when={tenantMissing()}>
        <section class="rounded-2xl border border-amber-300 bg-amber-50 p-5" role="alert">
          <h2 class="m-0 text-lg font-bold">Configuration needed</h2>
          <p class="helper mb-4 mt-2">Add the XSOAR tenant and confirm the field mappings before processing incident data.</p>
          <a class="button" href="/configuration">Open configuration</a>
        </section>
      </Show>
      <Show when={chromeSetupRequired()}>
        <section class="rounded-2xl border border-amber-300 bg-amber-50 p-5" role="alert">
          <h2 class="m-0 text-lg font-bold">Chrome access needs attention</h2>
          <p class="helper mb-4 mt-2">Chrome did not expose its approved debugging session. Open the access page, enable remote debugging, approve the prompt, then connect again.</p>
          <button id="setup" class="button button-secondary" type="button" disabled={busy()} onClick={() => runAction(() => rpc.browser.setup())}>Open Chrome access setup</button>
        </section>
      </Show>
      <section class="panel">
        <div class="mb-5">
          <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">Incident workflow</p>
          <h2 class="m-0 text-2xl font-bold">Process incident data</h2>
          <p class="helper mb-0 mt-2">Connect your existing Chrome session, open the intended XSOAR incident, then extract and format its source fields.</p>
        </div>
        <div class="rounded-xl border border-line bg-slate-50 p-4">
          <p class="mb-1 text-xs font-bold uppercase tracking-wider text-muted">Run status</p>
          <p id="status" class="m-0 leading-6" role="status" aria-live="polite">{message()}</p>
        </div>
        <div class="my-5 flex flex-wrap gap-2.5">
          <button id="open" class="button" type="button" disabled={busy() || status()?.session.running || tenantMissing()} onClick={() => runAction(() => rpc.browser.open())}>Connect Chrome</button>
          <button id="run" class="button" type="button" disabled={busy() || tenantMissing()} onClick={generateDraft}>Process data</button>
          <button id="stop" class="button button-secondary" type="button" disabled={busy() || !status()?.session.running} onClick={() => runAction(() => rpc.browser.stop())}>Disconnect</button>
        </div>
        <details class="mb-5 border-t border-line pt-4">
          <summary class="cursor-pointer font-bold">Target a specific incident</summary>
          <label class="field mt-4">XSOAR Incident ID <span class="font-normal text-muted">(optional)</span>
            <input id="incidentId" class="control" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="32" autocomplete="off" placeholder="For example, 4200" value={incidentId()} onInput={(event) => setIncidentId(event.currentTarget.value)} />
            <span class="helper">Leave blank to use the only open incident tab. Enter an ID when several incidents are open.</span>
          </label>
        </details>
        <label class="field">Processed incident data
          <textarea ref={draftElement} id="draft" class="control min-h-96 resize-y font-mono text-sm leading-6" rows="18" readOnly placeholder="Processed source fields appear here." value={processedResponse()} onScroll={updateLiveOutputFollow} />
          <span class="helper">The model extracts facts from the selected alert only. In parallel, the app searches three months of matching XSOAR history and appends past resolutions under Historic.</span>
          <Show when={status()?.processingMode}><span id="processingMode" class="helper">Processing used: {status()?.processingMode}.</span></Show>
        </label>
        <button id="copy" class="button button-secondary mt-4" type="button" disabled={busy() || !status()?.draft} onClick={copyDraft}>Copy processed data</button>
      </section>
    </div>
  );

  const ConfigurationPage = ({ settings }: { settings: () => AppConfig }) => (
    <div class="grid gap-5">
      <section class="panel">
        <div class="mb-5">
          <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">XSOAR connection</p>
          <h2 class="m-0 text-xl font-bold">Tenant and response identity</h2>
        </div>
        <fieldset class="contents" disabled={busy() || status()?.session.running}>
          <label class="field">XSOAR tenant URL
            <input id="allowedOrigin" class="control" type="url" placeholder="https://xsoar.example.com" autocomplete="off" value={settings().xsoar.allowedOrigin} onInput={(event) => updateTextSetting("allowedOrigin", event.currentTarget.value)} />
          </label>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <label class="field">Analyst display name
              <input id="analystName" class="control" autocomplete="name" placeholder="Your name" value={settings().xsoar.template.analystName} onInput={(event) => updateTemplate("analystName", event.currentTarget.value)} />
            </label>
            <label class="field">Role or title
              <input id="analystTitle" class="control" placeholder="Security Analyst" value={settings().xsoar.template.analystTitle} onInput={(event) => updateTemplate("analystTitle", event.currentTarget.value)} />
            </label>
          </div>
          <details class="mt-5 border-t border-line pt-4">
            <summary class="cursor-pointer font-bold">Advanced XSOAR routing</summary>
            <div class="mt-4 grid gap-4">
              <label class="field">Incident route regex
                <input id="incidentUrlPattern" class="control font-mono text-sm" value={settings().xsoar.incidentUrlPattern} onInput={(event) => updateTextSetting("incidentUrlPattern", event.currentTarget.value)} />
              </label>
              <label class="field">Incident URL template
                <input id="incidentPathTemplate" class="control font-mono text-sm" value={settings().xsoar.incidentPathTemplate} onInput={(event) => updateTextSetting("incidentPathTemplate", event.currentTarget.value)} />
                <span class="helper">End the path with <code>{"/{id}"}</code>; the Incident ID must be the final path segment.</span>
              </label>
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="field">Incident list path
                  <input id="incidentsPath" class="control" value={settings().xsoar.incidentsPath} onInput={(event) => updateTextSetting("incidentsPath", event.currentTarget.value)} />
                </label>
                <label class="field">Search parameter
                  <input id="searchQueryParameter" class="control" value={settings().xsoar.searchQueryParameter} onInput={(event) => updateTextSetting("searchQueryParameter", event.currentTarget.value)} />
                </label>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="field">Historic resolutions to include
                  <input id="maxHistoricalIncidents" class="control" type="number" min="1" max="20" value={settings().xsoar.maxHistoricalIncidents} onInput={(event) => updateNumberSetting("maxHistoricalIncidents", event.currentTarget.valueAsNumber)} />
                  <span class="helper">Searches the previous three months for the same client, rule, and alert type.</span>
                </label>
                <label class="field">Page load timeout (ms)
                  <input id="pageReadyTimeoutMs" class="control" type="number" min="1000" max="120000" value={settings().xsoar.pageReadyTimeoutMs} onInput={(event) => updateNumberSetting("pageReadyTimeoutMs", event.currentTarget.valueAsNumber)} />
                </label>
              </div>
            </div>
          </details>
        </fieldset>
      </section>

      <section class="panel">
        <div class="mb-5">
          <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">Optional semantic mapping</p>
          <h2 class="m-0 text-xl font-bold">Laya-mapper</h2>
          <p class="helper mb-0 mt-2">A reviewed, coverage-first tuned model for mapping local JSON fields. Normal incident processing remains deterministic.</p>
        </div>
        <p id="layaModelIdentity" class="helper">
          Reviewed demo checkpoint · <code>{layaCheckpoint()?.id || "expanded-training-cuda-632-alerts-v1"}</code>
          {layaCheckpoint() ? <> · weights <code>{layaCheckpoint()!.weightsSha256.slice(0, 12)}…</code> · {layaCheckpoint()!.trainingSequences.toLocaleString()} training sequences · {(layaCheckpoint()!.sequenceAccuracy * 100).toFixed(2)}% teacher-forced sequence score</> : ""}.
          CPU inference; diagnostics only and never applied automatically. The sequence score is not production mapping accuracy.
        </p>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <label class="field">Worker mode
            <select id="layaWorkerMode" class="control" disabled={busy()} value={settings().layaMapper.workerMode} onChange={(event) => { updateLayaMapper("workerMode", event.currentTarget.value); void runAction(persistLayaSettings); }}>
              <option value="auto">Automatic</option><option value="manual">Manual</option>
            </select>
          </label>
          <Show when={settings().layaMapper.workerMode === "manual"}><label class="field">Workers
            <select id="layaWorkerCount" class="control" disabled={busy()} value={settings().layaMapper.workerCount} onChange={(event) => { updateLayaMapper("workerCount", event.currentTarget.value); void runAction(persistLayaSettings); }}>
              <For each={[1, 2, 3, 4]}>{(count) => <option value={count}>{count}</option>}</For>
            </select>
          </label></Show>
        </div>
        <div class="mt-3 flex flex-wrap gap-2.5">
          <button id="installLayaMapper" class="button button-secondary" type="button" disabled={busy()} onClick={() => runAction(async () => { await rpc.layaMapper.install(); await refreshLaya(); })}>Install Laya-mapper</button>
          <button id="refreshLayaMapper" class="button button-secondary" type="button" disabled={busy()} onClick={() => runAction(refreshLaya)}>Check Laya-mapper</button>
        </div>
        <p id="layaMapperStatus" class="helper mb-0 mt-4" aria-live="polite">{layaStatus()?.detail || "Check Laya-mapper status."}</p>

        <details class="mt-5 border-t border-line pt-4" open>
          <summary class="cursor-pointer font-bold">Test Laya-mapper without XSOAR</summary>
          <p class="helper">Paste fictional or approved alert JSON. This runs the reviewed tuned demo checkpoint locally with exact typed-value grouping. Repeated values retain every source pointer and alias assessment in provenance; one assessed representative continues into the distinct-value comparison. Every eligible field reaches final assessment. Pasted alerts and results are not saved automatically. Model scores are not calibrated probabilities of correctness.</p>
          <label class="field">Test alert JSON
            <textarea id="layaTestJson" class="control min-h-64 font-mono text-xs" value={mapperTestJson()} onInput={(event) => { setMapperTestJson(event.currentTarget.value); setMapperTestResult(undefined); }} />
          </label>
          <fieldset class="mt-4" disabled={busy()}>
            <legend class="field mb-2">Canonical fields to map</legend>
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <For each={FIELD_MAPPINGS}>{(mapping) => (
                <label class="flex items-center gap-2 text-sm" title={LAYA_TARGET_CATALOGUE[mapping.key].description}>
                  <input type="checkbox" checked={mapperTestTargets().includes(mapping.key)} onChange={(event) => toggleMapperTestTarget(mapping.key, event.currentTarget.checked)} />
                  {mapping.name}
                </label>
              )}</For>
            </div>
          </fieldset>
          <div class="mt-4 flex flex-wrap gap-2.5">
            <button id="runLayaTest" class="button" type="button" disabled={busy() || !mapperTestJson().trim() || !mapperTestTargets().length || !layaStatus()?.available} onClick={() => runAction(runMapperTest)}>Run local mapper test</button>
            <Show when={mapperTestRunning()}><button id="cancelLayaTest" class="button button-secondary" type="button" onClick={cancelMapperTest}>Cancel test</button></Show>
            <button class="button button-secondary" type="button" disabled={busy()} onClick={() => { setMapperTestJson(DEFAULT_MAPPER_TEST_JSON); setMapperTestTargets(DEFAULT_MAPPER_TEST_TARGETS); setMapperTestResult(undefined); }}>Reset fictional example</button>
          </div>
          <Show when={mapperTestRunning()}>
            <div id="layaTestProgress" class="mt-4 rounded-xl border border-brand/30 bg-blue-50 p-4" role="status" aria-live="polite">
              <div class="flex items-center justify-between gap-3 text-sm"><span>{message()}</span><span class="shrink-0 font-mono">{mapperTestElapsedSeconds()}s elapsed</span></div>
              <div class="mt-2 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wide text-muted"><span id="layaProgressStage">{layaProgress()?.stage.replaceAll("_", " ") || "working"}</span><span>{layaProgress()?.total ? `${layaProgress()!.completed}/${layaProgress()!.total}` : ""}</span></div>
              <progress class="mt-2 w-full" max={Math.max(1, layaProgress()?.total || 1)} value={layaProgress()?.total ? layaProgress()!.completed : 0}>Working</progress>
              <p class="helper mb-0 mt-2">CPU inference can take several minutes for large alerts or many selected fields. The current stage updates as each model comparison completes.</p>
            </div>
          </Show>
          <Show when={mapperTestResult()}>{(result) => (
            <div id="layaTestResult" class="mt-4 grid gap-3">
              <Show when={result().warning}><p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm" role="alert">{result().warning}</p></Show>
              <p class="helper">Checkpoint: <code>{result().checkpoint?.id || "unknown"}</code> · Workers: {result().runtime?.effectiveWorkers ?? 0} · Fields: {result().leaves} · Source complete: {String(result().sourceComplete)} · Model processing complete: {String(result().processingComplete)} · {result().timings.totalMs} ms</p>
              <div class="overflow-auto rounded-xl border border-line">
                <table class="w-full text-left text-sm">
                  <thead class="bg-slate-50"><tr><th class="p-3">Canonical field</th><th class="p-3">Status</th><th class="p-3">Value / best guess</th><th class="p-3">Exact pointer and alternatives</th></tr></thead>
                  <tbody><For each={Object.entries(result().statuses)}>{([field, status]) => <tr class="border-t border-line">
                    <td class="p-3 font-bold">{field}</td><td class="p-3">{String(status)}</td><td class="p-3"><span>{String(result().fields[field] ?? "—")}</span><div class="mt-1 text-xs text-muted">Value agreement: {result().provenance[field].agreement?.value || "not recorded"}</div></td>
                    <td class="p-3 font-mono text-xs">{result().paths[field] || "—"}<Show when={status === "tentative"}><div class="mt-2 text-amber-800">Alternatives: {[...new Set([...(result().provenance[field].nominees || []), ...(result().provenance[field].pointerNominees || [])])].map((id: string) => result().provenance[field].candidates.find((candidate: { id: string }) => candidate.id === id)?.pointer || "none").join(" / ")}</div></Show></td>
                  </tr>}</For></tbody>
                </table>
              </div>
              <details><summary class="cursor-pointer text-sm font-bold">Full model diagnostics and provenance</summary><pre class="control mt-2 max-h-96 overflow-auto text-xs">{JSON.stringify(result(), null, 2)}</pre></details>
            </div>
          )}</Show>
        </details>

        <p class="helper mt-4">This checkpoint is released for reviewed demonstrations and feedback, not automatic incident updates. Training remains an optional separate product and is not installed or run by this application.</p>
      </section>

      <section class="panel">
        <div class="mb-5">
          <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">JSON ingestion</p>
          <h2 class="m-0 text-xl font-bold">JSON log mapping</h2>
          <p class="helper mb-0 mt-2">Map important output fields to JSON keys or dotted paths from XSOAR logs. For example, <code>source.ip</code>, <code>events.actor.user_name</code>, or <code>message</code>. Separate alternatives with commas. Existing XSOAR field labels remain valid fallbacks.</p>
        </div>
        <fieldset class="contents" disabled={busy() || status()?.session.running}>
          <div class="grid gap-3 md:grid-cols-2">
            <For each={FIELD_MAPPINGS}>{(mapping) => (
              <label class="field rounded-xl border border-line bg-slate-50 p-4">
                <span>{mapping.name}</span>
                <span class="text-xs font-normal text-muted">JSON example / output use: {mapping.use}</span>
                <input id={`fieldLabel-${mapping.key}`} class="control mt-1 font-mono text-sm" aria-label={`${mapping.name} JSON keys or paths`} value={settings().xsoar.fieldLabels[mapping.key].join(", ")} onInput={(event) => updateFieldLabels(mapping.key, event.currentTarget.value)} />
              </label>
            )}</For>
            <label class="field rounded-xl border border-line bg-slate-50 p-4">
              <span>Historic resolution data</span>
              <span class="text-xs font-normal text-muted">JSON paths or XSOAR labels that describe how matching incidents were resolved</span>
              <input id="historicalRecommendationLabels" class="control mt-1 font-mono text-sm" placeholder="resolution.summary, close.notes" value={settings().xsoar.historicalRecommendationLabels.join(", ")} onInput={(event) => updateHistoricalRecommendationLabels(event.currentTarget.value)} />
            </label>
          </div>
          <p class="helper mt-4">JSON objects are flattened into dotted paths. Array indexes are ignored, so <code>events[0].actor.user_name</code> can be mapped as <code>events.actor.user_name</code>. When several values match, the first available source value is used.</p>
          <details class="mt-5 border-t border-line pt-4">
            <summary class="cursor-pointer font-bold">Output wording</summary>
            <div class="mt-4 grid gap-4 sm:grid-cols-2">
              <label class="field">Greeting<input class="control" value={settings().xsoar.template.greeting} onInput={(event) => updateTemplate("greeting", event.currentTarget.value)} /></label>
              <label class="field sm:col-span-2">Contact text<textarea class="control min-h-24" value={settings().xsoar.template.contactText} onInput={(event) => updateTemplate("contactText", event.currentTarget.value)} /></label>
              <label class="field">Sign-off<input class="control" value={settings().xsoar.template.signOff} onInput={(event) => updateTemplate("signOff", event.currentTarget.value)} /></label>
            </div>
          </details>
          <button id="saveMappings" class="button mt-5" type="button" onClick={() => runAction(persistSettings)}>Save configuration</button>
        </fieldset>
      </section>

      <section class="panel">
        <fieldset class="contents" disabled={busy() || modelDownloadRunning()}>
          <div class="mb-5">
            <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">Optional field processing</p>
            <h2 class="m-0 text-xl font-bold">Local AI</h2>
          </div>
          <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-slate-50 p-4">
            <input id="localAiEnabled" class="mt-1 h-4 w-4" type="checkbox" checked={settings().localAi.enabled} onChange={(event) => {
              updateLocalAi("enabled", event.currentTarget.checked);
              void runAction(persistLocalAiSettings);
            }} />
            <span><span class="block font-bold">Enable local AI field processing</span><span class="helper mt-1 block">Sends allowlisted fields from the selected alert to Ollama on this workstation for factual extraction only.</span></span>
          </label>
          <label class="field mt-4">Local model
            <input id="localAiModel" class="control font-mono text-sm" list="localAiModels" autocomplete="off" value={settings().localAi.model} onInput={(event) => updateLocalAi("model", event.currentTarget.value)} />
            <datalist id="localAiModels">{localAiStatus()?.models.map((model) => <option value={model} />)}</datalist>
          </label>
        </fieldset>
        <div class="mt-3 flex flex-wrap items-center gap-2.5">
          <button id="pullModel" class="button button-secondary" type="button" disabled={busy() || modelDownloadRunning()} onClick={pullSelectedModel}>{settings().localAi.model === "qwen3.5:9b" ? "Install default model" : "Pull selected model"}</button>
          <Show when={modelDownloadRunning()}><button id="cancelPull" class="button button-secondary" type="button" onClick={cancelModelPull}>Stop download</button></Show>
          <button id="refreshLocalAi" class="button button-secondary" type="button" disabled={busy() || modelDownloadRunning()} onClick={() => runAction(refreshLocalAi)}>Check Ollama</button>
        </div>
        <p id="localAiStatus" class="helper mb-0 mt-4" aria-live="polite">{localAiStatus()?.detail || "Check Ollama status."}</p>
      </section>
      <div class="rounded-xl border border-line bg-white p-4">
        <p id="status" class="helper m-0" role="status" aria-live="polite">{message()}</p>
      </div>
    </div>
  );

  return (
    <main class="mx-auto w-[min(1120px,calc(100%-2rem))] py-8 sm:py-12">
      <Header />
      <Show when={config()} fallback={<section class="panel"><p id="status" class="helper m-0" role="status">{message()}</p></section>}>
        {(settings) => configurationPage ? <ConfigurationPage {...{ settings }} /> : <HomePage {...{ settings }} />}
      </Show>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
