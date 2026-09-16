import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

import { rpc, sessionToken } from "./rpc";
import "./styles.css";

type AppConfig = Awaited<ReturnType<typeof rpc.config.get>>;
type Status = Awaited<ReturnType<typeof rpc.status>>;
type LocalAiStatus = Awaited<ReturnType<typeof rpc.localAi.status>>;
type TextSetting = "allowedOrigin" | "incidentUrlPattern" | "incidentPathTemplate" | "incidentsPath" | "searchQueryParameter" | "lookbackQuery";
type NumberSetting = "maxHistoricalIncidents" | "pageReadyTimeoutMs";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [config, setConfig] = createSignal<AppConfig>();
  const [status, setStatus] = createSignal<Status>();
  const [localAiStatus, setLocalAiStatus] = createSignal<LocalAiStatus>();
  const [pullingModel, setPullingModel] = createSignal(false);
  const [incidentId, setIncidentId] = createSignal("");
  const [acknowledgedDraftVersion, setAcknowledgedDraftVersion] = createSignal<number>();
  const [message, setMessage] = createSignal(sessionToken
    ? "Loading local status…"
    : "Start the assistant again to open an authorised local control page.");
  const [busy, setBusy] = createSignal(false);
  const modelDownloadRunning = () => pullingModel() || status()?.operation === "model download";

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

  const updateTemplate = (key: "analystName" | "analystTitle", value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.xsoar.template[key] = value;
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
    if (!next.aiDraft || next.draftVersion !== acknowledgedDraftVersion()) setAcknowledgedDraftVersion(undefined);
    setStatus(next);
    setMessage(next.detail);
  };
  const refreshLocalAi = async () => setLocalAiStatus(await rpc.localAi.status());

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("Working…");
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

  const openSession = () => runAction(async () => {
    await persistSettings();
    await rpc.browser.open();
  });

  const generateDraft = () => runAction(async () => {
    setAcknowledgedDraftVersion(undefined);
    if (!status()?.session.running) await persistSettings();
    else await persistLocalAiSettings();
    await rpc.draft.generate({ incidentId: incidentId().trim() });
  });
  const pullSelectedModel = async () => {
    const current = config();
    if (!current) return;
    setPullingModel(true);
    setMessage(current.localAi.model === "qwen3.5:9b"
      ? "Installing the default local model from GitHub…"
      : `Downloading ${current.localAi.model} from the Ollama registry…`);
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
      setMessage("Cancelling local model download…");
    } catch (error) { setMessage(errorMessage(error)); }
  };

  const copyDraft = async () => {
    const draft = status()?.draft || "";
    if (!draft) return setMessage("Generate a draft before copying it.");
    if (status()?.aiDraft && acknowledgedDraftVersion() !== status()?.draftVersion) {
      return setMessage("Review the local-AI draft and confirm the acknowledgement before copying it.");
    }
    try {
      await navigator.clipboard.writeText(draft);
      setMessage("Draft copied.");
    } catch (error) {
      setMessage(`Could not copy the draft: ${errorMessage(error)}`);
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
    const interval = window.setInterval(() => refresh().catch(() => {}), 1500);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <main class="mx-auto w-[min(1120px,calc(100%-2rem))] py-8 sm:py-12">
      <header class="mb-7 grid gap-5 border-b border-line pb-7 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p class="mb-2 text-xs font-bold tracking-[0.18em] text-brand">LOCAL PLAYWRIGHT TOOL</p>
          <h1 class="m-0 text-3xl font-bold tracking-tight sm:text-5xl">XSOAR Incident Assistant</h1>
          <p class="helper mt-3 max-w-3xl">Prepare a response draft from an incident in your existing Chrome window.</p>
        </div>
        <div class="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-2 text-sm font-semibold">
          <span class={`h-2.5 w-2.5 rounded-full ${status()?.session.running ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" />
          {status()?.session.running ? "Chrome connected" : "Chrome disconnected"}
        </div>
      </header>

      <Show when={config()} fallback={<section class="panel"><p id="status" class="helper m-0" role="status">{message()}</p></section>}>
        {(settings) => (
          <div class="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div class="grid content-start gap-5">
              <section class="panel">
                <div class="mb-5">
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">01 · Chrome</p>
                  <h2 class="m-0 text-xl font-bold">Connect your browser</h2>
                </div>
                <div class="rounded-xl border border-line bg-slate-50 p-4">
                  <p class="mb-2 font-bold">Chrome setup</p>
                  <p class="helper my-0">Chrome 144 or newer is required. Enable remote debugging and accept Chrome's connection prompt. This approval must be repeated after Chrome restarts.</p>
                  <button id="setup" class="button button-secondary mt-4" type="button" disabled={busy()} onClick={() => runAction(() => rpc.browser.setup())}>Open Chrome setup</button>
                </div>
                <p class="helper mb-0">The assistant connects to the Chrome window you already use. It does not launch or copy a separate browser profile.</p>
              </section>

              <section class="panel">
                <fieldset class="contents" disabled={busy() || status()?.session.running}>
                <div class="mb-5">
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">02 · Tenant</p>
                  <h2 class="m-0 text-xl font-bold">XSOAR settings</h2>
                </div>
                <label class="field">Tenant origin
                  <input id="allowedOrigin" class="control" type="url" placeholder="https://xsoar.example.com" autocomplete="off" value={settings().xsoar.allowedOrigin} onInput={(event) => updateTextSetting("allowedOrigin", event.currentTarget.value)} />
                </label>
                <div class="mt-4 grid gap-4 sm:grid-cols-2">
                  <label class="field">Analyst name
                    <input id="analystName" class="control" autocomplete="name" placeholder="Your name" value={settings().xsoar.template.analystName} onInput={(event) => updateTemplate("analystName", event.currentTarget.value)} />
                  </label>
                  <label class="field">Analyst title
                    <input id="analystTitle" class="control" placeholder="Security Analyst" value={settings().xsoar.template.analystTitle} onInput={(event) => updateTemplate("analystTitle", event.currentTarget.value)} />
                  </label>
                </div>
                <details class="mt-5 border-t border-line pt-4">
                  <summary class="cursor-pointer font-bold">Advanced query settings</summary>
                  <div class="mt-4 grid gap-4">
                    <label class="field">Incident URL pattern
                      <input id="incidentUrlPattern" class="control font-mono text-sm" value={settings().xsoar.incidentUrlPattern} onInput={(event) => updateTextSetting("incidentUrlPattern", event.currentTarget.value)} />
                    </label>
                    <label class="field">Incident path template
                      <input id="incidentPathTemplate" class="control font-mono text-sm" value={settings().xsoar.incidentPathTemplate} onInput={(event) => updateTextSetting("incidentPathTemplate", event.currentTarget.value)} />
                      <span class="helper">Use <code>{"{id}"}</code> where the numeric Incident ID belongs.</span>
                    </label>
                    <div class="grid gap-4 sm:grid-cols-2">
                      <label class="field">Incidents path
                        <input id="incidentsPath" class="control" value={settings().xsoar.incidentsPath} onInput={(event) => updateTextSetting("incidentsPath", event.currentTarget.value)} />
                      </label>
                      <label class="field">Query parameter
                        <input id="searchQueryParameter" class="control" value={settings().xsoar.searchQueryParameter} onInput={(event) => updateTextSetting("searchQueryParameter", event.currentTarget.value)} />
                      </label>
                    </div>
                    <label class="field">Historical lookback query
                      <input id="lookbackQuery" class="control" value={settings().xsoar.lookbackQuery} onInput={(event) => updateTextSetting("lookbackQuery", event.currentTarget.value)} />
                    </label>
                    <div class="grid gap-4 sm:grid-cols-2">
                      <label class="field">Maximum history
                        <input id="maxHistoricalIncidents" class="control" type="number" min="1" max="20" value={settings().xsoar.maxHistoricalIncidents} onInput={(event) => updateNumberSetting("maxHistoricalIncidents", event.currentTarget.valueAsNumber)} />
                      </label>
                      <label class="field">Page timeout (ms)
                        <input id="pageReadyTimeoutMs" class="control" type="number" min="1000" max="120000" value={settings().xsoar.pageReadyTimeoutMs} onInput={(event) => updateNumberSetting("pageReadyTimeoutMs", event.currentTarget.valueAsNumber)} />
                      </label>
                    </div>
                  </div>
                </details>
                <button id="save" class="button button-secondary mt-5" type="button" onClick={() => runAction(persistSettings)}>Save settings</button>
                </fieldset>
              </section>

              <section class="panel">
                <fieldset class="contents" disabled={busy() || modelDownloadRunning()}>
                <div class="mb-5">
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">03 · Optional local AI</p>
                  <h2 class="m-0 text-xl font-bold">Ollama draft enrichment</h2>
                </div>
                <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-slate-50 p-4">
                  <input id="localAiEnabled" class="mt-1 h-4 w-4" type="checkbox" checked={settings().localAi.enabled} onChange={(event) => {
                    updateLocalAi("enabled", event.currentTarget.checked);
                    void runAction(persistLocalAiSettings);
                  }} />
                  <span><span class="block font-bold">Use local AI for this draft</span><span class="helper mt-1 block">Optional. Incident content is sent only to Ollama running on this computer after you enable this setting.</span></span>
                </label>
                <label class="field mt-4">Local Ollama model
                  <input id="localAiModel" class="control font-mono text-sm" list="localAiModels" autocomplete="off" value={settings().localAi.model} onInput={(event) => updateLocalAi("model", event.currentTarget.value)} />
                  <datalist id="localAiModels"><option value="qwen3.5:9b" />{localAiStatus()?.models.map((model) => <option value={model} />)}</datalist>
                </label>
                </fieldset>
                <div class="mt-3 flex flex-wrap items-center gap-2.5">
                  <button id="pullModel" class="button button-secondary" type="button" disabled={busy() || modelDownloadRunning()} onClick={pullSelectedModel}>{settings().localAi.model === "qwen3.5:9b" ? "Install default from GitHub" : "Download from Ollama registry"}</button>
                  <Show when={modelDownloadRunning()}><button id="cancelPull" class="button button-secondary" type="button" onClick={cancelModelPull}>Cancel download</button></Show>
                  <button id="refreshLocalAi" class="button button-secondary" type="button" disabled={busy() || modelDownloadRunning()} onClick={() => runAction(refreshLocalAi)}>Refresh local AI status</button>
                </div>
                <p id="localAiStatus" class="helper mb-0 mt-4" aria-live="polite">{localAiStatus()?.detail || "Check whether local Ollama is available."}</p>
                <p class="helper mb-0">The default <code>qwen3.5:9b</code> installer downloads verified Ollama and model assets from GitHub. Other model names use the Ollama registry, which may be blocked on some networks. A model must be installed locally before it can receive incident data. If local AI is unavailable, the deterministic draft is still generated.</p>
              </section>
            </div>

            <section class="panel self-start lg:sticky lg:top-6">
              <div class="mb-5">
                <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">04 · Workflow</p>
                <h2 class="m-0 text-xl font-bold">Run assistant</h2>
              </div>
              <div class="rounded-xl border border-line bg-slate-50 p-4">
                <p class="mb-1 text-xs font-bold uppercase tracking-wider text-muted">Current status</p>
                <p id="status" class="m-0 leading-6" role="status" aria-live="polite">{message()}</p>
              </div>
              <label class="field mt-5">Incident ID <span class="font-normal text-muted">(optional)</span>
                <input id="incidentId" class="control" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="32" autocomplete="off" placeholder="For example, 4200" value={incidentId()} onInput={(event) => setIncidentId(event.currentTarget.value)} />
                <span class="helper">Enter an ID to open that exact incident. Leave blank to automatically use the only open incident tab; if several are open, enter the intended ID.</span>
              </label>
              <div class="my-5 flex flex-wrap gap-2.5">
                <button id="open" class="button" type="button" disabled={busy() || status()?.session.running} onClick={openSession}>Connect Chrome</button>
                <button id="run" class="button" type="button" disabled={busy()} onClick={generateDraft}>Generate draft</button>
                <button id="stop" class="button button-secondary" type="button" disabled={busy() || !status()?.session.running} onClick={() => runAction(() => rpc.browser.stop())}>Disconnect</button>
              </div>
              <p class="helper mt-0">The assistant scans the connected Chrome window for incident tabs. An incident opened from an ID and all other temporary child tabs are closed automatically.</p>
              <label class="field">Draft
                <textarea id="draft" class="control min-h-96 resize-y font-mono text-sm leading-6" rows="18" readOnly placeholder="The generated draft appears here." value={status()?.draft || ""} />
              </label>
              <Show when={status()?.aiDraft}>
                <label class="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
                  <input id="aiDraftAcknowledgement" class="mt-1 h-4 w-4" type="checkbox" checked={acknowledgedDraftVersion() === status()?.draftVersion} onChange={(event) => setAcknowledgedDraftVersion(event.currentTarget.checked ? status()?.draftVersion : undefined)} />
                  <span><span class="block font-bold">I reviewed this local-AI-enriched draft.</span><span class="helper mt-1 block">Confirm its accuracy and suitability before copying it into XSOAR or another system.</span></span>
                </label>
              </Show>
              <button id="copy" class="button button-secondary mt-4" type="button" disabled={busy() || !status()?.draft || (status()?.aiDraft && acknowledgedDraftVersion() !== status()?.draftVersion)} onClick={copyDraft}>Copy draft</button>
            </section>
          </div>
        )}
      </Show>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
