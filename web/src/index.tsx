import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
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
  let draftElement: HTMLTextAreaElement | undefined;
  const [config, setConfig] = createSignal<AppConfig>();
  const [status, setStatus] = createSignal<Status>();
  const [localAiStatus, setLocalAiStatus] = createSignal<LocalAiStatus>();
  const [pullingModel, setPullingModel] = createSignal(false);
  const [incidentId, setIncidentId] = createSignal("");
  const [acknowledgedDraftVersion, setAcknowledgedDraftVersion] = createSignal<number>();
  const [message, setMessage] = createSignal(sessionToken
    ? "Loading console status…"
    : "Restart the app to open a valid local console.");
  const [busy, setBusy] = createSignal(false);
  const modelDownloadRunning = () => pullingModel() || status()?.operation === "model download";
  const analystResponse = () => {
    const current = status();
    if (current?.draft) return current.draft;
    return current?.aiOutput ? `Local AI analysis (live)\n${current.aiOutput}` : "";
  };

  createEffect(() => {
    analystResponse();
    queueMicrotask(() => {
      if (draftElement) draftElement.scrollTop = status()?.draft ? 0 : draftElement.scrollHeight;
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
    if (!draft) return setMessage("Build an analyst response before copying it.");
    if (status()?.aiDraft && acknowledgedDraftVersion() !== status()?.draftVersion) {
      return setMessage("Review and confirm the AI-assisted response before copying it.");
    }
    try {
      await navigator.clipboard.writeText(draft);
      setMessage("Analyst response copied.");
    } catch (error) {
      setMessage(`Could not copy the analyst response: ${errorMessage(error)}`);
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
    const interval = window.setInterval(() => refresh().catch(() => {}), 500);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <main class="mx-auto w-[min(1120px,calc(100%-2rem))] py-8 sm:py-12">
      <header class="mb-7 grid gap-5 border-b border-line pb-7 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p class="mb-2 text-xs font-bold tracking-[0.18em] text-brand">LOCAL SOC WORKFLOW</p>
          <h1 class="m-0 text-3xl font-bold tracking-tight sm:text-5xl">XSOAR Incident Assistant</h1>
          <p class="helper mt-3 max-w-3xl">Pull an XSOAR incident, check related cases, and build an analyst-ready response.</p>
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
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">01 · Chrome session</p>
                  <h2 class="m-0 text-xl font-bold">Connect analyst Chrome</h2>
                </div>
                <div class="rounded-xl border border-line bg-slate-50 p-4">
                  <p class="mb-2 font-bold">Chrome access</p>
                  <p class="helper my-0">Chrome 144 or newer is required. Enable remote debugging and approve Chrome's prompt. Re-approve it after Chrome restarts.</p>
                  <button id="setup" class="button button-secondary mt-4" type="button" disabled={busy()} onClick={() => runAction(() => rpc.browser.setup())}>Open Chrome access setup</button>
                </div>
                <p class="helper mb-0">Uses your signed-in Chrome session. The app does not create or copy a browser profile.</p>
              </section>

              <section class="panel">
                <fieldset class="contents" disabled={busy() || status()?.session.running}>
                <div class="mb-5">
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">02 · XSOAR</p>
                  <h2 class="m-0 text-xl font-bold">Tenant and analyst config</h2>
                </div>
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
                    <label class="field">Related-case lookback
                      <input id="lookbackQuery" class="control" value={settings().xsoar.lookbackQuery} onInput={(event) => updateTextSetting("lookbackQuery", event.currentTarget.value)} />
                    </label>
                    <div class="grid gap-4 sm:grid-cols-2">
                      <label class="field">Related cases to review
                        <input id="maxHistoricalIncidents" class="control" type="number" min="1" max="20" value={settings().xsoar.maxHistoricalIncidents} onInput={(event) => updateNumberSetting("maxHistoricalIncidents", event.currentTarget.valueAsNumber)} />
                      </label>
                      <label class="field">Page load timeout (ms)
                        <input id="pageReadyTimeoutMs" class="control" type="number" min="1000" max="120000" value={settings().xsoar.pageReadyTimeoutMs} onInput={(event) => updateNumberSetting("pageReadyTimeoutMs", event.currentTarget.valueAsNumber)} />
                      </label>
                    </div>
                  </div>
                </details>
                <button id="save" class="button button-secondary mt-5" type="button" onClick={() => runAction(persistSettings)}>Save XSOAR config</button>
                </fieldset>
              </section>

              <section class="panel">
                <fieldset class="contents" disabled={busy() || modelDownloadRunning()}>
                <div class="mb-5">
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">03 · Local AI</p>
                  <h2 class="m-0 text-xl font-bold">AI-assisted analysis</h2>
                </div>
                <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-slate-50 p-4">
                  <input id="localAiEnabled" class="mt-1 h-4 w-4" type="checkbox" checked={settings().localAi.enabled} onChange={(event) => {
                    updateLocalAi("enabled", event.currentTarget.checked);
                    void runAction(persistLocalAiSettings);
                  }} />
                  <span><span class="block font-bold">Enable local AI analysis</span><span class="helper mt-1 block">Sends allowlisted fields from the original incident to Ollama on this workstation. Related tickets never go to the model.</span></span>
                </label>
                <label class="field mt-4">Local model
                  <input id="localAiModel" class="control font-mono text-sm" list="localAiModels" autocomplete="off" value={settings().localAi.model} onInput={(event) => updateLocalAi("model", event.currentTarget.value)} />
                  <datalist id="localAiModels"><option value="qwen3.5:9b" />{localAiStatus()?.models.map((model) => <option value={model} />)}</datalist>
                </label>
                </fieldset>
                <div class="mt-3 flex flex-wrap items-center gap-2.5">
                  <button id="pullModel" class="button button-secondary" type="button" disabled={busy() || modelDownloadRunning()} onClick={pullSelectedModel}>{settings().localAi.model === "qwen3.5:9b" ? "Install default model" : "Pull selected model"}</button>
                  <Show when={modelDownloadRunning()}><button id="cancelPull" class="button button-secondary" type="button" onClick={cancelModelPull}>Stop download</button></Show>
                  <button id="refreshLocalAi" class="button button-secondary" type="button" disabled={busy() || modelDownloadRunning()} onClick={() => runAction(refreshLocalAi)}>Check Ollama</button>
                </div>
                <p id="localAiStatus" class="helper mb-0 mt-4" aria-live="polite">{localAiStatus()?.detail || "Check Ollama status."}</p>
                <p class="helper mb-0"><code>qwen3.5:9b</code> is the default CPU model. Its verified runner and model files come from GitHub. Custom models use the Ollama registry. If AI analysis fails, the rules-based response still runs.</p>
              </section>
            </div>

            <section class="panel self-start lg:sticky lg:top-6">
              <div class="mb-5">
                <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">04 · Triage</p>
                <h2 class="m-0 text-xl font-bold">Build analyst response</h2>
              </div>
              <div class="rounded-xl border border-line bg-slate-50 p-4">
                <p class="mb-1 text-xs font-bold uppercase tracking-wider text-muted">Run status</p>
                <p id="status" class="m-0 leading-6" role="status" aria-live="polite">{message()}</p>
              </div>
              <label class="field mt-5">XSOAR Incident ID <span class="font-normal text-muted">(optional)</span>
                <input id="incidentId" class="control" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="32" autocomplete="off" placeholder="For example, 4200" value={incidentId()} onInput={(event) => setIncidentId(event.currentTarget.value)} />
                <span class="helper">Paste the target ID. Leave it blank when exactly one incident tab is open. If several are open, enter the ID to avoid triaging the wrong case.</span>
              </label>
              <div class="my-5 flex flex-wrap gap-2.5">
                <button id="open" class="button" type="button" disabled={busy() || status()?.session.running} onClick={openSession}>Connect Chrome</button>
                <button id="run" class="button" type="button" disabled={busy()} onClick={generateDraft}>Build response</button>
                <button id="stop" class="button button-secondary" type="button" disabled={busy() || !status()?.session.running} onClick={() => runAction(() => rpc.browser.stop())}>Disconnect</button>
              </div>
              <p class="helper mt-0">Blank ID: uses the only open incident tab. Entered ID: opens that incident directly. The app closes its temporary tabs after evidence collection.</p>
              <label class="field">Analyst response
                <textarea ref={draftElement} id="draft" class="control min-h-96 resize-y font-mono text-sm leading-6" rows="18" readOnly placeholder="The analyst-ready response appears here." value={analystResponse()} />
                <span class="helper">During Local AI analysis, generated output streams here. The final response replaces it only after the output passes schema validation. Related ticket resolutions are appended afterward by the app.</span>
              </label>
              <Show when={status()?.aiDraft}>
                <label class="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
                  <input id="aiDraftAcknowledgement" class="mt-1 h-4 w-4" type="checkbox" checked={acknowledgedDraftVersion() === status()?.draftVersion} onChange={(event) => setAcknowledgedDraftVersion(event.currentTarget.checked ? status()?.draftVersion : undefined)} />
                  <span><span class="block font-bold">I reviewed the AI-assisted response.</span><span class="helper mt-1 block">Validate the evidence, scope, and recommended actions before copying it into XSOAR.</span></span>
                </label>
              </Show>
              <button id="copy" class="button button-secondary mt-4" type="button" disabled={busy() || !status()?.draft || (status()?.aiDraft && acknowledgedDraftVersion() !== status()?.draftVersion)} onClick={copyDraft}>Copy response</button>
            </section>
          </div>
        )}
      </Show>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
