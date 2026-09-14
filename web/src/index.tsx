import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

import { rpc, sessionToken } from "./rpc";
import "./styles.css";

type AppConfig = Awaited<ReturnType<typeof rpc.config.get>>;
type Status = Awaited<ReturnType<typeof rpc.status>>;
type TextSetting = "allowedOrigin" | "incidentUrlPattern" | "incidentsPath" | "searchQueryParameter" | "lookbackQuery";
type NumberSetting = "maxHistoricalIncidents" | "pageReadyTimeoutMs";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [config, setConfig] = createSignal<AppConfig>();
  const [status, setStatus] = createSignal<Status>();
  const [message, setMessage] = createSignal(sessionToken
    ? "Loading local status…"
    : "Start the assistant again to open an authorised local control page.");
  const [busy, setBusy] = createSignal(false);

  const updateMode = (value: string) => {
    if (value !== "managed" && value !== "diagnostics") return;
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.session.mode = value;
      return next;
    });
  };

  const updateBrowser = (value: string) => {
    if (value !== "edge" && value !== "chrome") return;
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.session.browser = value;
      return next;
    });
  };

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

  const refresh = async () => {
    const next = await rpc.status();
    setStatus(next);
    setMessage(next.detail);
  };

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

  const save = () => runAction(async () => {
    const current = config();
    if (!current) return;
    setConfig(await rpc.config.save(current));
  });

  const copyDraft = async () => {
    const draft = status()?.draft || "";
    if (!draft) return setMessage("Generate a draft before copying it.");
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
    const interval = window.setInterval(() => refresh().catch(() => {}), 1500);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <main class="mx-auto w-[min(1120px,calc(100%-2rem))] py-8 sm:py-12">
      <header class="mb-7 grid gap-5 border-b border-line pb-7 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p class="mb-2 text-xs font-bold tracking-[0.18em] text-brand">LOCAL PLAYWRIGHT TOOL</p>
          <h1 class="m-0 text-3xl font-bold tracking-tight sm:text-5xl">XSOAR Incident Assistant</h1>
          <p class="helper mt-3 max-w-3xl">Prepare a response draft from the incident currently open in the assistant browser.</p>
        </div>
        <div class="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-2 text-sm font-semibold">
          <span class={`h-2.5 w-2.5 rounded-full ${status()?.session.running ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" />
          {status()?.session.running ? "Browser connected" : "Browser closed"}
        </div>
      </header>

      <Show when={config()} fallback={<section class="panel"><p id="status" class="helper m-0" role="status">{message()}</p></section>}>
        {(settings) => (
          <div class="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div class="grid content-start gap-5">
              <section class="panel">
                <div class="mb-5">
                  <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">01 · Browser</p>
                  <h2 class="m-0 text-xl font-bold">Session</h2>
                </div>
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="field">Browser mode
                    <select id="mode" class="control" value={settings().session.mode} onInput={(event) => updateMode(event.currentTarget.value)}>
                      <option value="managed">Managed profile (recommended)</option>
                      <option value="diagnostics">Diagnostics with DevTools</option>
                    </select>
                  </label>
                  <label class="field">Browser
                    <select id="browser" class="control" value={settings().session.browser} onInput={(event) => updateBrowser(event.currentTarget.value)}>
                      <option value="edge">Microsoft Edge</option>
                      <option value="chrome">Google Chrome</option>
                    </select>
                  </label>
                </div>
                <label class="field mt-4">Dedicated profile directory
                  <input id="profileDirectory" class="control bg-slate-50 text-slate-600" value={settings().session.profileDirectory} readOnly />
                </label>
                <p class="helper mb-0">Diagnostics mode opens Chromium DevTools in the Playwright-owned browser. It does not expose a remote-debugging network port.</p>
                <p class="helper mb-0">The dedicated profile retains browser session data between runs, while your identity-provider policy controls reauthentication. Your everyday browser profile is never copied or reused.</p>
              </section>

              <section class="panel">
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
                <button id="save" class="button button-secondary mt-5" type="button" disabled={busy()} onClick={save}>Save settings</button>
              </section>
            </div>

            <section class="panel self-start lg:sticky lg:top-6">
              <div class="mb-5">
                <p class="mb-1 text-xs font-bold uppercase tracking-wider text-brand">03 · Workflow</p>
                <h2 class="m-0 text-xl font-bold">Run assistant</h2>
              </div>
              <div class="rounded-xl border border-line bg-slate-50 p-4">
                <p class="mb-1 text-xs font-bold uppercase tracking-wider text-muted">Current status</p>
                <p id="status" class="m-0 leading-6" role="status" aria-live="polite">{message()}</p>
              </div>
              <div class="my-5 flex flex-wrap gap-2.5">
                <button id="open" class="button" type="button" disabled={busy()} onClick={() => runAction(() => rpc.browser.open())}>Open browser</button>
                <button id="run" class="button" type="button" disabled={busy()} onClick={() => runAction(() => rpc.draft.generate())}>Generate draft</button>
                <button id="stop" class="button button-secondary" type="button" disabled={busy()} onClick={() => runAction(() => rpc.browser.stop())}>Close browser</button>
              </div>
              <p class="helper mt-0">You can also press the physical Numpad+ key while an XSOAR incident is open. The draft will appear here.</p>
              <label class="field">Draft
                <textarea id="draft" class="control min-h-96 resize-y font-mono text-sm leading-6" rows="18" readOnly placeholder="The generated draft appears here." value={status()?.draft || ""} />
              </label>
              <button id="copy" class="button button-secondary mt-4" type="button" disabled={busy() || !status()?.draft} onClick={copyDraft}>Copy draft</button>
            </section>
          </div>
        )}
      </Show>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
