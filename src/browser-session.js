import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { assertIncidentUrl, assertTrustedUrl } from "./domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "./page-adapter.js";

const CHROME_SETUP_URL = "chrome://inspect/#remote-debugging";
const HISTORIC_SEARCH_OBSERVATION_KEY = "__xsoarIncidentAssistantHistoricSearch";

function findIncidentQueryBar() {
  const selector = 'input:not([type]),input[type="text"],input[type="search"],textarea,[contenteditable="true"]';
  const results = document.querySelector("[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page");
  const incidentsPage = document.querySelector("#incidents-page,.incidents-page,.incidents-container");
  const workspace = results?.closest("main,[role='main']")
    || incidentsPage?.closest("main,[role='main']")
    || incidentsPage
    || document.querySelector("main,[role='main']");
  if (!workspace) return null;
  const candidates = [];
  for (const element of document.querySelectorAll(selector)) {
    if (!workspace.contains(element)
      || element.closest(".header-search,.r-header-actions-container,base-launcher-input-search-bar,xsoar-launcher-input-search-bar")) continue;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden"
      || !(element.offsetWidth || element.offsetHeight || element.getClientRects().length)) continue;
    const value = String(element.value ?? element.textContent ?? "").trim();
    const attributes = ["aria-label", "placeholder", "name", "class", "data-test-id", "data-testid"]
      .map((name) => element.getAttribute(name) || "").join(" ");
    const label = element.closest("label")?.textContent || "";
    let ancestorText = "";
    for (let ancestor = element.parentElement, depth = 0;
      ancestor && ancestor !== workspace && depth < 5;
      ancestor = ancestor.parentElement, depth += 1) {
      ancestorText += ` ${ancestor.className || ""} ${ancestor.getAttribute("data-test-id") || ""}`;
    }
    let score = 0;
    if (/query|search/i.test(attributes)) score += 8;
    if (/query|search/i.test(label)) score += 5;
    if (/query|search|filter/i.test(ancestorText)) score += 5;
    if (/(?:^|\s)-?(?:status|category|type|rawname|rawtype|created)\s*:/i.test(value)) score += 10;
    if (element.matches("textarea,[contenteditable='true']")) score += 2;
    if (/react-select|dropdown|date|picker/i.test(`${attributes} ${ancestorText}`)) score -= 10;
    candidates.push({ element, score });
  }
  candidates.sort((left, right) => right.score - left.score);
  if (!candidates.length || candidates[0].score < 5
    || (candidates[1] && candidates[1].score === candidates[0].score)) return null;
  return candidates[0].element;
}

export async function submitHistoricSearch(page, options) {
  const expectedQuery = String(options.expectedQuery || "").trim();
  if (!expectedQuery) throw new Error("A historic incident query is required.");
  const currentUrl = new URL(page.url());
  const normalizePath = (value) => value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (currentUrl.origin !== options.expectedOrigin
    || normalizePath(currentUrl.pathname) !== normalizePath(options.expectedPath)
    || currentUrl.hash
    || [...currentUrl.searchParams.values()].some((value) => String(value).trim())) {
    throw new Error("Historic search refused to interact with a page outside the configured incidents page.");
  }
  const timeout = Math.min(Math.max(Number(options.timeoutMs) || 20000, 1000), 120000);
  let input;
  try {
    const handle = await page.waitForFunction(findIncidentQueryBar, undefined, { timeout });
    input = handle.asElement();
    if (!input) throw new Error("The incidents query bar was not an editable element.");
  } catch (error) {
    throw new Error("XSOAR's incidents-page query bar did not become ready before the timeout.", { cause: error });
  }
  await input.fill(expectedQuery);
  await page.evaluate(({ observationKey }) => {
    window[observationKey]?.observer?.disconnect();
    const resultSelector = "[role='grid'][aria-rowcount],.fixedDataTableLayout_main,#incidents-page";
    const results = document.querySelector(resultSelector);
    const target = results?.parentElement || document.body;
    const state = { changed: false, observer: null };
    const observer = new MutationObserver((records) => {
      const currentResults = document.querySelector(resultSelector);
      state.changed ||= records.some((record) => {
        if (currentResults && (record.target === currentResults || currentResults.contains(record.target))) return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE
          && (node === currentResults || node.matches?.(resultSelector) || node.querySelector?.(resultSelector)));
      });
    });
    observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
    state.observer = observer;
    window[observationKey] = state;
  }, { observationKey: HISTORIC_SEARCH_OBSERVATION_KEY });
  await input.press("Enter");
  try {
    await page.waitForFunction(
      ({ expectedOrigin, expectedPath, expectedQuery: query, observationKey, queryBar }) => {
        const current = new URL(window.location.href);
        const observation = window[observationKey];
        const normalizedPath = (value) => value.length > 1 ? value.replace(/\/+$/, "") : value;
        const queryValue = "value" in queryBar ? queryBar.value : queryBar.textContent;
        return current.origin === expectedOrigin
          && normalizedPath(current.pathname) === normalizedPath(expectedPath)
          && queryBar.isConnected
          && String(queryValue || "").trim() === query
          && Boolean(observation?.changed);
      },
      {
        expectedOrigin: options.expectedOrigin,
        expectedPath: options.expectedPath,
        expectedQuery,
        observationKey: HISTORIC_SEARCH_OBSERVATION_KEY,
        queryBar: input
      },
      { timeout }
    );
  } catch (error) {
    throw new Error("XSOAR did not confirm the historic query in the incidents page.", { cause: error });
  } finally {
    await page.evaluate(({ observationKey }) => {
      window[observationKey]?.observer?.disconnect();
      delete window[observationKey];
    }, { observationKey: HISTORIC_SEARCH_OBSERVATION_KEY }).catch(() => {});
  }
}

