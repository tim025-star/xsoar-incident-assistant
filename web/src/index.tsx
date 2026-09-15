import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

import { activationHotkeyFromKeyboardEvent } from "../../src/hotkey.js";
import { rpc, sessionToken } from "./rpc";
import "./styles.css";

type AppConfig = Awaited<ReturnType<typeof rpc.config.get>>;
type Status = Awaited<ReturnType<typeof rpc.status>>;
type BrowserProfile = Awaited<ReturnType<typeof rpc.browser.profiles>>[number];
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
  const [browserProfiles, setBrowserProfiles] = createSignal<BrowserProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = createSignal("");
  const [recordingSeconds, setRecordingSeconds] = createSignal(0);
  let recordingInterval: number | undefined;
  let recordingTimeout: number | undefined;

  const updateMode = (value: string) => {
    if (value !== "current" && value !== "managed" && value !== "diagnostics") return;
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.session.mode = value;
      if (value === "current") next.session.browser = "chrome";
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
    const preferred = browserProfiles().find((profile) => profile.browser === value && profile.isDefault)
      || browserProfiles().find((profile) => profile.browser === value);
    setSelectedProfileId(preferred?.id || "");
  };

  const updateActivationHotkey = (value: AppConfig["session"]["activationHotkey"]) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.session.activationHotkey = value;
      return next;
    });
  };

  const updateProfileDirectory = (value: string) => {
    setConfig((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      next.session.profileDirectory = value;
      return next;
    });
  };

  const stopShortcutRecording = () => {
    if (recordingInterval !== undefined) window.clearInterval(recordingInterval);
    if (recordingTimeout !== undefined) window.clearTimeout(recordingTimeout);
    recordingInterval = undefined;
    recordingTimeout = undefined;
    setRecordingSeconds(0);
    window.removeEventListener("keydown", captureShortcut, true);
  };

  const captureShortcut = (event: KeyboardEvent) => {
    try {
      const hotkey = activationHotkeyFromKeyboardEvent(event);
      if (!hotkey) return;
      event.preventDefault();
      event.stopPropagation();
      updateActivationHotkey(hotkey);
      stopShortcutRecording();
      setMessage(`${hotkey.label} recorded. Save settings to activate it.`);
    } catch (error) {
      event.preventDefault();
      event.stopPropagation();
      setMessage(`${errorMessage(error)} Try another key before recording stops.`);
    }
  };

  const startShortcutRecording = () => {
    if (recordingSeconds()) {
      stopShortcutRecording();
      setMessage("Shortcut recording cancelled. Settings unchanged.");
      return;
    }
    const deadline = Date.now() + 5000;
    setRecordingSeconds(5);
    setMessage("Recording shortcut now. Press the key combination you want within five seconds.");
    window.addEventListener("keydown", captureShortcut, true);
    recordingInterval = window.setInterval(() => {
      setRecordingSeconds(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
    }, 200);
    recordingTimeout = window.setTimeout(() => {
      stopShortcutRecording();
      setMessage("No shortcut was detected within five seconds. Settings unchanged.");
    }, 5000);
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
    try {
      setConfig(await rpc.config.save(current));
    } catch (error) {
      const persisted = await rpc.config.get().catch(() => undefined);
      if (persisted) setConfig(persisted);
      throw error;
    }
  });

  const importSelectedProfile = () => runAction(async () => {
    const id = selectedProfileId();
    if (!id) throw new Error("Select an existing browser profile to import.");
    setConfig(await rpc.browser.importProfile({ id }));
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
      const [loadedConfig, loadedStatus, detectedProfiles] = await Promise.all([
        rpc.config.get(),
        rpc.status(),
        rpc.browser.profiles().catch(() => [] as BrowserProfile[])
      ]);
      setConfig(loadedConfig);
      setStatus(loadedStatus);
      setBrowserProfiles(detectedProfiles);
      const preferredProfile = detectedProfiles.find((profile) => (
        profile.browser === loadedConfig.session.browser && profile.isDefault
      )) || detectedProfiles.find((profile) => profile.browser === loadedConfig.session.browser)
        || detectedProfiles.find((profile) => profile.isDefault)
        || detectedProfiles[0];
      setSelectedProfileId(preferredProfile?.id || "");
      setMessage(loadedStatus.detail);
    } catch (error) {
      setMessage(errorMessage(error));
    }
    const interval = window.setInterval(() => refresh().catch(() => {}), 1500);
    onCleanup(() => window.clearInterval(interval));
  });
  onCleanup(stopShortcutRecording);

  return (
    <main class="mx-auto w-[min(1120px,calc(100%-2rem))] py-8 sm:py-12">
      <header class="mb-7 grid gap-5 border-b border-line pb-7 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p class="mb-2 text-xs font-bold tracking-[0.18em] text-brand">LOCAL PLAYWRIGHT TOOL</p>
          <h1 class="m-0 text-3xl font-bold tracking-tight sm:text-5xl">XSOAR Incident Assistant</h1>
          <p class="helper mt-3 max-w-3xl">Prepare a response draft from an incident in your current Chrome window or an isolated assistant browser.</p>
        </div>
        <div class="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-2 text-sm font-semibold">
          <span class={`h-2.5 w-2.5 rounded-full ${status()?.session.running ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" />
          {status()?.session.running ? "Browser connected" : config()?.session.mode === "current" ? "Chrome disconnected" : "Browser closed"}
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
                      <option value="current">Current Chrome window (recommended)</option>
                      <option value="managed">Managed profile</option>
                      <option value="diagnostics">Diagnostics with DevTools</option>
                    </select>
                  </label>
                  <label class="field">Browser
                    <select id="browser" class="control" disabled={settings().session.mode === "current"} value={settings().session.browser} onInput={(event) => updateBrowser(event.currentTarget.value)}>
                      <option value="edge">Microsoft Edge</option>
                      <option value="chrome">Google Chrome</option>
                    </select>
                  </label>
                  <div class="field sm:col-span-2" hidden={settings().session.mode === "current"}>
                    <span>Activation shortcut</span>
                    <div class="flex gap-2">
                      <input id="activationHotkey" class="control min-w-0" value={settings().session.activationHotkey.label} readOnly />
                      <button
                        id="recordHotkey"
                        class={`button shrink-0 ${recordingSeconds() ? "button-danger" : "button-secondary"}`}
                        type="button"
                        disabled={busy()}
                        aria-pressed={Boolean(recordingSeconds())}
                        onClick={startShortcutRecording}
                      >
                        {recordingSeconds() ? `Cancel (${recordingSeconds()}s)` : "Record shortcut"}
                      </button>
                    </div>
                  </div>
                </div>
                <Show when={settings().session.mode === "current"} fallback={<>
                  <label class="field mt-4">Dedicated browser profile directory
                    <input
                      id="profileDirectory"
                      class="control font-mono text-sm"
                      autocomplete="off"
                      spellcheck={false}
                      value={settings().session.profileDirectory}
                      onInput={(event) => updateProfileDirectory(event.currentTarget.value)}
                    />
                  </label>
                  <p class="helper mb-0">The default is the legacy Chrome <span class="font-mono">TSOC-Copilot</span> profile. You may enter another dedicated Chromium user-data directory, but normal Chrome and Edge profiles are blocked. Close any browser using the selected directory before opening it here.</p>
                  <div class="mt-4 rounded-xl border border-line bg-slate-50 p-4">
                  <p class="mb-3 font-bold">Use an existing browser sign-in</p>
                  <Show
                    when={browserProfiles().length}
                    fallback={<p class="helper m-0">No standard Edge or Chrome profiles were detected for this Windows account.</p>}
                  >
                    <div class="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                      <label class="field">Existing profile
                        <select
                          id="existingProfile"
                          class="control"
                          value={selectedProfileId()}
                          onInput={(event) => setSelectedProfileId(event.currentTarget.value)}
                        >
                          <For each={browserProfiles()}>{(profile) => (
                            <option value={profile.id}>
                              {profile.browserName} — {profile.name}{profile.isDefault ? " (Default)" : ""}
                            </option>
                          )}</For>
                        </select>
                      </label>
                      <button
                        id="importProfile"
                        class="button button-secondary"
                        type="button"
                        disabled={busy() || status()?.session.running || !selectedProfileId()}
                        onClick={importSelectedProfile}
                      >
                        Import profile
                      </button>
                    </div>
                    <p class="helper mb-0">Close the selected browser completely before importing. The assistant copies sign-in storage into its own isolated profile; it does not modify or control the original profile.</p>
                  </Show>
                  </div>
                  <p class="helper mb-0">Diagnostics mode opens Chromium DevTools in the Playwright-owned browser. It does not expose a remote-debugging network port.</p>
                  <p class="helper mb-0">Select Record shortcut and press any supported key combination within five seconds. Recording stops as soon as a shortcut is detected or when the five-second window expires. Save settings before opening the assistant browser. The shortcut works only while that browser is focused; no extension or plugin is installed.</p>
                </>}>
                  <div class="mt-4 rounded-xl border border-line bg-slate-50 p-4">
                    <p class="mb-2 font-bold">One-time Chrome setup</p>
                    <p class="helper my-0">Chrome 144 or newer is required. Open <span class="font-mono">chrome://inspect/#remote-debugging</span>, enable remote debugging, and accept Chrome's connection prompt. The assistant then uses this normal Chrome window and never launches another instance.</p>
                  </div>
                  <p class="helper mb-0">Current Chrome mode does not inject the activation shortcut into your everyday browser. Keep this assistant tab open and use Generate draft.</p>
                </Show>
                <Show when={settings().session.mode !== "current"}>
                  <p class="helper mb-0">The dedicated profile retains browser session data between runs, while your identity-provider policy controls reauthentication. Imported sign-in state may still require MFA or a fresh login.</p>
                </Show>
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
                <button id="open" class="button" type="button" disabled={busy() || status()?.session.running} onClick={() => runAction(() => rpc.browser.open())}>{settings().session.mode === "current" ? "Connect current Chrome" : "Open browser"}</button>
                <button id="run" class="button" type="button" disabled={busy()} onClick={() => runAction(() => rpc.draft.generate())}>Generate draft</button>
                <button id="stop" class="button button-secondary" type="button" disabled={busy() || !status()?.session.running} onClick={() => runAction(() => rpc.browser.stop())}>{settings().session.mode === "current" ? "Disconnect" : "Close browser"}</button>
              </div>
              <p class="helper mt-0">{settings().session.mode === "current" ? "Keep one XSOAR incident open in this Chrome window, then generate the draft here. Temporary child tabs are closed automatically." : "You can also press the configured activation shortcut while the assistant browser is focused on an XSOAR incident. The draft will appear here."}</p>
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
