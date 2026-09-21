import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { assertIncidentUrl, assertTrustedUrl } from "./domain.js";
import { extractIncidentFromPage, extractSearchResultsFromPage } from "./page-adapter.js";

const CHROME_SETUP_URL = "chrome://inspect/#remote-debugging";

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

  async openTab(url) {
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.settings.pageReadyTimeoutMs });
      return { id: page, url: page.url() };
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  async getTabUrl(page) {
    return page.url();
  }

  async extractIncident(page, settings) {
    return page.evaluate(extractIncidentFromPage, settings);
  }

  async extractSearchResults(page, options) {
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