function chromeExecutableCandidates() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean);
  const suffix = ["Google", "Chrome", "Application", "chrome.exe"];
  return roots.map((root) => path.join(root, ...suffix));
}

function findChromeExecutable() {
  const executable = chromeExecutableCandidates().find(existsSync);
  if (!executable) throw new Error("Google Chrome was not found.");
  return executable;
}

export function openNormalChromePage(url, { spawnProcess = spawn } = {}) {
  const child = spawnProcess(findChromeExecutable(), [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function standardChromeUserDataDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Google", "Chrome", "User Data");
}

const DEVTOOLS_BROWSER_PATH = /^\/devtools\/browser\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readDevToolsWebSocketEndpoint(userDataDirectory, { read = readFile } = {}) {
  let value;
  try {
    value = await read(path.join(path.resolve(userDataDirectory), "DevToolsActivePort"), "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw new Error(
        "Enable remote debugging in Chrome at chrome://inspect/#remote-debugging, accept Chrome's prompt, then try again. Chrome 144 or newer is required."
      );
    }
    throw error;
  }
  const [rawPort, browserPath, ...extra] = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const port = Number(rawPort);
  if (extra.length || !/^\d+$/.test(rawPort || "") || !Number.isInteger(port) || port < 1 || port > 65535 || !DEVTOOLS_BROWSER_PATH.test(browserPath || "")) {
    throw new Error("Chrome did not provide a valid browser endpoint. Disable and re-enable remote debugging, then try again.");
  }
  return `ws://127.0.0.1:${port}${browserPath}`;
}

class PlaywrightBrowserAdapter {
  constructor(context, settings) {
    this.context = context;
    this.settings = settings;
  }

  async getActiveTab() {
    const candidates = this.context.pages().filter((page) => {
      try {
        assertIncidentUrl(page.url(), this.settings, "Browser tab");
        return true;
      } catch {
        return false;
      }
    });
    if (!candidates.length) throw new Error("Enter an Incident ID or open one XSOAR incident in the connected Chrome session.");
    const focused = [];
    for (const page of candidates) {
      if (await page.evaluate(() => document.hasFocus()).catch(() => false)) focused.push(page);
    }
    if (focused.length === 1) return { id: focused[0], url: focused[0].url() };
    if (candidates.length === 1) return { id: candidates[0], url: candidates[0].url() };
    throw new Error("Multiple XSOAR incidents are open. Enter the Incident ID you want to triage.");
  }

  async openTab(url, { focusBeforeNavigation = false } = {}) {
    const page = await this.context.newPage();
    try {
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            assertTrustedUrl(request.url(), this.settings, "Automated navigation");
          } catch {
            return route.abort("blockedbyclient");
          }
        }
        return route.continue();
      });
      if (focusBeforeNavigation) await page.bringToFront();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.settings.pageReadyTimeoutMs });
      return { id: page, url: page.url() };
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async reloadTab(page, url, { focusBeforeNavigation = false } = {}) {
    assertTrustedUrl(url, this.settings, "Automated retry navigation");
    if (page.isClosed()) throw new Error("The historic incident tab closed before it could be retried.");
    if (focusBeforeNavigation) await page.bringToFront();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.settings.pageReadyTimeoutMs });
  }

  async getTabUrl(page) {
    return page.url();
  }

  async extractIncident(page, settings) {
    return page.evaluate(extractIncidentFromPage, settings);
  }

  async extractSearchResults(page, options) {
    await submitHistoricSearch(page, {
      ...options,
      expectedOrigin: this.settings.allowedOrigin,
      expectedPath: new URL(this.settings.incidentsPath, this.settings.allowedOrigin).pathname,
      queryParameter: this.settings.searchQueryParameter
    });
    return page.evaluate(extractSearchResultsFromPage, {
      ...options,
      expectedOrigin: this.settings.allowedOrigin,
      expectedPath: new URL(this.settings.incidentsPath, this.settings.allowedOrigin).pathname,
      queryParameter: this.settings.searchQueryParameter,
      incidentUrlPattern: this.settings.incidentUrlPattern
    });
  }

  async closeTab(page) {
    if (!page.isClosed()) await page.close();
  }

  async focusTab(page) {
    if (!page.isClosed()) await page.bringToFront();
  }
}

