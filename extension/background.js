import {
  DEFAULT_SETTINGS,
  permissionPatternForOrigin,
  resolveSettings
} from "./domain.js";
import {
  extractIncidentFromPage,
  extractSearchResultsFromPage
} from "./page-adapter.js";
import { runIncidentDraft } from "./workflow.js";

const STATE_KEY = "assistantState";
let running = false;

async function loadRawSettings() {
  const stored = await chrome.storage.local.get("settings");
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...(stored.settings || {}),
    fieldLabels: {
      ...structuredClone(DEFAULT_SETTINGS.fieldLabels),
      ...(stored.settings?.fieldLabels || {})
    },
    template: {
      ...DEFAULT_SETTINGS.template,
      ...(stored.settings?.template || {})
    }
  };
}

async function saveState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {});
}

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return stored[STATE_KEY] || { status: "idle", detail: "Ready." };
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "The assistant failed.";
}

class ChromeBrowserAdapter {
  async getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.id || !tab.url) throw new Error("Open the XSOAR incident tab before generating a draft.");
    return { id: tab.id, url: tab.url, windowId: tab.windowId };
  }

  async openTab(url, options = {}) {
    const tab = await chrome.tabs.create({ url, active: options.active !== false });
    if (!tab.id) throw new Error("The browser did not create the XSOAR tab.");
    return { id: tab.id, url: tab.url || url, windowId: tab.windowId };
  }

  async waitUntilReady(tabId, timeoutMs) {
    const current = await chrome.tabs.get(tabId);
    if (current.status === "complete") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("The XSOAR page did not finish loading before the timeout."));
      }, timeoutMs);
      const listener = (updatedId, changeInfo) => {
        if (updatedId !== tabId || changeInfo.status !== "complete") return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  async getTabUrl(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) throw new Error("The browser did not expose the XSOAR tab URL.");
    return tab.url;
  }

  async extractIncident(tabId, settings) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractIncidentFromPage,
      args: [settings]
    });
    if (!results[0]?.result) throw new Error("The XSOAR incident page returned no readable fields.");
    return results[0].result;
  }

  async extractSearchResults(tabId, options) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractSearchResultsFromPage,
      args: [options]
    });
    if (!results[0]?.result) throw new Error("The XSOAR search page returned no result state.");
    return results[0].result;
  }

  async closeTab(tabId) {
    await chrome.tabs.remove(tabId);
  }

  async focusTab(tabId) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function runFromActiveTab() {
  if (running) return { ...(await getState()), detail: "A draft is already being prepared." };
  running = true;
  try {
    const settings = resolveSettings(await loadRawSettings());
    const permitted = await chrome.permissions.contains({
      origins: [permissionPatternForOrigin(settings.allowedOrigin)]
    });
    if (!permitted) {
      throw new Error("Open Settings and grant access to the configured XSOAR tenant first.");
    }
    await saveState({ status: "running", stage: "starting", detail: "Starting." });
    const result = await runIncidentDraft({
      adapter: new ChromeBrowserAdapter(),
      settings,
      onProgress: async (stage, detail) => saveState({ status: "running", stage, detail })
    });
    const state = {
      status: "complete",
      detail: result.warning || `Reviewed ${result.reviewed} of ${result.matches} matching incident(s).`,
      draft: result.draft,
      warning: result.warning
    };
    await saveState(state);
    return state;
  } catch (error) {
    const state = { status: "error", detail: publicError(error) };
    await saveState(state);
    return state;
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (reason === "install") await chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "run-assistant") return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]?.windowId) await chrome.sidePanel.open({ windowId: tabs[0].windowId });
  await runFromActiveTab();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return false;
  if (message.type === "GET_STATE") {
    getState().then(sendResponse);
    return true;
  }
  if (message.type === "GET_SETTINGS") {
    loadRawSettings().then(sendResponse);
    return true;
  }
  if (message.type === "RUN_ASSISTANT") {
    runFromActiveTab().then(sendResponse);
    return true;
  }
  if (message.type === "CLEAR_STATE") {
    chrome.storage.session.remove(STATE_KEY)
      .then(() => ({ status: "idle", detail: "Ready." }))
      .then(sendResponse);
    return true;
  }
  return false;
});
