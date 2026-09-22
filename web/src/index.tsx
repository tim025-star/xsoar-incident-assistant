import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

import { rpc, sessionToken } from "./rpc";
import "./styles.css";

type AppConfig = Awaited<ReturnType<typeof rpc.config.get>>;
type Status = Awaited<ReturnType<typeof rpc.status>>;
type LocalAiStatus = Awaited<ReturnType<typeof rpc.localAi.status>>;
type LayaStatus = Awaited<ReturnType<typeof rpc.layaMapper.status>>;
type LayaExample = Awaited<ReturnType<typeof rpc.layaMapper.examples.list>>[number];
type LayaDiagnostic = Awaited<ReturnType<typeof rpc.layaMapper.diagnostics>>;
type TextSetting = "allowedOrigin" | "incidentUrlPattern" | "incidentPathTemplate" | "incidentsPath" | "searchQueryParameter";
type NumberSetting = "maxHistoricalIncidents" | "pageReadyTimeoutMs";
type TemplateSetting = keyof AppConfig["xsoar"]["template"];
type FieldLabelSetting = keyof AppConfig["xsoar"]["fieldLabels"];

const FIELD_MAPPINGS: Array<{ key: FieldLabelSetting; name: string; use: string }> = [
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
  const [layaExamples, setLayaExamples] = createSignal<LayaExample[]>([]);
  const [inspectedExample, setInspectedExample] = createSignal<unknown>();
  const [trainingJson, setTrainingJson] = createSignal("");
  const [trainingOutputs, setTrainingOutputs] = createSignal("");
  const [trainingPointers, setTrainingPointers] = createSignal("");
  const [bundlePath, setBundlePath] = createSignal("");
  const [checkpointPath, setCheckpointPath] = createSignal("");
  const [trainingBackend, setTrainingBackend] = createSignal<"auto" | "cpu" | "cuda">("auto");
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
    const [nextStatus, examples] = await Promise.all([rpc.layaMapper.status(), rpc.layaMapper.examples.list()]);
    setLayaStatus(nextStatus);
    setLayaExamples(examples);
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
  const updateLayaMapper = (key: "enabled" | "checkpointId", value: boolean | string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      if (key === "enabled") next.layaMapper.enabled = Boolean(value);
      else next.layaMapper.checkpointId = String(value);
      return next;
    });
  };
  const addTrainingExample = async () => {
    const raw = JSON.parse(trainingJson());
    const outputs = JSON.parse(trainingOutputs() || "{}");
    const pointers = JSON.parse(trainingPointers() || "{}");
    const labels: Record<string, { state: "mapped" | "absent"; value?: string; pointer?: string }> = Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [key, value === null
        ? { state: "absent" as const }
        : { state: "mapped" as const, value: String(value), ...(pointers[key] ? { pointer: String(pointers[key]) } : {}) }])
    );
    await rpc.layaMapper.examples.add({ documents: [raw], labels });
    setTrainingJson("");
    setTrainingOutputs("");
    setTrainingPointers("");
    await refreshLaya();
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
  const exportTrainingExamples = async () => {
    const { jsonl } = await rpc.layaMapper.examples.export();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    link.download = "laya-mapper-training.jsonl";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const importTrainingExamples = async (file: File) => {
    const lines = (await file.text()).split(/\r?\n/).filter(Boolean);
    for (const jsonl of lines) setLayaExamples(await rpc.layaMapper.examples.import({ jsonl }));
    await refreshLaya();
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
          <p class="helper mb-0 mt-2">Maps arbitrary local alert JSON to canonical response fields before deterministic template generation and optional Qwen post-processing.</p>
        </div>
        <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-slate-50 p-4">
          <input id="layaMapperEnabled" class="mt-1 h-4 w-4" type="checkbox" checked={settings().layaMapper.enabled} onChange={(event) => {
            updateLayaMapper("enabled", event.currentTarget.checked);
            void runAction(persistLayaSettings);
          }} />
          <span><span class="block font-bold">Enable Laya-mapper</span><span class="helper mt-1 block">Processes raw alert JSON through the fully local mapper. The base checkpoint is general-purpose and its output must be reviewed.</span></span>
        </label>
        <label class="field mt-4">Active checkpoint
          <select id="layaCheckpoint" class="control" value={settings().layaMapper.checkpointId} onChange={(event) => runAction(async () => {
            updateLayaMapper("checkpointId", event.currentTarget.value);
            const layaMapper = await rpc.layaMapper.checkpoints.activate({ id: event.currentTarget.value });
            setConfig((latest) => latest ? { ...latest, layaMapper } : latest);
          })}>
            <option value="base-multilingual">Base multilingual checkpoint</option>
            <For each={layaStatus()?.training.checkpoints || []}>{(checkpoint) => <option value={checkpoint.id}>{checkpoint.id}</option>}</For>
          </select>
        </label>
        <div class="mt-3 flex flex-wrap gap-2.5">
          <button id="installLayaMapper" class="button button-secondary" type="button" disabled={busy()} onClick={() => runAction(async () => { await rpc.layaMapper.install(); await refreshLaya(); })}>Install Laya-mapper</button>
          <button id="refreshLayaMapper" class="button button-secondary" type="button" disabled={busy()} onClick={() => runAction(refreshLaya)}>Check Laya-mapper</button>
        </div>
        <p id="layaMapperStatus" class="helper mb-0 mt-4" aria-live="polite">{layaStatus()?.detail || "Check Laya-mapper status."}</p>

        <details class="mt-5 border-t border-line pt-4" open>
          <summary class="cursor-pointer font-bold">Test Laya-mapper without XSOAR</summary>
          <p class="helper">Paste fictional or approved alert JSON. This runs the active production checkpoint locally and shows its selected values, exact JSON pointers, rankings, and warnings. The test is not saved as training data.</p>
          <label class="field">Test alert JSON
            <textarea id="layaTestJson" class="control min-h-64 font-mono text-xs" value={mapperTestJson()} onInput={(event) => { setMapperTestJson(event.currentTarget.value); setMapperTestResult(undefined); }} />
          </label>
          <fieldset class="mt-4" disabled={busy()}>
            <legend class="field mb-2">Canonical fields to map</legend>
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <For each={FIELD_MAPPINGS}>{(mapping) => (
                <label class="flex items-center gap-2 text-sm">
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
              <progress class="mt-3 w-full">Working</progress>
              <p class="helper mb-0 mt-2">CPU inference can take several minutes for large alerts or many selected fields. The current stage updates as each model comparison completes.</p>
            </div>
          </Show>
          <Show when={mapperTestResult()}>{(result) => (
            <div id="layaTestResult" class="mt-4 grid gap-3">
              <Show when={result().warning}><p class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm" role="alert">{result().warning}</p></Show>
              <Show when={Object.entries(result().fields).length} fallback={<p class="helper">The mapper did not select a valid value for the requested fields.</p>}>
                <div class="overflow-auto rounded-xl border border-line">
                  <table class="w-full text-left text-sm">
                    <thead class="bg-slate-50"><tr><th class="p-3">Canonical field</th><th class="p-3">Selected value</th><th class="p-3">Exact JSON pointer</th></tr></thead>
                    <tbody><For each={Object.entries(result().fields)}>{([field, value]) => <tr class="border-t border-line"><td class="p-3 font-bold">{field}</td><td class="p-3">{String(value)}</td><td class="p-3 font-mono text-xs">{result().paths[field] || ""}</td></tr>}</For></tbody>
                  </table>
                </div>
              </Show>
              <details><summary class="cursor-pointer text-sm font-bold">Full model diagnostics and provenance</summary><pre class="control mt-2 max-h-96 overflow-auto text-xs">{JSON.stringify(result(), null, 2)}</pre></details>
            </div>
          )}</Show>
        </details>

        <details class="mt-5 border-t border-line pt-4">
          <summary class="cursor-pointer font-bold">Fine-tuning dataset and checkpoints</summary>
          <p class="helper">Training data remains local. Add the raw alert JSON and a JSON object of manually confirmed canonical values. Use <code>null</code> to mark a field explicitly absent; omit unlabelled fields.</p>
          <div class="grid gap-4 lg:grid-cols-2">
            <label class="field">Raw alert JSON
              <textarea id="layaTrainingJson" class="control min-h-48 font-mono text-xs" value={trainingJson()} onInput={(event) => setTrainingJson(event.currentTarget.value)} placeholder={'{"records":{"opaque":"value"}}'} />
            </label>
            <label class="field">Confirmed canonical outputs
              <textarea id="layaTrainingOutputs" class="control min-h-48 font-mono text-xs" value={trainingOutputs()} onInput={(event) => setTrainingOutputs(event.currentTarget.value)} placeholder={'{"sourceIp":"203.0.113.4","destinationIp":null}'} />
            </label>
          </div>
          <label class="field mt-4">Confirmed pointers for duplicate values (optional)
            <textarea id="layaTrainingPointers" class="control min-h-24 font-mono text-xs" value={trainingPointers()} onInput={(event) => setTrainingPointers(event.currentTarget.value)} placeholder={'{"sourceIp":"/documents/0/network/source/address"}'} />
            <span class="helper">If a confirmed value occurs more than once, enter the exact JSON pointer reported by the validation message.</span>
          </label>
          <div class="mt-3 flex flex-wrap gap-2.5">
            <button id="addLayaExample" class="button button-secondary" type="button" disabled={busy() || !trainingJson().trim()} onClick={() => runAction(addTrainingExample)}>Add labeled alert</button>
            <button class="button button-secondary" type="button" disabled={busy() || !layaExamples().length} onClick={() => runAction(exportTrainingExamples)}>Export JSONL</button>
            <label class="button button-secondary cursor-pointer">Import JSONL<input class="sr-only" type="file" accept=".jsonl,application/x-ndjson,text/plain" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void runAction(() => importTrainingExamples(file)); }} /></label>
            <button class="button button-secondary" type="button" disabled={busy() || !layaExamples().length} onClick={() => runAction(async () => { setLayaExamples(await rpc.layaMapper.examples.clear()); await refreshLaya(); })}>Delete all examples</button>
          </div>
          <p class="helper">Stored examples: {layaExamples().length}. Fine-tuning requires at least {layaStatus()?.training.minimumExamples || 50} labeled alerts.</p>
          <Show when={layaExamples().length}>
            <div class="max-h-48 overflow-auto rounded-xl border border-line">
              <For each={layaExamples()}>{(example) => <div class="flex items-center justify-between gap-3 border-b border-line p-3 text-sm last:border-b-0"><span class="font-mono">{example.id}</span><span class="flex gap-2"><button class="button button-secondary" type="button" onClick={() => runAction(async () => setInspectedExample(await rpc.layaMapper.examples.get({ id: example.id })))}>Inspect</button><button class="button button-secondary" type="button" onClick={() => runAction(async () => { setLayaExamples(await rpc.layaMapper.examples.remove({ id: example.id })); setInspectedExample(undefined); await refreshLaya(); })}>Remove</button></span></div>}</For>
            </div>
          </Show>
          <Show when={inspectedExample()}><pre id="layaInspectedExample" class="control mt-3 max-h-64 overflow-auto text-xs">{JSON.stringify(inspectedExample(), null, 2)}</pre></Show>
          <div class="mt-4 flex flex-wrap gap-2.5">
            <select id="layaTrainingBackend" class="control max-w-xs" value={trainingBackend()} onChange={(event) => setTrainingBackend(event.currentTarget.value as "auto" | "cpu" | "cuda")}>
              <option value="auto">Training backend: automatic</option>
              <option value="cuda">Training backend: NVIDIA CUDA</option>
              <option value="cpu">Training backend: CPU (extremely slow)</option>
            </select>
            <button class="button button-secondary" type="button" disabled={busy() || layaStatus()?.training.trainerInstalled} onClick={() => runAction(async () => { await rpc.layaMapper.training.install({ backend: trainingBackend() }); await refreshLaya(); })}>Install fine-tuning tools</button>
            <button id="startLayaTraining" class="button" type="button" disabled={busy() || Boolean(layaStatus()?.training.running) || layaExamples().length < 50} onClick={() => runAction(async () => { await rpc.layaMapper.training.start({ device: "auto" }); await refreshLaya(); })}>Start fine-tuning</button>
            <Show when={layaStatus()?.training.lastRun && ["cancelled", "failed"].includes(layaStatus()?.training.lastRun?.status || "")}><button class="button button-secondary" type="button" disabled={busy() || Boolean(layaStatus()?.training.running)} onClick={() => runAction(async () => { await rpc.layaMapper.training.start({ device: "auto", resumeRunId: layaStatus()?.training.lastRun?.id }); await refreshLaya(); })}>Resume last run</button></Show>
            <Show when={layaStatus()?.training.running}><button class="button button-secondary" type="button" onClick={() => runAction(async () => { await rpc.layaMapper.training.cancel(); await refreshLaya(); })}>Cancel training</button></Show>
          </div>
          <Show when={layaStatus()?.training.run}><p class="helper" role="status">{layaStatus()?.training.run?.detail} ({Math.round(layaStatus()?.training.run?.progress || 0)}%)</p></Show>
          <Show when={layaStatus()?.training.trainingBackend}><p class="helper">Installed training backend: {layaStatus()?.training.trainingBackend?.toUpperCase()}.</p></Show>
          <Show when={layaStatus()?.training.lastRun}><pre class="control overflow-auto text-xs">{JSON.stringify(layaStatus()?.training.lastRun, null, 2)}</pre></Show>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <label class="field">Offline training bundle destination<input class="control" value={bundlePath()} onInput={(event) => setBundlePath(event.currentTarget.value)} placeholder="C:\ApprovedTraining\laya-bundle" /></label>
            <label class="field">Checkpoint directory to import<input class="control" value={checkpointPath()} onInput={(event) => setCheckpointPath(event.currentTarget.value)} placeholder="C:\ApprovedTraining\checkpoint" /></label>
          </div>
          <div class="mt-3 flex flex-wrap gap-2.5">
            <button class="button button-secondary" type="button" disabled={busy() || !bundlePath().trim()} onClick={() => runAction(() => rpc.layaMapper.training.exportBundle({ destinationDirectory: bundlePath().trim() }))}>Export offline training bundle</button>
            <button class="button button-secondary" type="button" disabled={busy() || !checkpointPath().trim()} onClick={() => runAction(async () => { await rpc.layaMapper.checkpoints.import({ sourceDirectory: checkpointPath().trim() }); await refreshLaya(); })}>Import checkpoint</button>
            <button class="button button-secondary" type="button" disabled={busy() || settings().layaMapper.checkpointId === "base-multilingual" || !checkpointPath().trim()} onClick={() => runAction(() => rpc.layaMapper.checkpoints.export({ id: settings().layaMapper.checkpointId, destinationDirectory: checkpointPath().trim() }))}>Export active checkpoint</button>
            <button class="button button-secondary" type="button" disabled={busy() || settings().layaMapper.checkpointId === "base-multilingual"} onClick={() => runAction(async () => {
              const id = settings().layaMapper.checkpointId;
              const layaMapper = await rpc.layaMapper.checkpoints.activate({ id: "base-multilingual" });
              setConfig((latest) => latest ? { ...latest, layaMapper } : latest);
              await rpc.layaMapper.checkpoints.remove({ id });
              await refreshLaya();
            })}>Rollback to base and delete active checkpoint</button>
          </div>
        </details>
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