export class BrowserSessionManager {
  constructor({
    chromiumApi = chromium,
    currentChromeEndpoint = () => readDevToolsWebSocketEndpoint(standardChromeUserDataDirectory()),
    openChromePage = openNormalChromePage
  } = {}) {
    this.chromium = chromiumApi;
    this.currentChromeEndpoint = currentChromeEndpoint;
    this.openChromePage = openChromePage;
    this.context = null;
    this.browser = null;
    this.consoleUrl = "";
  }

  status() {
    return { running: Boolean(this.context) };
  }

  openSetup() {
    this.openChromePage(CHROME_SETUP_URL);
  }

  setConsoleUrl(url) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || !parsed.hash.slice(1)
    ) {
      throw new Error("The local console URL must use the loopback home page.");
    }
    this.consoleUrl = parsed.href;
  }

  async showConsole() {
    if (!this.context || !this.consoleUrl) return false;
    const expected = new URL(this.consoleUrl);
    let existing;
    for (const page of this.context.pages()) {
      try {
        const current = new URL(page.url());
        if (current.origin !== expected.origin || current.pathname !== expected.pathname) continue;
        const authenticated = await page.evaluate(
          (token) => sessionStorage.getItem("assistant-session-token") === token,
          expected.hash.slice(1)
        );
        if (authenticated) {
          existing = page;
          break;
        }
      } catch {
        continue;
      }
    }
    if (existing) {
      await existing.bringToFront();
      return true;
    }

    const page = await this.context.newPage();
    try {
      await page.goto(this.consoleUrl, { waitUntil: "domcontentloaded", timeout: 5000 });
      await page.bringToFront();
      return true;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async start() {
    if (this.context) return this.context;
    const endpoint = await this.currentChromeEndpoint();
    let browser;
    try {
      browser = await this.chromium.connectOverCDP(endpoint);
    } catch (error) {
      throw new Error(
        "Could not connect to Chrome. Open Chrome access setup, enable remote debugging, and approve Chrome's prompt.",
        { cause: error }
      );
    }
    const contexts = browser.contexts();
    if (!contexts.length) {
      await browser.close().catch(() => {});
      throw new Error("Chrome did not expose the approved browser session.");
    }
    this.browser = browser;
    this.context = contexts[0];
    browser.once("disconnected", () => {
      if (this.browser !== browser) return;
      this.context = null;
      this.browser = null;
    });
    return this.context;
  }

  adapter(settings) {
    if (!this.context) throw new Error("Connect Chrome before starting triage.");
    return new PlaywrightBrowserAdapter(this.context, settings);
  }

  async stop() {
    const context = this.context;
    const browser = this.browser;
    await browser?.close();
    if (this.context !== context) return;
    this.context = null;
    this.browser = null;
  }
}
